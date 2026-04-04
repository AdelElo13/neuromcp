import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory } from '../helpers/index.js';
import type { TestContext } from '../helpers/index.js';
import { memoryStats } from '../../src/tools/stats.js';

describe('memoryStats', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestDb();
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  it('returns correct total count', () => {
    insertTestMemory(ctx, { content: 'a' });
    insertTestMemory(ctx, { content: 'b' });
    insertTestMemory(ctx, { content: 'c', is_deleted: 1 });

    const stats = memoryStats({}, ctx.db, ctx.embedder, ctx.config);

    expect(stats.total).toBe(2);
  });

  it('returns counts by category', () => {
    insertTestMemory(ctx, { category: 'code' });
    insertTestMemory(ctx, { category: 'code' });
    insertTestMemory(ctx, { category: 'note' });

    const stats = memoryStats({}, ctx.db, ctx.embedder, ctx.config);

    expect(stats.by_category['code']).toBe(2);
    expect(stats.by_category['note']).toBe(1);
  });

  it('returns counts by source', () => {
    insertTestMemory(ctx, { source: 'user' });
    insertTestMemory(ctx, { source: 'auto' });

    const stats = memoryStats({}, ctx.db, ctx.embedder, ctx.config);

    expect(stats.by_source['user']).toBe(1);
    expect(stats.by_source['auto']).toBe(1);
  });

  it('returns counts by trust level', () => {
    insertTestMemory(ctx, { source_trust: 'high' });
    insertTestMemory(ctx, { source_trust: 'medium' });
    insertTestMemory(ctx, { source_trust: 'medium' });

    const stats = memoryStats({}, ctx.db, ctx.embedder, ctx.config);

    expect(stats.by_trust['high']).toBe(1);
    expect(stats.by_trust['medium']).toBe(2);
  });

  it('returns avg importance', () => {
    insertTestMemory(ctx, { importance: 0.2 });
    insertTestMemory(ctx, { importance: 0.8 });

    const stats = memoryStats({}, ctx.db, ctx.embedder, ctx.config);

    expect(stats.avg_importance).toBeCloseTo(0.5, 1);
  });

  it('returns tombstone count', () => {
    insertTestMemory(ctx, { is_deleted: 1 });
    insertTestMemory(ctx, { is_deleted: 1 });
    insertTestMemory(ctx, { is_deleted: 0 });

    const stats = memoryStats({}, ctx.db, ctx.embedder, ctx.config);

    expect(stats.tombstone_count).toBe(2);
  });

  it('returns embedding_model from embedder', () => {
    const stats = memoryStats({}, ctx.db, ctx.embedder, ctx.config);

    expect(stats.embedding_model).toBe('fake');
  });

  it('handles empty database', () => {
    const stats = memoryStats({}, ctx.db, ctx.embedder, ctx.config);

    expect(stats.total).toBe(0);
    expect(stats.avg_importance).toBe(0);
    expect(stats.oldest).toBeNull();
    expect(stats.newest).toBeNull();
  });
});
