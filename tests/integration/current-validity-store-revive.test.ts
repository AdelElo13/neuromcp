import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { storeMemory, type StoreDeps } from '../../src/tools/store.js';
import type { Memory } from '../../src/types.js';

/**
 * Re-store revive (v0.29, Codex Task1 #1).
 *
 * Once default reads hide superseded/window-closed rows, a dedup match on a
 * superseded row would silently return matched:true and leave the fact
 * invisible. Re-storing an old fact must REVIVE it (clear valid_to /
 * superseded_by_id, bump valid_from) so it becomes current again.
 */

describe('storeMemory — revive on re-store of a superseded fact', () => {
  let ctx: TestContext;
  let deps: StoreDeps;

  beforeEach(() => {
    ctx = setupTestDb();
    deps = {
      db: ctx.db,
      vecStore: ctx.vecStore,
      embedder: ctx.embedder,
      logger: ctx.logger,
      metrics: ctx.metrics,
      config: ctx.config,
    };
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  function row(id: string): Memory {
    return ctx.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory;
  }

  it('exact-dedup match on a superseded row revives it', async () => {
    const a = await storeMemory({ content: 'the region is us-east-1', namespace: 'default' }, deps);
    const b = await storeMemory({ content: 'the region is eu-west-1', namespace: 'default' }, deps);
    // Simulate A superseded by B.
    ctx.db
      .prepare('UPDATE memories SET valid_to = ?, superseded_by_id = ? WHERE id = ?')
      .run('2026-06-01T00:00:00.000Z', b.id, a.id);
    expect(row(a.id).superseded_by_id).toBe(b.id);

    // Re-store A's exact content → exact-dedup match → revive.
    const restored = await storeMemory({ content: 'the region is us-east-1', namespace: 'default' }, deps);
    expect(restored.id).toBe(a.id);
    expect(restored.matched).toBe(true);

    const revived = row(a.id);
    expect(revived.valid_to).toBeNull();
    expect(revived.superseded_by_id).toBeNull();
  });

  it('exact-dedup match on a window-closed row revives it', async () => {
    const a = await storeMemory({ content: 'ttl is 30 days', namespace: 'default' }, deps);
    ctx.db.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', a.id);

    const restored = await storeMemory({ content: 'ttl is 30 days', namespace: 'default' }, deps);
    expect(restored.id).toBe(a.id);
    expect(row(a.id).valid_to).toBeNull();
  });
});
