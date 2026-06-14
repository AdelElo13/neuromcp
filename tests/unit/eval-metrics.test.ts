import { describe, it, expect } from 'vitest';
import {
  hitAtK,
  recallAtK,
  precisionAtK,
  reciprocalRank,
  ndcgAtK,
  computeRetrievalMetrics,
} from '../../eval/metrics.js';

const gold = new Set(['g1', 'g2', 'g3']);
// g2 at rank 2, g1 at rank 4; g3 not retrieved.
const ranked = ['x', 'g2', 'y', 'g1', 'z', 'w', 'v'];

describe('eval retrieval metrics', () => {
  it('hitAtK is 1 when any gold is in the top k', () => {
    expect(hitAtK(ranked, gold, 5)).toBe(1);
    expect(hitAtK(['a', 'b', 'c', 'd', 'e'], gold, 5)).toBe(0);
    expect(hitAtK(ranked, gold, 1)).toBe(0); // only 'x' in top1
  });

  it('recallAtK is the fraction of the gold set found (NOT hit@k)', () => {
    // top5 contains g2 and g1 → 2 of 3 gold = 0.666…
    expect(recallAtK(ranked, gold, 5)).toBeCloseTo(2 / 3, 6);
    // top10 still only has 2 of 3 (g3 never retrieved)
    expect(recallAtK(ranked, gold, 10)).toBeCloseTo(2 / 3, 6);
  });

  it('precisionAtK divides by k', () => {
    // 2 gold in top5 → 2/5
    expect(precisionAtK(ranked, gold, 5)).toBeCloseTo(2 / 5, 6);
  });

  it('reciprocalRank uses the first gold hit', () => {
    // first gold (g2) at rank 2 → 1/2
    expect(reciprocalRank(ranked, gold)).toBeCloseTo(1 / 2, 6);
    expect(reciprocalRank(['a', 'b'], gold)).toBe(0);
  });

  it('ndcgAtK is normalized to [0,1] and rewards earlier hits', () => {
    const early = ndcgAtK(['g1', 'g2', 'x', 'y', 'z'], gold, 5);
    const late = ndcgAtK(['x', 'y', 'z', 'g1', 'g2'], gold, 5);
    expect(early).toBeGreaterThan(late);
    expect(early).toBeLessThanOrEqual(1);
    expect(late).toBeGreaterThan(0);
    // Perfect ranking (all gold first) = 1.0
    expect(ndcgAtK(['g1', 'g2', 'g3', 'x', 'y'], gold, 5)).toBeCloseTo(1, 6);
  });

  it('empty gold set yields zeros, not NaN', () => {
    const empty = new Set<string>();
    expect(recallAtK(ranked, empty, 5)).toBe(0);
    expect(ndcgAtK(ranked, empty, 5)).toBe(0);
    expect(hitAtK(ranked, empty, 5)).toBe(0);
  });

  it('computeRetrievalMetrics bundles all metrics consistently', () => {
    const m = computeRetrievalMetrics(ranked, gold);
    expect(m.hit5).toBe(1);
    expect(m.recall5).toBeCloseTo(2 / 3, 6);
    expect(m.precision5).toBeCloseTo(2 / 5, 6);
    expect(m.mrr).toBeCloseTo(1 / 2, 6);
    expect(m.hit5).not.toBe(m.recall5); // the bug this file guards against
  });
});
