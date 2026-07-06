import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory } from '../helpers/index.js';
import type { TestContext } from '../helpers/index.js';
import { recallMemory } from '../../src/tools/recall.js';

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
