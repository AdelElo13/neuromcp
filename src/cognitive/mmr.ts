import type { MemoryWithScore } from '../types.js';

/**
 * Maximal Marginal Relevance (MMR) re-ranking.
 *
 * Balances relevance and diversity in search results.
 * Prevents returning multiple near-duplicate memories.
 *
 * MMR score = lambda * relevance - (1-lambda) * max_similarity_to_selected
 *
 * @param candidates — scored search results (pre-sorted by relevance)
 * @param lambda — relevance vs diversity trade-off (0.7 = 70% relevance, 30% diversity)
 * @param limit — maximum results to return
 * @param contentSimilarity — function to compute similarity between two memory contents
 */
export function mmrRerank(
  candidates: readonly MemoryWithScore[],
  lambda: number = 0.7,
  limit: number = 10,
  scoreOf: (m: MemoryWithScore) => number = (m) => m.similarity_score,
): readonly MemoryWithScore[] {
  if (candidates.length <= 1) return candidates;

  const selected: MemoryWithScore[] = [];
  const remaining = [...candidates];

  // Always select the most relevant result first. `scoreOf` lets the caller
  // drive relevance off the reranker score (when a reranker ran) instead of
  // the RRF similarity_score, while keeping similarity_score intact for
  // explain.ts.
  selected.push(remaining.shift()!);

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;

      // Relevance component (normalized to 0-1 range)
      const maxScore = scoreOf(candidates[0]!);
      const relevance = maxScore > 0 ? scoreOf(candidate) / maxScore : 0;

      // Diversity component: max similarity to any already-selected result
      let maxSimilarityToSelected = 0;
      for (const sel of selected) {
        const sim = contentJaccardSimilarity(candidate.content, sel.content);
        if (sim > maxSimilarityToSelected) {
          maxSimilarityToSelected = sim;
        }
      }

      // MMR score
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarityToSelected;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]!);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

/**
 * Jaccard similarity between two texts (word-level).
 * Fast approximation of content overlap without embeddings.
 */
function contentJaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(tokenize(a));
  const wordsB = new Set(tokenize(b));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
}
