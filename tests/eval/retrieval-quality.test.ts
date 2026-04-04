import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { runBenchmark } from '../../eval/benchmark.js';
import { generateReport } from '../../eval/report.js';

const FIXTURES_DIR = resolve(__dirname, '../../eval/fixtures');

describe('retrieval quality', () => {
  it('basic-recall meets all targets', async () => {
    const result = await runBenchmark(resolve(FIXTURES_DIR, 'basic-recall.json'));
    const report = generateReport(result);

    // Print report for CI visibility
    console.info(report.markdown);

    expect(result.recall5, 'Recall@5 below target').toBeGreaterThanOrEqual(0.80);
    expect(result.recall10, 'Recall@10 below target').toBeGreaterThanOrEqual(0.90);
    expect(result.mrr, 'MRR below target').toBeGreaterThanOrEqual(0.70);
    expect(result.hitRate, 'Hit Rate below target').toBeGreaterThanOrEqual(0.95);
    expect(result.searchP95Ms, 'Search P95 latency above target').toBeLessThan(100);
  });

  it('cross-namespace isolates results by namespace', async () => {
    const result = await runBenchmark(resolve(FIXTURES_DIR, 'cross-namespace.json'));
    const report = generateReport(result);

    console.info(report.markdown);

    expect(result.recall5, 'Recall@5 below target').toBeGreaterThanOrEqual(0.80);
    expect(result.recall10, 'Recall@10 below target').toBeGreaterThanOrEqual(0.90);
    expect(result.mrr, 'MRR below target').toBeGreaterThanOrEqual(0.70);
    expect(result.hitRate, 'Hit Rate below target').toBeGreaterThanOrEqual(0.95);
    expect(result.exclusionPassRate, 'Namespace isolation violated').toBe(1.0);
  });

  it('governance respects trust filters and tombstones', async () => {
    const result = await runBenchmark(resolve(FIXTURES_DIR, 'governance.json'));
    const report = generateReport(result);

    console.info(report.markdown);

    // Governance is about filtering, not embedding quality
    expect(result.exclusionPassRate, 'Governance exclusion violated').toBe(1.0);
    expect(result.hitRate, 'Hit Rate below target').toBeGreaterThanOrEqual(0.80);
  });
});
