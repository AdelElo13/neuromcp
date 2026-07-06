import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory } from '../helpers/index.js';
import type { TestContext } from '../helpers/index.js';
import { memoryStats } from '../../src/tools/stats.js';
import { recentMemories, namespaceMemories } from '../../src/resources/queries.js';

const PAST = '2000-01-01T00:00:00.000Z';

describe('memoryStats — current vs total', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('total counts all non-deleted; current counts only currently-valid', () => {
    insertTestMemory(ctx, { id: 'a', content: 'a' });
    insertTestMemory(ctx, { id: 'b', content: 'b', superseded_by_id: 'a' });
    insertTestMemory(ctx, { id: 'c', content: 'c', valid_to: PAST });
    insertTestMemory(ctx, { id: 'd', content: 'd', is_deleted: 1 });

    const stats = memoryStats({}, ctx.db, ctx.embedder, ctx.config);
    // total = non-deleted (a, b, c) = 3 — unchanged semantics
    expect(stats.total).toBe(3);
    // current = non-deleted AND not superseded AND open window (only a) = 1
    expect(stats.current).toBe(1);
  });
});

describe('resource query helpers — current-validity invariant', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('recentMemories hides superseded / window-closed rows by default', () => {
    insertTestMemory(ctx, { id: 'live', content: 'live' });
    insertTestMemory(ctx, { id: 'sup', content: 'sup', superseded_by_id: 'live' });
    insertTestMemory(ctx, { id: 'exp', content: 'exp', valid_to: PAST });

    const ids = recentMemories(ctx.db, 20).map((m) => m.id);
    expect(ids).toContain('live');
    expect(ids).not.toContain('sup');
    expect(ids).not.toContain('exp');
  });

  it('namespaceMemories hides superseded / window-closed rows by default', () => {
    insertTestMemory(ctx, { id: 'live', content: 'live', namespace: 'proj' });
    insertTestMemory(ctx, { id: 'sup', content: 'sup', namespace: 'proj', superseded_by_id: 'live' });

    const ids = namespaceMemories(ctx.db, 'proj', 100).map((m) => m.id);
    expect(ids).toContain('live');
    expect(ids).not.toContain('sup');
  });
});
