import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory } from '../helpers/index.js';
import type { TestContext } from '../helpers/index.js';
import { forgetMemory } from '../../src/tools/forget.js';

describe('forgetMemory', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestDb();
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  it('soft deletes by id', () => {
    const id = insertTestMemory(ctx, { content: 'to forget' });

    const result = forgetMemory(
      { id },
      ctx.db,
      ctx.vecStore,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(result.count).toBe(1);
    expect(result.ids).toEqual([id]);
    expect(result.dry_run).toBe(false);

    const row = ctx.db.prepare('SELECT is_deleted, tombstoned_at FROM memories WHERE id = ?').get(id) as {
      is_deleted: number;
      tombstoned_at: string | null;
    };
    expect(row.is_deleted).toBe(1);
    expect(row.tombstoned_at).not.toBeNull();
  });

  it('dry_run does not delete', () => {
    const id = insertTestMemory(ctx, { content: 'should survive' });

    const result = forgetMemory(
      { id, dry_run: true },
      ctx.db,
      ctx.vecStore,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(result.count).toBe(1);
    expect(result.dry_run).toBe(true);

    const row = ctx.db.prepare('SELECT is_deleted FROM memories WHERE id = ?').get(id) as { is_deleted: number };
    expect(row.is_deleted).toBe(0);
  });

  it('requires at least one filter', () => {
    expect(() =>
      forgetMemory({}, ctx.db, ctx.vecStore, ctx.config, ctx.logger, ctx.metrics),
    ).toThrow('requires at least one filter');
  });

  it('logs to consolidation_log', () => {
    const id = insertTestMemory(ctx, { content: 'log this' });

    forgetMemory(
      { id },
      ctx.db,
      ctx.vecStore,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    const logs = ctx.db
      .prepare('SELECT * FROM consolidation_log WHERE action = ?')
      .all('tombstone') as Array<{ source_ids: string }>;

    expect(logs.length).toBe(1);
    expect(JSON.parse(logs[0]!.source_ids)).toContain(id);
  });

  it('deletes by tags filter', () => {
    insertTestMemory(ctx, { tags: ['temp'], content: 'temp stuff' });
    insertTestMemory(ctx, { tags: ['keep'], content: 'keep stuff' });

    const result = forgetMemory(
      { tags: ['temp'] },
      ctx.db,
      ctx.vecStore,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(result.count).toBe(1);

    const active = ctx.db
      .prepare('SELECT COUNT(*) as cnt FROM memories WHERE is_deleted = 0')
      .get() as { cnt: number };
    expect(active.cnt).toBe(1);
  });

  it('deletes by below_importance', () => {
    insertTestMemory(ctx, { importance: 0.1, content: 'low' });
    insertTestMemory(ctx, { importance: 0.9, content: 'high' });

    const result = forgetMemory(
      { below_importance: 0.5 },
      ctx.db,
      ctx.vecStore,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(result.count).toBe(1);
    expect(result.ids.length).toBe(1);
  });
});
