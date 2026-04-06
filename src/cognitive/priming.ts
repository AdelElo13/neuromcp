import type Database from 'better-sqlite3';

/**
 * Priming: recently accessed memories boost related memories.
 *
 * When a memory is accessed (via search or recall), its "activation" spreads
 * to connected memories through the knowledge graph and semantic similarity.
 *
 * Returns a map of memory_id -> priming_boost (0 to primingBoost).
 */
export function computePrimingBoosts(
  db: Database.Database,
  recentlyAccessedIds: readonly string[],
  primingBoost: number,
): Map<string, number> {
  const boosts = new Map<string, number>();

  if (recentlyAccessedIds.length === 0) return boosts;

  for (const memoryId of recentlyAccessedIds) {
    // 1. Find entities linked to recently accessed memory
    const linkedEntities = db
      .prepare(
        'SELECT entity_id FROM memory_entities WHERE memory_id = ?',
      )
      .all(memoryId) as Array<{ entity_id: string }>;

    // 2. Find other memories linked to those same entities
    for (const { entity_id } of linkedEntities) {
      const relatedMemories = db
        .prepare(
          `SELECT me.memory_id FROM memory_entities me
           JOIN memories m ON m.id = me.memory_id
           WHERE me.entity_id = ? AND me.memory_id != ? AND m.is_deleted = 0`,
        )
        .all(entity_id, memoryId) as Array<{ memory_id: string }>;

      for (const { memory_id } of relatedMemories) {
        const current = boosts.get(memory_id) ?? 0;
        // Each shared entity connection adds a fraction of the boost
        // Multiple shared entities compound (capped at primingBoost)
        const increment = primingBoost / Math.max(linkedEntities.length, 1);
        boosts.set(memory_id, Math.min(current + increment, primingBoost));
      }
    }

    // 3. Also prime via graph relations (1-hop from linked entities)
    for (const { entity_id } of linkedEntities) {
      const relatedEntities = db
        .prepare(
          `SELECT CASE
             WHEN source_entity_id = ? THEN target_entity_id
             ELSE source_entity_id
           END as neighbor_id,
           weight
           FROM relations
           WHERE (source_entity_id = ? OR target_entity_id = ?)
             AND is_deleted = 0`,
        )
        .all(entity_id, entity_id, entity_id) as Array<{ neighbor_id: string; weight: number }>;

      for (const { neighbor_id, weight } of relatedEntities) {
        const neighborMemories = db
          .prepare(
            `SELECT me.memory_id FROM memory_entities me
             JOIN memories m ON m.id = me.memory_id
             WHERE me.entity_id = ? AND m.is_deleted = 0`,
          )
          .all(neighbor_id) as Array<{ memory_id: string }>;

        for (const { memory_id } of neighborMemories) {
          if (memory_id === memoryId) continue;
          const current = boosts.get(memory_id) ?? 0;
          // Graph-mediated priming is weaker (scaled by relation weight and halved)
          const increment = (primingBoost * weight * 0.5) / Math.max(linkedEntities.length, 1);
          boosts.set(memory_id, Math.min(current + increment, primingBoost));
        }
      }
    }
  }

  return boosts;
}

/**
 * Get recently accessed memory IDs (last N minutes).
 * Used to seed priming computations.
 */
export function getRecentlyAccessed(
  db: Database.Database,
  minutesAgo: number = 30,
  limit: number = 10,
): readonly string[] {
  const cutoff = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const rows = db
    .prepare(
      `SELECT id FROM memories
       WHERE is_deleted = 0
         AND last_accessed_at IS NOT NULL
         AND last_accessed_at > ?
       ORDER BY last_accessed_at DESC
       LIMIT ?`,
    )
    .all(cutoff, limit) as Array<{ id: string }>;

  return rows.map((r) => r.id);
}
