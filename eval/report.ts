import type { BenchmarkResult } from './benchmark.js';

export interface Target {
  readonly name: string;
  readonly target: number;
  readonly actual: number;
  readonly unit: string;
  readonly higherIsBetter: boolean;
}

export interface Report {
  readonly fixture: string;
  readonly targets: readonly Target[];
  readonly passed: boolean;
  readonly markdown: string;
}

const DEFAULT_TARGETS = {
  recall5: 0.80,
  recall10: 0.90,
  mrr: 0.70,
  hitRate: 0.95,
  searchP95Ms: 100,
  exclusionPassRate: 1.0,
} as const;

function status(target: Target): string {
  if (target.higherIsBetter) {
    return target.actual >= target.target ? 'PASS' : 'FAIL';
  }
  return target.actual <= target.target ? 'PASS' : 'FAIL';
}

function formatValue(value: number, unit: string): string {
  if (unit === 'ms') return `${value.toFixed(1)}ms`;
  return (value * 100).toFixed(1) + '%';
}

export function generateReport(
  result: BenchmarkResult,
  overrides?: Partial<typeof DEFAULT_TARGETS>,
): Report {
  const thresholds = { ...DEFAULT_TARGETS, ...overrides };

  const targets: Target[] = [
    {
      name: 'Recall@5',
      target: thresholds.recall5,
      actual: result.recall5,
      unit: 'ratio',
      higherIsBetter: true,
    },
    {
      name: 'Recall@10',
      target: thresholds.recall10,
      actual: result.recall10,
      unit: 'ratio',
      higherIsBetter: true,
    },
    {
      name: 'MRR',
      target: thresholds.mrr,
      actual: result.mrr,
      unit: 'ratio',
      higherIsBetter: true,
    },
    {
      name: 'Hit Rate',
      target: thresholds.hitRate,
      actual: result.hitRate,
      unit: 'ratio',
      higherIsBetter: true,
    },
    {
      name: 'Search P95',
      target: thresholds.searchP95Ms,
      actual: result.searchP95Ms,
      unit: 'ms',
      higherIsBetter: false,
    },
    {
      name: 'Exclusion Pass Rate',
      target: thresholds.exclusionPassRate,
      actual: result.exclusionPassRate,
      unit: 'ratio',
      higherIsBetter: true,
    },
  ];

  const passed = targets.every((t) => status(t) === 'PASS');

  const rows = targets
    .map((t) => {
      const s = status(t);
      const targetStr = t.unit === 'ms' ? `< ${t.target}ms` : `>= ${(t.target * 100).toFixed(0)}%`;
      const actualStr = formatValue(t.actual, t.unit);
      return `| ${t.name} | ${targetStr} | ${actualStr} | ${s} |`;
    })
    .join('\n');

  const markdown = [
    `## Retrieval Quality Report: ${result.fixture}`,
    '',
    '| Metric | Target | Actual | Status |',
    '|--------|--------|--------|--------|',
    rows,
    '',
    `**Overall: ${passed ? 'PASS' : 'FAIL'}**`,
    '',
    `Queries evaluated: ${result.queryResults.length}`,
  ].join('\n');

  return { fixture: result.fixture, targets, passed, markdown };
}
