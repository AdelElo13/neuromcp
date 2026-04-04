import { describe, it, expect } from 'vitest';
import { createMetrics } from '../../src/observability/metrics.js';

describe('Metrics', () => {
  describe('counters', () => {
    it('increments a counter by 1 by default', () => {
      const m = createMetrics();
      m.increment('requests');
      m.increment('requests');

      expect(m.snapshot().counters['requests']).toBe(2);
    });

    it('increments a counter by a custom amount', () => {
      const m = createMetrics();
      m.increment('bytes', 1024);
      m.increment('bytes', 512);

      expect(m.snapshot().counters['bytes']).toBe(1536);
    });

    it('tracks multiple counters independently', () => {
      const m = createMetrics();
      m.increment('a');
      m.increment('b', 5);

      const snap = m.snapshot();
      expect(snap.counters['a']).toBe(1);
      expect(snap.counters['b']).toBe(5);
    });
  });

  describe('histograms', () => {
    it('computes correct percentiles for a simple dataset', () => {
      const m = createMetrics();
      // Record 100 values: 1, 2, 3, ..., 100
      for (let i = 1; i <= 100; i++) {
        m.record('latency', i);
      }

      const snap = m.snapshot();
      const h = snap.histograms['latency']!;

      expect(h.count).toBe(100);
      expect(h.p50).toBe(50);
      expect(h.p95).toBe(95);
      expect(h.p99).toBe(99);
    });

    it('handles a single value', () => {
      const m = createMetrics();
      m.record('latency', 42);

      const h = m.snapshot().histograms['latency']!;
      expect(h.count).toBe(1);
      expect(h.p50).toBe(42);
      expect(h.p95).toBe(42);
      expect(h.p99).toBe(42);
    });

    it('tracks multiple histograms independently', () => {
      const m = createMetrics();
      m.record('a', 10);
      m.record('b', 20);

      const snap = m.snapshot();
      expect(snap.histograms['a']!.p50).toBe(10);
      expect(snap.histograms['b']!.p50).toBe(20);
    });
  });

  describe('gauges', () => {
    it('sets and overwrites a gauge value', () => {
      const m = createMetrics();
      m.gauge('active_connections', 5);
      expect(m.snapshot().gauges['active_connections']).toBe(5);

      m.gauge('active_connections', 3);
      expect(m.snapshot().gauges['active_connections']).toBe(3);
    });

    it('tracks multiple gauges independently', () => {
      const m = createMetrics();
      m.gauge('memory', 100);
      m.gauge('cpu', 45);

      const snap = m.snapshot();
      expect(snap.gauges['memory']).toBe(100);
      expect(snap.gauges['cpu']).toBe(45);
    });
  });

  describe('newOperationId', () => {
    it('generates a 32-character hex string', () => {
      const m = createMetrics();
      const id = m.newOperationId();

      expect(id).toMatch(/^[0-9a-f]{32}$/);
    });

    it('generates unique IDs', () => {
      const m = createMetrics();
      const ids = new Set(Array.from({ length: 50 }, () => m.newOperationId()));

      expect(ids.size).toBe(50);
    });
  });

  describe('snapshot', () => {
    it('returns empty collections when nothing recorded', () => {
      const m = createMetrics();
      const snap = m.snapshot();

      expect(snap.counters).toEqual({});
      expect(snap.histograms).toEqual({});
      expect(snap.gauges).toEqual({});
    });
  });
});
