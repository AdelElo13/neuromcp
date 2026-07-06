import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory } from '../helpers/index.js';
import type { TestContext } from '../helpers/index.js';
import { recallMemory } from '../../src/tools/recall.js';
import { memoryTimeline } from '../../src/tools/timeline.js';

/**
 * Current-validity invariant (v0.29) — read paths.
 *
 * Default reads must hide superseded / window-closed rows. `include_superseded`
 * and `valid_at` opt back into history. id-lookup bypasses (explicit fetch).
 */

const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

describe('recallMemory — current-validity invariant', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestDb();
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  it('hides a superseded row by default', () => {
    insertTestMemory(ctx, { id: 'old', content: 'react 17', category: 'code', superseded_by_id: 'new' });
    insertTestMemory(ctx, { id: 'new', content: 'react 18', category: 'code' });

    const results = recallMemory({ category: 'code' }, ctx.db, ctx.config, ctx.logger, ctx.metrics);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('new');
    expect(ids).not.toContain('old');
  });

  it('hides a window-closed (valid_to in past) row by default', () => {
    insertTestMemory(ctx, { id: 'expired', content: 'stale fact', category: 'code', valid_to: PAST });
    insertTestMemory(ctx, { id: 'live', content: 'live fact', category: 'code' });

    const results = recallMemory({ category: 'code' }, ctx.db, ctx.config, ctx.logger, ctx.metrics);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('live');
    expect(ids).not.toContain('expired');
  });

  it('keeps a future-dated valid_to row visible by default', () => {
    insertTestMemory(ctx, { id: 'future', content: 'future window', category: 'code', valid_to: FUTURE });

    const results = recallMemory({ category: 'code' }, ctx.db, ctx.config, ctx.logger, ctx.metrics);
    expect(results.map((r) => r.id)).toContain('future');
  });

  it('include_superseded:true returns superseded and window-closed rows', () => {
    insertTestMemory(ctx, { id: 'old', content: 'react 17', category: 'code', superseded_by_id: 'new' });
    insertTestMemory(ctx, { id: 'expired', content: 'stale', category: 'code', valid_to: PAST });
    insertTestMemory(ctx, { id: 'new', content: 'react 18', category: 'code' });

    const results = recallMemory(
      { category: 'code', include_superseded: true },
      ctx.db,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );
    const ids = results.map((r) => r.id);
    expect(ids).toContain('old');
    expect(ids).toContain('expired');
    expect(ids).toContain('new');
  });

  it('id-lookup bypasses the filter (returns a superseded row)', () => {
    insertTestMemory(ctx, { id: 'old', content: 'react 17', superseded_by_id: 'new' });

    const results = recallMemory({ id: 'old' }, ctx.db, ctx.config, ctx.logger, ctx.metrics);
    expect(results.map((r) => r.id)).toContain('old');
  });

  it('coexisting (non-superseded, open-window) rows remain visible', () => {
    insertTestMemory(ctx, { id: 'a', content: 'fact a', category: 'code' });
    insertTestMemory(ctx, { id: 'b', content: 'fact b', category: 'code' });

    const results = recallMemory({ category: 'code' }, ctx.db, ctx.config, ctx.logger, ctx.metrics);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });
});

describe('memoryTimeline — current-validity invariant', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestDb();
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  function seedFts(id: string, content: string, overrides: Record<string, unknown> = {}): void {
    insertTestMemory(ctx, { id, content, ...overrides });
    const row = ctx.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
    ctx.db
      .prepare('INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, ?, ?)')
      .run(row.rowid, content, '[]', 'general');
  }

  it('include_superseded default (true) returns the whole chain', () => {
    seedFts('v1', 'kubernetes version is 1.28', { superseded_by_id: 'v2' });
    seedFts('v2', 'kubernetes version is 1.30', { supersedes_id: 'v1' });

    const result = memoryTimeline(ctx.db, { query: 'kubernetes version' }, 'default');
    const ids = result.entries.map((e) => e.memory.id);
    expect(ids).toContain('v1');
    expect(ids).toContain('v2');
  });

  it('include_superseded:false returns only the current entry', () => {
    seedFts('v1', 'kubernetes version is 1.28', { superseded_by_id: 'v2' });
    seedFts('v2', 'kubernetes version is 1.30', { supersedes_id: 'v1' });

    const result = memoryTimeline(
      ctx.db,
      { query: 'kubernetes version', include_superseded: false },
      'default',
    );
    const ids = result.entries.map((e) => e.memory.id);
    expect(ids).toContain('v2');
    expect(ids).not.toContain('v1');
  });

  it('include_superseded:false also drops window-closed (valid_to past) entries', () => {
    seedFts('expired', 'redis maxmemory is 1gb', { valid_to: PAST });
    seedFts('live', 'redis maxmemory is 4gb', {});

    const result = memoryTimeline(
      ctx.db,
      { query: 'redis maxmemory', include_superseded: false },
      'default',
    );
    const ids = result.entries.map((e) => e.memory.id);
    expect(ids).toContain('live');
    expect(ids).not.toContain('expired');
  });
});
