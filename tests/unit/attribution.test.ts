import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { logRetrieval, citeMemories, usefulnessStats, getUsefulnessScores, decayUsefulness } from '../../src/tools/attribution.js';

describe('attribution tools', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await setupTestDb();
  });

  afterEach(async () => {
    await teardownTestDb(ctx);
  });

  it('logs a bare retrieval event', () => {
    const deps = { db: ctx.db, logger: ctx.logger };
    const { event_id } = logRetrieval(
      { query: 'what is X', retrieved_ids: ['a', 'b', 'c'] },
      deps
    );
    expect(event_id).toMatch(/^[0-9a-f]{32}$/);
    const row = ctx.db.prepare(`SELECT outcome FROM retrieval_events WHERE id = ?`).get(event_id) as any;
    expect(row.outcome).toBeNull();
  });

  it('updates usefulness when outcome is given', () => {
    const deps = { db: ctx.db, logger: ctx.logger };
    logRetrieval(
      {
        query: 'how to ship',
        retrieved_ids: ['m1', 'm2', 'm3'],
        cited_ids: ['m1'],
        outcome: 'helpful',
      },
      deps
    );
    const scores = getUsefulnessScores(ctx.db, ['m1', 'm2', 'm3', 'unseen']);
    expect(scores.get('m1')).toBeGreaterThan(0.5); // cited + helpful
    expect(scores.get('m2')).toBe(0.5); // not cited
    expect(scores.get('m3')).toBe(0.5); // not cited
    expect(scores.get('unseen')).toBe(0.5); // default fallback
  });

  it('penalises cited + harmful memories', () => {
    const deps = { db: ctx.db, logger: ctx.logger };
    logRetrieval(
      {
        query: 'bad advice',
        retrieved_ids: ['m1'],
        cited_ids: ['m1'],
        outcome: 'harmful',
      },
      deps
    );
    const scores = getUsefulnessScores(ctx.db, ['m1']);
    expect(scores.get('m1')).toBeLessThan(0.5);
  });

  it('lists stats ordered by score', () => {
    const deps = { db: ctx.db, logger: ctx.logger };
    logRetrieval(
      { query: 'q1', retrieved_ids: ['good'], cited_ids: ['good'], outcome: 'helpful' },
      deps
    );
    logRetrieval(
      { query: 'q2', retrieved_ids: ['bad'], cited_ids: ['bad'], outcome: 'harmful' },
      deps
    );
    const stats = usefulnessStats({}, { db: ctx.db });
    expect(stats[0].memory_id).toBe('good');
    expect(stats[stats.length - 1].memory_id).toBe('bad');
  });

  it('cite_memories attaches verdict to existing event', () => {
    const deps = { db: ctx.db, logger: ctx.logger };
    const { event_id } = logRetrieval({ query: 'late', retrieved_ids: ['a', 'b'] }, deps);
    const { updated_memories } = citeMemories(
      { event_id, cited_ids: ['a'], outcome: 'helpful' },
      deps
    );
    expect(updated_memories).toBe(2);
    const scores = getUsefulnessScores(ctx.db, ['a', 'b']);
    expect(scores.get('a')).toBeGreaterThan(0.5);
  });

  it('decay drifts scores back toward floor after half-life', () => {
    const deps = { db: ctx.db, logger: ctx.logger };
    logRetrieval(
      { query: 'old', retrieved_ids: ['x'], cited_ids: ['x'], outcome: 'helpful' },
      deps
    );
    const before = getUsefulnessScores(ctx.db, ['x']).get('x') ?? 0.5;
    expect(before).toBeGreaterThan(0.5);
    // Mark last_updated as 60 days ago
    ctx.db.prepare(`UPDATE memory_usefulness SET last_updated = ? WHERE memory_id = 'x'`).run('2025-12-01T00:00:00.000Z');
    decayUsefulness(deps, { half_life_days: 14 });
    const after = getUsefulnessScores(ctx.db, ['x']).get('x') ?? 0.5;
    expect(after).toBeLessThan(before);
  });
});

// missing afterEach import
import { afterEach } from 'vitest';
