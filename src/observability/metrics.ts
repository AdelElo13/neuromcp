import { randomBytes } from 'node:crypto';

export interface MetricsSnapshot {
  readonly counters: Record<string, number>;
  readonly histograms: Record<string, { p50: number; p95: number; p99: number; count: number }>;
  readonly gauges: Record<string, number>;
}

export interface Metrics {
  increment(name: string, by?: number): void;
  record(name: string, value: number): void;
  gauge(name: string, value: number): void;
  snapshot(): MetricsSnapshot;
  newOperationId(): string;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

export function createMetrics(): Metrics {
  const counters = new Map<string, number>();
  const histograms = new Map<string, number[]>();
  const gauges = new Map<string, number>();

  return {
    increment(name: string, by = 1): void {
      counters.set(name, (counters.get(name) ?? 0) + by);
    },

    record(name: string, value: number): void {
      const existing = histograms.get(name);
      if (existing !== undefined) {
        existing.push(value);
      } else {
        histograms.set(name, [value]);
      }
    },

    gauge(name: string, value: number): void {
      gauges.set(name, value);
    },

    snapshot(): MetricsSnapshot {
      const histogramSnapshot: Record<string, { p50: number; p95: number; p99: number; count: number }> = {};
      for (const [name, values] of histograms) {
        const sorted = [...values].sort((a, b) => a - b);
        histogramSnapshot[name] = {
          p50: percentile(sorted, 50),
          p95: percentile(sorted, 95),
          p99: percentile(sorted, 99),
          count: sorted.length,
        };
      }

      return {
        counters: Object.fromEntries(counters),
        histograms: histogramSnapshot,
        gauges: Object.fromEntries(gauges),
      };
    },

    newOperationId(): string {
      return randomBytes(16).toString('hex');
    },
  };
}
