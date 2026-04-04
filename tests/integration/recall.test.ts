import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory } from '../helpers/index.js';
import type { TestContext } from '../helpers/index.js';
import { recallMemory } from '../../src/tools/recall.js';

describe('recallMemory', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestDb();
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  it('looks up by id', () => {
    const id = insertTestMemory(ctx, { id: 'recall-id-1', content: 'findme' });
    insertTestMemory(ctx, { content: 'other' });

    const results = recallMemory({ id }, ctx.db, ctx.config, ctx.logger, ctx.metrics);

    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe(id);
    expect(results[0]!.content).toBe('findme');
  });

  it('looks up by category', () => {
    insertTestMemory(ctx, { category: 'code', content: 'code thing' });
    insertTestMemory(ctx, { category: 'note', content: 'note thing' });

    const results = recallMemory(
      { category: 'code' },
      ctx.db,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(results.length).toBe(1);
    expect(results[0]!.category).toBe('code');
  });

  it('looks up by tags', () => {
    insertTestMemory(ctx, { tags: ['typescript', 'mcp'], content: 'ts stuff' });
    insertTestMemory(ctx, { tags: ['python'], content: 'py stuff' });

    const results = recallMemory(
      { tags: ['typescript'] },
      ctx.db,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe('ts stuff');
  });

  it('bumps access_count on recall', () => {
    const id = insertTestMemory(ctx, { access_count: 0 });

    recallMemory({ id }, ctx.db, ctx.config, ctx.logger, ctx.metrics);

    const row = ctx.db.prepare('SELECT access_count, last_accessed_at FROM memories WHERE id = ?').get(id) as {
      access_count: number;
      last_accessed_at: string | null;
    };
    expect(row.access_count).toBe(1);
    expect(row.last_accessed_at).not.toBeNull();
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      insertTestMemory(ctx, { content: `item ${i}` });
    }

    const results = recallMemory(
      { limit: 2 },
      ctx.db,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(results.length).toBe(2);
  });

  it('excludes deleted memories', () => {
    insertTestMemory(ctx, { id: 'active-1', content: 'active' });
    insertTestMemory(ctx, { id: 'deleted-1', content: 'deleted', is_deleted: 1 });

    const results = recallMemory({}, ctx.db, ctx.config, ctx.logger, ctx.metrics);

    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe('active-1');
  });

  it('filters by namespace', () => {
    insertTestMemory(ctx, { namespace: 'ns-a', content: 'in ns-a' });
    insertTestMemory(ctx, { namespace: 'ns-b', content: 'in ns-b' });

    const results = recallMemory(
      { namespace: 'ns-a' },
      ctx.db,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(results.length).toBe(1);
    expect(results[0]!.content).toBe('in ns-a');
  });
});
