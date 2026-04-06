#!/usr/bin/env tsx
/**
 * Eval runner — runs all fixtures, generates reports, detects regressions.
 *
 * Usage:
 *   npx tsx eval/runner.ts                    # run all, compare to baseline
 *   npx tsx eval/runner.ts --update-baseline  # run all, save as new baseline
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { runBenchmark, type BenchmarkResult } from './benchmark.js';
import { generateReport, type Report } from './report.js';

const FIXTURES_DIR = resolve(import.meta.dirname, 'fixtures');
const BASELINE_PATH = resolve(import.meta.dirname, 'baseline.json');
const REGRESSION_TOLERANCE = 0.05; // 5% drop = regression

interface BaselineEntry {
  fixture: string;
  recall5: number;
  recall10: number;
  mrr: number;
  hitRate: number;
  searchP95Ms: number;
}

interface RegressionWarning {
  fixture: string;
  metric: string;
  baseline: number;
  current: number;
  delta: number;
}

async function main(): Promise<void> {
  const updateBaseline = process.argv.includes('--update-baseline');

  // Discover fixtures
  const fixtureFiles = readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => resolve(FIXTURES_DIR, f));

  if (fixtureFiles.length === 0) {
    console.log('No fixtures found in', FIXTURES_DIR);
    process.exit(0);
  }

  console.log(`\n=== neuromcp Eval Runner ===`);
  console.log(`Fixtures: ${fixtureFiles.length}\n`);

  // Run all benchmarks
  const results: BenchmarkResult[] = [];
  const reports: Report[] = [];

  for (const fixturePath of fixtureFiles) {
    const name = basename(fixturePath, '.json');
    process.stdout.write(`  ${name}... `);

    try {
      const result = await runBenchmark(fixturePath);
      const report = generateReport(result);
      results.push(result);
      reports.push(report);
      console.log(report.passed ? 'PASS' : 'FAIL');
    } catch (err: unknown) {
      console.log('ERROR:', err instanceof Error ? err.message : String(err));
    }
  }

  // Print reports
  console.log('\n' + '─'.repeat(60));
  for (const report of reports) {
    console.log('\n' + report.markdown);
  }

  // Regression detection
  const regressions: RegressionWarning[] = [];

  if (existsSync(BASELINE_PATH) && !updateBaseline) {
    const baseline: BaselineEntry[] = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
    const baselineMap = new Map(baseline.map(b => [b.fixture, b]));

    for (const result of results) {
      const base = baselineMap.get(result.fixture);
      if (!base) continue;

      const checks: Array<{ metric: string; baseline: number; current: number; higherIsBetter: boolean }> = [
        { metric: 'recall5', baseline: base.recall5, current: result.recall5, higherIsBetter: true },
        { metric: 'recall10', baseline: base.recall10, current: result.recall10, higherIsBetter: true },
        { metric: 'mrr', baseline: base.mrr, current: result.mrr, higherIsBetter: true },
        { metric: 'hitRate', baseline: base.hitRate, current: result.hitRate, higherIsBetter: true },
        { metric: 'searchP95Ms', baseline: base.searchP95Ms, current: result.searchP95Ms, higherIsBetter: false },
      ];

      for (const check of checks) {
        const delta = check.higherIsBetter
          ? (check.baseline - check.current) / Math.max(check.baseline, 0.001)
          : (check.current - check.baseline) / Math.max(check.baseline, 0.001);

        if (delta > REGRESSION_TOLERANCE) {
          regressions.push({
            fixture: result.fixture,
            metric: check.metric,
            baseline: check.baseline,
            current: check.current,
            delta,
          });
        }
      }
    }

    if (regressions.length > 0) {
      console.log('\n⚠️  REGRESSIONS DETECTED:');
      for (const r of regressions) {
        console.log(`  ${basename(r.fixture)}: ${r.metric} dropped ${(r.delta * 100).toFixed(1)}% (${r.baseline.toFixed(3)} → ${r.current.toFixed(3)})`);
      }
    } else {
      console.log('\n✓ No regressions detected');
    }
  }

  // Update baseline
  if (updateBaseline) {
    const newBaseline: BaselineEntry[] = results.map(r => ({
      fixture: r.fixture,
      recall5: r.recall5,
      recall10: r.recall10,
      mrr: r.mrr,
      hitRate: r.hitRate,
      searchP95Ms: r.searchP95Ms,
    }));
    writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2));
    console.log(`\n✓ Baseline updated: ${BASELINE_PATH}`);
  }

  // Summary
  const allPassed = reports.every(r => r.passed);
  const hasRegressions = regressions.length > 0;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Results: ${reports.filter(r => r.passed).length}/${reports.length} passed`);

  if (!allPassed || hasRegressions) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
