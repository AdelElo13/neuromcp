/**
 * metrics.ts — honest retrieval metrics for the eval harness.
 *
 * The distractor runner historically reported a "R@5" number that was
 * actually Hit@5 (1 if ANY gold memory appears in the top 5). With
 * multi-memory gold sets that overstates recall. These functions compute
 * each metric distinctly so benchmark numbers mean what they say.
 *
 * All functions take the ranked list of retrieved ids (best first) and the
 * set of gold (relevant) ids.
 */

/** Hit@k: 1 if at least one gold id is in the top k, else 0. */
export function hitAtK(rankedIds: readonly string[], gold: ReadonlySet<string>, k: number): number {
  if (gold.size === 0) return 0;
  return rankedIds.slice(0, k).some((id) => gold.has(id)) ? 1 : 0;
}

/** Recall@k: fraction of the gold set retrieved within the top k. */
export function recallAtK(rankedIds: readonly string[], gold: ReadonlySet<string>, k: number): number {
  if (gold.size === 0) return 0;
  let found = 0;
  for (const id of rankedIds.slice(0, k)) {
    if (gold.has(id)) found++;
  }
  return found / gold.size;
}

/** Precision@k: fraction of the top k that are gold (k is the denominator). */
export function precisionAtK(rankedIds: readonly string[], gold: ReadonlySet<string>, k: number): number {
  if (k <= 0) return 0;
  let found = 0;
  for (const id of rankedIds.slice(0, k)) {
    if (gold.has(id)) found++;
  }
  return found / k;
}

/** Reciprocal rank of the first gold hit (0 if none in the list). */
export function reciprocalRank(rankedIds: readonly string[], gold: ReadonlySet<string>): number {
  for (let i = 0; i < rankedIds.length; i++) {
    if (gold.has(rankedIds[i]!)) return 1 / (i + 1);
  }
  return 0;
}

/**
 * nDCG@k with binary relevance. DCG uses the standard log2(rank+1)
 * discount; IDCG is the DCG of the ideal ranking (all gold first), so the
 * result is normalized to [0, 1].
 */
export function ndcgAtK(rankedIds: readonly string[], gold: ReadonlySet<string>, k: number): number {
  if (gold.size === 0) return 0;
  let dcg = 0;
  const top = rankedIds.slice(0, k);
  for (let i = 0; i < top.length; i++) {
    if (gold.has(top[i]!)) dcg += 1 / Math.log2(i + 2);
  }
  const idealHits = Math.min(gold.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}

export interface RetrievalMetrics {
  readonly hit5: number;
  readonly hit10: number;
  readonly recall5: number;
  readonly recall10: number;
  readonly precision5: number;
  readonly ndcg5: number;
  readonly mrr: number;
}

/** Compute the full metric set for one ranked result list against a gold set. */
export function computeRetrievalMetrics(
  rankedIds: readonly string[],
  gold: ReadonlySet<string>,
): RetrievalMetrics {
  return {
    hit5: hitAtK(rankedIds, gold, 5),
    hit10: hitAtK(rankedIds, gold, 10),
    recall5: recallAtK(rankedIds, gold, 5),
    recall10: recallAtK(rankedIds, gold, 10),
    precision5: precisionAtK(rankedIds, gold, 5),
    ndcg5: ndcgAtK(rankedIds, gold, 5),
    mrr: reciprocalRank(rankedIds, gold),
  };
}
