import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';

/**
 * Compute surprise score for new content.
 *
 * Surprise = how unexpected this information is relative to existing knowledge.
 * High similarity to existing memories = low surprise (redundant).
 * Low similarity = high surprise (novel information).
 *
 * Formula: surprise = 1 - max_similarity_to_existing
 * Range: 0 (completely expected) to 1 (completely novel)
 */
export async function computeSurprise(
  content: string,
  namespace: string,
  db: Database.Database,
  vecStore: VectorStore,
  embedder: EmbeddingProvider,
): Promise<number> {
  const embedding = await embedder.embed(content);

  // Search for nearest neighbors. v0.29 Fase 1B (Codex [MEDIUM], same bug
  // family): push the namespace into the vec query so other namespaces cannot
  // fill the top-k and skew the surprise score. '*' → undefined (all).
  const scopedNamespace = namespace === '*' ? undefined : namespace;
  const neighbors = vecStore.search(embedding, 5, scopedNamespace);

  if (neighbors.length === 0) {
    // No existing memories — maximum surprise
    return 1.0;
  }

  // Filter to same namespace and active memories
  let maxSimilarity = 0;
  for (const neighbor of neighbors) {
    const row = db
      .prepare('SELECT namespace, is_deleted FROM memories WHERE id = ? LIMIT 1')
      .get(neighbor.id) as { namespace: string; is_deleted: number } | undefined;

    if (row === undefined || row.is_deleted === 1) continue;
    if (namespace !== '*' && row.namespace !== namespace) continue;

    const similarity = 1 - neighbor.distance;
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
    }
  }

  // Surprise is inverse of max similarity
  // Apply a non-linear transform to make moderate novelty more distinguishable
  const rawSurprise = 1 - maxSimilarity;

  // Sigmoid-like scaling: amplify mid-range surprise, compress extremes
  // s(x) = x^0.7 — slightly compresses high values, amplifies low-mid
  return Math.pow(rawSurprise, 0.7);
}

/**
 * Decay surprise score over time.
 * Old surprises become less surprising as the knowledge base evolves.
 *
 * Formula: decayed = surprise * exp(-t / decayDays)
 */
export function decaySurprise(
  currentSurprise: number,
  daysSinceCreation: number,
  decayDays: number,
): number {
  return currentSurprise * Math.exp(-daysSinceCreation / decayDays);
}
