import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../embeddings/types.js';

export interface SummaryResult {
  readonly summary: string;
  readonly source_ids: readonly string[];
  readonly representative_sentences: readonly string[];
}

/**
 * Extractive summarization — no LLM needed.
 *
 * Algorithm:
 * 1. Split all memory contents into sentences
 * 2. Embed each sentence
 * 3. Compute centroid (mean embedding of all sentences)
 * 4. Rank sentences by cosine similarity to centroid (centrality)
 * 5. Select top-k most central sentences, deduplicated
 * 6. Order selected sentences chronologically
 */
export async function summarizeMemories(
  db: Database.Database,
  embedder: EmbeddingProvider,
  memoryIds: readonly string[],
  options: { maxSentences?: number; maxLength?: number } = {},
): Promise<SummaryResult> {
  const maxSentences = options.maxSentences ?? 5;
  const maxLength = options.maxLength ?? 500;

  // Fetch memories
  const placeholders = memoryIds.map(() => '?').join(',');
  const memories = db.prepare(
    `SELECT id, content, importance, created_at FROM memories
     WHERE id IN (${placeholders}) AND is_deleted = 0
     ORDER BY created_at ASC`
  ).all(...memoryIds) as Array<{ id: string; content: string; importance: number; created_at: string }>;

  if (memories.length === 0) {
    return { summary: '', source_ids: [], representative_sentences: [] };
  }

  // Split into sentences with source tracking
  const sentences: Array<{ text: string; memoryId: string; importance: number; created_at: string }> = [];
  for (const mem of memories) {
    const parts = mem.content
      .split(/(?<=[.!?\n])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 15 && !s.startsWith('[session') && !s.startsWith('[meta]'));

    for (const text of parts) {
      sentences.push({ text, memoryId: mem.id, importance: mem.importance, created_at: mem.created_at });
    }
  }

  if (sentences.length === 0) {
    // Fallback: use first sentence of each memory
    const fallback = memories
      .map(m => m.content.split(/[.!?\n]/)[0]?.trim())
      .filter((s): s is string => !!s && s.length > 5)
      .slice(0, maxSentences)
      .join('. ');
    return { summary: fallback, source_ids: memories.map(m => m.id), representative_sentences: [fallback] };
  }

  // Embed all sentences
  const texts = sentences.map(s => s.text);
  const embeddings = await embedder.embedBatch(texts);

  // Compute centroid
  const dim = embedder.dimensions;
  const centroid = new Float32Array(dim);
  for (const emb of embeddings) {
    for (let d = 0; d < dim; d++) centroid[d] += emb[d]!;
  }
  for (let d = 0; d < dim; d++) centroid[d] /= embeddings.length;
  // L2 normalize centroid
  let norm = 0;
  for (let d = 0; d < dim; d++) norm += centroid[d]! * centroid[d]!;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let d = 0; d < dim; d++) centroid[d] /= norm;

  // Rank by centrality (cosine to centroid) * importance weight
  const scored = sentences.map((s, i) => {
    let dot = 0;
    for (let d = 0; d < dim; d++) dot += embeddings[i]![d]! * centroid[d]!;
    const centralityScore = dot * (0.7 + 0.3 * s.importance); // weight by importance
    return { ...s, score: centralityScore, embedding: embeddings[i]! };
  });

  scored.sort((a, b) => b.score - a.score);

  // Select top sentences, deduplicate (skip if >0.9 similarity to already selected)
  const selected: typeof scored = [];
  for (const candidate of scored) {
    if (selected.length >= maxSentences) break;

    const isDuplicate = selected.some(s => {
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += s.embedding[d]! * candidate.embedding[d]!;
      return dot > 0.9;
    });

    if (!isDuplicate) {
      selected.push(candidate);
    }
  }

  // Order chronologically
  selected.sort((a, b) => a.created_at.localeCompare(b.created_at));

  const representativeSentences = selected.map(s => s.text);
  let summary = representativeSentences.join('. ');
  if (!summary.endsWith('.')) summary += '.';
  if (summary.length > maxLength) summary = summary.slice(0, maxLength - 3) + '...';

  const sourceIds = [...new Set(selected.map(s => s.memoryId))];

  return { summary, source_ids: sourceIds, representative_sentences: representativeSentences };
}

/**
 * Summarize a cluster: get all memories in the cluster and produce extractive summary.
 */
export async function summarizeCluster(
  db: Database.Database,
  embedder: EmbeddingProvider,
  clusterId: string,
  options: { maxSentences?: number } = {},
): Promise<SummaryResult> {
  const memIds = db.prepare(
    'SELECT memory_id FROM memory_clusters WHERE cluster_id = ?'
  ).all(clusterId) as Array<{ memory_id: string }>;

  return summarizeMemories(db, embedder, memIds.map(r => r.memory_id), options);
}

/**
 * Summarize an episode: get all memories in the episode and produce extractive summary.
 */
export async function summarizeEpisode(
  db: Database.Database,
  embedder: EmbeddingProvider,
  episodeId: string,
  options: { maxSentences?: number } = {},
): Promise<SummaryResult> {
  const memIds = db.prepare(
    'SELECT id FROM memories WHERE episode_id = ? AND is_deleted = 0'
  ).all(episodeId) as Array<{ id: string }>;

  return summarizeMemories(db, embedder, memIds.map(r => r.id), options);
}
