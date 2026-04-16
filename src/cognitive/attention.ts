/**
 * Attention-based memory retrieval — inspired by Kimi AI's Attention Residuals.
 *
 * Instead of treating all memories with fixed importance, this module learns
 * which memories are co-retrieved together and uses those patterns to boost
 * related memories during search.
 *
 * Analogy to AttnRes:
 * - AttnRes: softmax attention over preceding layer outputs
 * - This: softmax-weighted co-retrieval scores over candidate memories
 *
 * No ML training needed — patterns emerge from usage data.
 */

import type Database from 'better-sqlite3';

// ─── Schema ──────────────────────────────────────────────────────────

export const CO_RETRIEVAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS co_retrievals (
  memory_a TEXT NOT NULL,
  memory_b TEXT NOT NULL,
  co_count INTEGER NOT NULL DEFAULT 1,
  last_co_retrieved_at TEXT NOT NULL,
  PRIMARY KEY (memory_a, memory_b)
);

CREATE INDEX IF NOT EXISTS idx_co_retrievals_a ON co_retrievals(memory_a);
CREATE INDEX IF NOT EXISTS idx_co_retrievals_b ON co_retrievals(memory_b);
`;

// ─── Co-Retrieval Tracking ───────────────────────────────────────────

/**
 * Record that a set of memories were retrieved together in a single search.
 */
export function recordCoRetrieval(
  db: Database.Database,
  memoryIds: readonly string[],
): void {
  if (memoryIds.length < 2) return;

  const upsert = db.prepare(`
    INSERT INTO co_retrievals (memory_a, memory_b, co_count, last_co_retrieved_at)
    VALUES (?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(memory_a, memory_b)
    DO UPDATE SET
      co_count = co_count + 1,
      last_co_retrieved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `);

  const transaction = db.transaction(() => {
    for (let i = 0; i < memoryIds.length; i++) {
      for (let j = i + 1; j < memoryIds.length; j++) {
        const [a, b] =
          memoryIds[i] < memoryIds[j]
            ? [memoryIds[i], memoryIds[j]]
            : [memoryIds[j], memoryIds[i]];
        upsert.run(a, b);
      }
    }
  });

  transaction();
}

// ─── Attention Scoring ───────────────────────────────────────────────

interface CoRetrievalEntry {
  readonly partner_id: string;
  readonly co_count: number;
}

function getCoRetrievalPartners(
  db: Database.Database,
  memoryId: string,
  limit: number = 20,
): readonly CoRetrievalEntry[] {
  return db.prepare(`
    SELECT
      CASE WHEN memory_a = ? THEN memory_b ELSE memory_a END AS partner_id,
      co_count
    FROM co_retrievals
    WHERE memory_a = ? OR memory_b = ?
    ORDER BY co_count DESC
    LIMIT ?
  `).all(memoryId, memoryId, memoryId, limit) as CoRetrievalEntry[];
}

/**
 * Cross-memory attention: for each candidate, compute how strongly it
 * co-occurs with OTHER high-scoring candidates.
 *
 *   attention_score(m) = sum( softmax(co_count(m, c)) * base_score(c) )
 *                        for all candidates c != m
 */
export function computeAttentionScores(
  db: Database.Database,
  candidates: readonly { readonly id: string; readonly score: number }[],
  config: { attentionWeight?: number } = {},
): Map<string, number> {
  const weight = config.attentionWeight ?? 0.004;
  const scores = new Map<string, number>();

  if (candidates.length < 2) return scores;

  const candidateIds = new Set(candidates.map((c) => c.id));
  const candidateScoreMap = new Map(candidates.map((c) => [c.id, c.score]));

  for (const candidate of candidates) {
    const partners = getCoRetrievalPartners(db, candidate.id, 30);
    const relevantPartners = partners.filter((p) => candidateIds.has(p.partner_id));

    if (relevantPartners.length === 0) {
      scores.set(candidate.id, 0);
      continue;
    }

    // Softmax over co-retrieval counts
    const temperature = 2.0;
    const logits = relevantPartners.map((p) => Math.log(1 + p.co_count) / temperature);
    const maxLogit = Math.max(...logits);
    const expLogits = logits.map((l) => Math.exp(l - maxLogit));
    const sumExp = expLogits.reduce((a, b) => a + b, 0);
    const attentionWeights = expLogits.map((e) => e / sumExp);

    let attentionScore = 0;
    for (let i = 0; i < relevantPartners.length; i++) {
      const partnerScore = candidateScoreMap.get(relevantPartners[i].partner_id) ?? 0;
      attentionScore += attentionWeights[i] * partnerScore;
    }

    scores.set(candidate.id, attentionScore * weight);
  }

  return scores;
}

// ─── Block Attention ─────────────────────────────────────────────────

/**
 * Cluster-level attention: memories in high-scoring clusters get boosted.
 * Analogous to Block AttnRes.
 */
export function computeBlockAttentionScores(
  db: Database.Database,
  candidates: readonly { readonly id: string; readonly score: number }[],
  config: { blockWeight?: number } = {},
): Map<string, number> {
  const weight = config.blockWeight ?? 0.003;
  const scores = new Map<string, number>();

  if (candidates.length < 2) return scores;

  const clusterMap = new Map<string | null, Array<{ id: string; score: number }>>();
  for (const c of candidates) {
    const row = db.prepare(
      'SELECT cluster_id FROM memories WHERE id = ?'
    ).get(c.id) as { cluster_id: string | null } | undefined;

    const clusterId = row?.cluster_id ?? null;
    if (!clusterMap.has(clusterId)) clusterMap.set(clusterId, []);
    clusterMap.get(clusterId)!.push({ id: c.id, score: c.score });
  }

  const clusterScores = new Map<string | null, number>();
  for (const [clusterId, members] of clusterMap) {
    if (clusterId === null) continue;
    const avgScore = members.reduce((sum, m) => sum + m.score, 0) / members.length;
    clusterScores.set(clusterId, avgScore);
  }

  const allClusterScores = [...clusterScores.values()];
  if (allClusterScores.length === 0) return scores;
  const maxCluster = Math.max(...allClusterScores);
  if (maxCluster === 0) return scores;

  for (const c of candidates) {
    const row = db.prepare(
      'SELECT cluster_id FROM memories WHERE id = ?'
    ).get(c.id) as { cluster_id: string | null } | undefined;

    const clusterId = row?.cluster_id ?? null;
    if (clusterId === null) {
      scores.set(c.id, 0);
      continue;
    }
    const normalized = (clusterScores.get(clusterId) ?? 0) / maxCluster;
    scores.set(c.id, normalized * weight);
  }

  return scores;
}

// ─── Stats ───────────────────────────────────────────────────────────

export interface AttentionStats {
  readonly total_co_retrievals: number;
  readonly unique_pairs: number;
  readonly avg_co_count: number;
  readonly max_co_count: number;
}

export function getAttentionStats(db: Database.Database): AttentionStats {
  return db.prepare(`
    SELECT
      COALESCE(SUM(co_count), 0) as total_co_retrievals,
      COUNT(*) as unique_pairs,
      COALESCE(AVG(co_count), 0) as avg_co_count,
      COALESCE(MAX(co_count), 0) as max_co_count
    FROM co_retrievals
  `).get() as AttentionStats;
}
