import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { Memory, ProposedMerge } from '../types.js';
import { isHigherTrust } from '../governance/trust.js';
import type { TrustLevel } from '../types.js';

/**
 * Scans all active memories in a namespace and finds pairs whose cosine
 * similarity exceeds `threshold`. For each pair, determines which to keep
 * (higher trust, then longer content) and produces a merge proposal.
 */
export function findDuplicates(
  db: Database.Database,
  vecStore: VectorStore,
  namespace: string,
  threshold: number,
): readonly ProposedMerge[] {
  const isAll = namespace === '*';
  const nsClause = isAll ? '1=1' : 'namespace = ?';
  const nsParams = isAll ? [] : [namespace];

  const rows = db
    .prepare(
      `SELECT id, content, tags, importance, source_trust FROM memories WHERE is_deleted = 0 AND ${nsClause}`,
    )
    .all(...nsParams) as Array<{
    id: string;
    content: string;
    tags: string;
    importance: number;
    source_trust: string;
  }>;

  // Track already-proposed tombstone ids to avoid proposing a memory for multiple merges
  const alreadyMerged = new Set<string>();
  const merges: ProposedMerge[] = [];

  for (const row of rows) {
    if (alreadyMerged.has(row.id)) continue;

    // Search for neighbors via the vector store using the memory's own embedding
    // We re-fetch the embedding from the vec store by doing a search with the memory's content
    // Instead, use vec search — find nearest neighbors for this memory's embedding
    // Since we don't have the embedding directly, we search from vec store using a trick:
    // search for neighbors of this id by finding its vector. But VectorStore API doesn't expose
    // getById. So we do pairwise comparison from the vector search results.

    // Actually, the VectorStore.search requires a Float32Array query. We don't have
    // the raw embedding. For correctness, we need to get the embedding from the vec table.
    // Let's read it directly from the virtual table.
    const vecRow = db
      .prepare('SELECT embedding FROM memories_vec WHERE id = ?')
      .get(row.id) as { embedding: Buffer } | undefined;

    if (vecRow === undefined) continue;

    const embedding = new Float32Array(
      vecRow.embedding.buffer,
      vecRow.embedding.byteOffset,
      vecRow.embedding.byteLength / 4,
    );

    const neighbors = vecStore.search(embedding, 10);

    for (const neighbor of neighbors) {
      if (neighbor.id === row.id) continue;
      if (alreadyMerged.has(neighbor.id)) continue;

      const similarity = 1 - neighbor.distance;
      if (similarity <= threshold) continue;

      // Verify the neighbor is active and in the same namespace
      const neighborRow = db
        .prepare(
          'SELECT id, content, tags, importance, source_trust FROM memories WHERE id = ? AND is_deleted = 0',
        )
        .get(neighbor.id) as
        | {
            id: string;
            content: string;
            tags: string;
            importance: number;
            source_trust: string;
          }
        | undefined;

      if (neighborRow === undefined) continue;

      // If namespace-specific, verify the neighbor is in the same namespace
      if (!isAll) {
        const nsCheck = db
          .prepare('SELECT namespace FROM memories WHERE id = ?')
          .get(neighbor.id) as { namespace: string } | undefined;
        if (nsCheck === undefined || nsCheck.namespace !== namespace) continue;
      }

      // Decide which to keep
      const { keepId, tombstoneId, keepRow: winner, loseRow: loser } = pickWinner(
        row,
        neighborRow,
      );

      // Merge tags (union)
      const keepTags: string[] = JSON.parse(winner.tags);
      const loseTags: string[] = JSON.parse(loser.tags);
      const mergedTags = [...new Set([...keepTags, ...loseTags])];

      // Max importance
      const mergedImportance = Math.max(winner.importance, loser.importance);

      merges.push({
        keep_id: keepId,
        tombstone_id: tombstoneId,
        similarity,
        merged_tags: mergedTags,
        merged_importance: mergedImportance,
        reason: `cosine similarity ${similarity.toFixed(3)} exceeds threshold ${threshold}`,
      });

      alreadyMerged.add(tombstoneId);
    }
  }

  return merges;
}

function pickWinner(
  a: { id: string; content: string; tags: string; importance: number; source_trust: string },
  b: { id: string; content: string; tags: string; importance: number; source_trust: string },
): {
  keepId: string;
  tombstoneId: string;
  keepRow: typeof a;
  loseRow: typeof b;
} {
  // Higher trust wins
  if (isHigherTrust(a.source_trust as TrustLevel, b.source_trust as TrustLevel)) {
    return { keepId: a.id, tombstoneId: b.id, keepRow: a, loseRow: b };
  }
  if (isHigherTrust(b.source_trust as TrustLevel, a.source_trust as TrustLevel)) {
    return { keepId: b.id, tombstoneId: a.id, keepRow: b, loseRow: a };
  }

  // Equal trust: keep longer content
  if (a.content.length >= b.content.length) {
    return { keepId: a.id, tombstoneId: b.id, keepRow: a, loseRow: b };
  }
  return { keepId: b.id, tombstoneId: a.id, keepRow: b, loseRow: a };
}
