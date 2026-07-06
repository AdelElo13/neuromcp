import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { storeMemoryBatch } from '../../src/tools/store-batch.js';
import type { VectorStore } from '../../src/vectors/types.js';

/**
 * store-batch atomicity (v0.29 Fase 1B, Codex [MEDIUM]).
 *
 * Rows + FTS + vectors must land atomically. Previously the SQLite tx
 * (rows/FTS) committed before vecStore.upsertBatch ran, so a vector failure
 * left live rows with no vector — invisible to hybrid search forever.
 */

describe('storeMemoryBatch — atomicity', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('rolls back rows when vector indexing fails', async () => {
    // Wrap the real vec store so upsertBatch throws.
    const failingVec: VectorStore = new Proxy(ctx.vecStore, {
      get(target, prop, receiver) {
        if (prop === 'upsertBatch') {
          return () => { throw new Error('vector index failed'); };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as VectorStore;

    await expect(
      storeMemoryBatch(
        [
          { content: 'batch fact one', namespace: 'default' },
          { content: 'batch fact two', namespace: 'default' },
        ],
        { db: ctx.db, embedder: ctx.embedder, vecStore: failingVec, logger: ctx.logger },
      ),
    ).rejects.toThrow();

    // No live rows should remain — the whole batch rolled back.
    const count = ctx.db.prepare('SELECT COUNT(*) AS c FROM memories WHERE is_deleted = 0').get() as { c: number };
    expect(count.c).toBe(0);
    // FTS must also be empty.
    const fts = ctx.db.prepare('SELECT COUNT(*) AS c FROM memories_fts').get() as { c: number };
    expect(fts.c).toBe(0);
  });

  it('successful batch stores rows, FTS, and vectors together', async () => {
    const res = await storeMemoryBatch(
      [
        { content: 'alpha content', namespace: 'default' },
        { content: 'beta content', namespace: 'default' },
      ],
      { db: ctx.db, embedder: ctx.embedder, vecStore: ctx.vecStore, logger: ctx.logger },
    );
    expect(res.inserted).toBe(2);
    for (const id of res.ids) {
      const mem = ctx.db.prepare('SELECT COUNT(*) AS c FROM memories WHERE id = ?').get(id) as { c: number };
      const vec = ctx.db.prepare('SELECT COUNT(*) AS c FROM memories_vec WHERE id = ?').get(id) as { c: number };
      expect(mem.c).toBe(1);
      expect(vec.c).toBe(1);
    }
  });
});
