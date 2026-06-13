import type Database from 'better-sqlite3';

export interface ImportanceFactors {
  readonly base: number;
  readonly access_boost: number;
  readonly recency_boost: number;
  readonly centrality_boost: number;
  readonly adjusted: number;
}

/**
 * Adaptive importance scoring.
 *
 * Formula:
 *   adjusted = base_importance
 *            + access_boost * log(1 + access_count)
 *            + recency_boost * exp(-days_since_access / 7)
 *            + centrality_boost * entity_centrality
 *
 * This replaces simple exponential decay with a model that:
 * - Rewards frequently accessed memories (access_count)
 * - Boosts recently relevant memories (recency)
 * - Boosts memories connected to central entities (graph centrality)
 * - Still allows importance to decay naturally if unused
 */
export function computeAdaptiveImportance(
  db: Database.Database,
  memoryId: string,
  config: { accessBoost?: number; recencyBoost?: number; centralityBoost?: number } = {},
): ImportanceFactors {
  const accessBoost = config.accessBoost ?? 0.05;
  const recencyBoost = config.recencyBoost ?? 0.1;
  const centralityBoost = config.centralityBoost ?? 0.15;

  const memory = db.prepare(
    'SELECT importance, access_count, last_accessed_at, created_at FROM memories WHERE id = ?'
  ).get(memoryId) as { importance: number; access_count: number; last_accessed_at: string | null; created_at: string } | undefined;

  if (!memory) {
    return { base: 0, access_boost: 0, recency_boost: 0, centrality_boost: 0, adjusted: 0 };
  }

  const base = memory.importance;

  // Access frequency boost: log(1 + count) * weight
  const accessComponent = accessBoost * Math.log(1 + memory.access_count);

  // Recency boost: exp(-days/7) * weight
  const lastAccess = memory.last_accessed_at ?? memory.created_at;
  const daysSinceAccess = (Date.now() - new Date(lastAccess).getTime()) / (1000 * 60 * 60 * 24);
  const recencyComponent = recencyBoost * Math.exp(-daysSinceAccess / 7);

  // Centrality boost: average centrality of connected entities
  const entityCentralities = db.prepare(`
    SELECT json_extract(e.metadata, '$.centrality') as centrality
    FROM memory_entities me
    JOIN entities e ON e.id = me.entity_id
    WHERE me.memory_id = ? AND e.is_deleted = 0
  `).all(memoryId) as Array<{ centrality: number | null }>;

  let avgCentrality = 0;
  const validCentralities = entityCentralities.filter(e => e.centrality !== null);
  if (validCentralities.length > 0) {
    avgCentrality = validCentralities.reduce((sum, e) => sum + (e.centrality ?? 0), 0) / validCentralities.length;
  }
  const centralityComponent = centralityBoost * avgCentrality;

  // Combine, clamped to [0, 1]
  const adjusted = Math.min(1, Math.max(0, base + accessComponent + recencyComponent + centralityComponent));

  return {
    base,
    access_boost: accessComponent,
    recency_boost: recencyComponent,
    centrality_boost: centralityComponent,
    adjusted,
  };
}

/**
 * Batch update adaptive importance for all memories in a namespace.
 * Used during consolidation to keep importance scores fresh.
 */
export function updateAdaptiveImportance(
  db: Database.Database,
  namespace: string,
  config: { accessBoost?: number; recencyBoost?: number; centralityBoost?: number } = {},
): { updated: number; avg_delta: number } {
  const memories = db.prepare(
    'SELECT id FROM memories WHERE namespace = ? AND is_deleted = 0'
  ).all(namespace) as Array<{ id: string }>;

  // Writes effective_importance, never the user-supplied importance column.
  // computeAdaptiveImportance derives from the immutable user base, so
  // repeated runs are idempotent — the pre-v14 version wrote back into its
  // own input and ratcheted importance upward on every consolidation run.
  const updateStmt = db.prepare('UPDATE memories SET effective_importance = ? WHERE id = ?');
  let totalDelta = 0;
  let updated = 0;

  const transaction = db.transaction(() => {
    for (const mem of memories) {
      const factors = computeAdaptiveImportance(db, mem.id, config);
      const old = db
        .prepare('SELECT COALESCE(effective_importance, importance) AS eff FROM memories WHERE id = ?')
        .get(mem.id) as { eff: number };
      const delta = Math.abs(factors.adjusted - old.eff);

      if (delta > 0.001) { // Only update if meaningful change
        updateStmt.run(factors.adjusted, mem.id);
        totalDelta += delta;
        updated++;
      }
    }
  });

  transaction();

  return {
    updated,
    avg_delta: updated > 0 ? totalDelta / updated : 0,
  };
}
