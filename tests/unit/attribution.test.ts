import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    // v0.16.1 semantics: only cited memories get a usefulness row.
    // 'a' was cited, 'b' wasn't → only 1 row touched, not 2.
    expect(updated_memories).toBe(1);
    const scores = getUsefulnessScores(ctx.db, ['a', 'b']);
    expect(scores.get('a')).toBeGreaterThan(0.5);
    expect(scores.get('b')).toBe(0.5); // unseen, default prior
  });

  it('decay drifts scores back toward floor after half-life', () => {
    const deps = { db: ctx.db, logger: ctx.logger };
    logRetrieval(
      { query: 'old', retrieved_ids: ['x'], cited_ids: ['x'], outcome: 'helpful' },
      deps
    );
    const before = getUsefulnessScores(ctx.db, ['x']).get('x') ?? 0.5;
    expect(before).toBeGreaterThan(0.5);
    // v0.16.1: decay reads last_critiqued_at, not last_updated.
    // Mark both as 60 days ago.
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    ctx.db.prepare(`UPDATE memory_usefulness SET last_updated = ?, last_critiqued_at = ? WHERE memory_id = 'x'`)
      .run(sixtyDaysAgo, sixtyDaysAgo);
    decayUsefulness(deps, { half_life_days: 14 });
    const after = getUsefulnessScores(ctx.db, ['x']).get('x') ?? 0.5;
    expect(after).toBeLessThan(before);
  });
});


describe('attribution failure modes', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await setupTestDb(); });
  afterEach(async () => { await teardownTestDb(ctx); });

  it('cite_memories throws for unknown event id', () => {
    const deps = { db: ctx.db, logger: ctx.logger };
    expect(() => citeMemories({ event_id: 'nope', cited_ids: ['x'], outcome: 'helpful' }, deps))
      .toThrowError(/not found/);
  });

  it('not-cited memories do not accumulate neutral_count (v0.16.1 fix)', () => {
    const deps = { db: ctx.db, logger: ctx.logger };
    // Retrieve K=3 memories, cite only one, outcome helpful
    logRetrieval({ query: 'q', retrieved_ids: ['cited', 'ignored1', 'ignored2'], cited_ids: ['cited'], outcome: 'helpful' }, deps);
    logRetrieval({ query: 'q2', retrieved_ids: ['cited', 'ignored1', 'ignored2'], cited_ids: ['cited'], outcome: 'helpful' }, deps);
    // ignored* should have NO row in memory_usefulness (they were never cited)
    const ignored1 = ctx.db.prepare(`SELECT * FROM memory_usefulness WHERE memory_id = 'ignored1'`).get();
    expect(ignored1).toBeUndefined();
    // cited should have 2 helpful observations
    const cited = ctx.db.prepare(`SELECT helpful_count, neutral_count, harmful_count FROM memory_usefulness WHERE memory_id = 'cited'`).get() as any;
    expect(cited.helpful_count).toBe(2);
    expect(cited.neutral_count).toBe(0);
  });

  it('empty retrieved_ids does not crash getUsefulnessScores', () => {
    const scores = getUsefulnessScores(ctx.db, []);
    expect(scores.size).toBe(0);
  });

  it('decay only advances when last_critiqued_at is older than half-life (v0.16.1 fix)', () => {
    const deps = { db: ctx.db, logger: ctx.logger };
    logRetrieval({ query: 'q', retrieved_ids: ['m'], cited_ids: ['m'], outcome: 'helpful' }, deps);
    // Simulate retrievals refreshing last_updated but NOT last_critiqued_at
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    ctx.db.prepare(`UPDATE memory_usefulness SET last_updated = ?, last_critiqued_at = ? WHERE memory_id = 'm'`)
      .run(new Date().toISOString(), sixtyDaysAgo);
    const before = getUsefulnessScores(ctx.db, ['m']).get('m')!;
    decayUsefulness(deps, { half_life_days: 14 });
    const after = getUsefulnessScores(ctx.db, ['m']).get('m')!;
    expect(after).toBeLessThan(before); // decayed because last_critiqued_at is ancient
  });
});
