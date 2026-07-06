import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { runBenchmark } from '../../eval/benchmark.js';
import { generateReport } from '../../eval/report.js';

const FIXTURES_DIR = resolve(__dirname, '../../eval/fixtures');

// Wall-clock latency is machine-load-sensitive: the same run that measures
// P95 1.8ms in isolation measured 157ms with a build + subagents running
// beside it (2026-07-06). Asserting it in the default suite makes `npm test`
// flaky on loaded machines and noisy CI runners, so the assert only arms in
// the dedicated perf lane (`npm run test:perf`, via vitest.perf.config.ts).
// The default run still measures and prints the value for visibility.
const PERF_ASSERT = process.env.NEUROMCP_PERF_ASSERT === '1';

function expectSearchP95(p95Ms: number, targetMs: number): void {
  if (PERF_ASSERT) {
    expect(p95Ms, 'Search P95 latency above target').toBeLessThan(targetMs);
  } else {
    console.info(
      `[perf] search P95 ${p95Ms.toFixed(1)}ms (target <${targetMs}ms — not asserted; run \`npm run test:perf\` to enforce)`,
    );
  }
}

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
    expectSearchP95(result.searchP95Ms, 100);
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
