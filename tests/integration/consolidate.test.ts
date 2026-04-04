import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory } from '../helpers/index.js';
import type { TestContext } from '../helpers/index.js';
import { storeMemory } from '../../src/tools/store.js';
import { consolidate } from '../../src/tools/consolidate.js';

describe('consolidate', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestDb();
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  it('dry run returns a plan with summary', () => {
    insertTestMemory(ctx, { content: 'some memory' });

    const output = consolidate(
      { commit: false },
      ctx.db,
      ctx.vecStore,
      ctx.embedder,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(output.type).toBe('plan');
    if (output.type === 'plan') {
      expect(output.plan.operation_id).toBeDefined();
      expect(output.plan.summary).toBeDefined();
      expect(output.plan.summary.merge_count).toBeGreaterThanOrEqual(0);
      expect(output.plan.summary.decay_count).toBeGreaterThanOrEqual(0);
      expect(output.plan.summary.prune_count).toBeGreaterThanOrEqual(0);
      expect(output.plan.summary.sweep_count).toBeGreaterThanOrEqual(0);
    }
  });

  it('commit executes the plan and returns result', async () => {
    // Create an expired memory so there is something to sweep
    const pastDate = new Date(Date.now() - 86_400_000).toISOString();
    insertTestMemory(ctx, {
      content: 'expired',
      expires_at: pastDate,
    });

    const output = consolidate(
      { commit: true },
      ctx.db,
      ctx.vecStore,
      ctx.embedder,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(output.type).toBe('result');
    if (output.type === 'result') {
      expect(output.result.operation_id).toBeDefined();
      expect(output.result.swept).toBe(1);
    }

    // Verify the memory is now tombstoned
    const row = ctx.db
      .prepare('SELECT is_deleted FROM memories WHERE content = ?')
      .get('expired') as { is_deleted: number };
    expect(row.is_deleted).toBe(1);
  });

  it('dedup merges similar memories', async () => {
    // Store two very similar memories via the real store path to get embeddings
    const deps = {
      db: ctx.db,
      vecStore: ctx.vecStore,
      embedder: ctx.embedder,
      logger: ctx.logger,
      metrics: ctx.metrics,
      config: { ...ctx.config, dedupThreshold: 0.999 }, // Very high so store doesn't dedup
    };

    await storeMemory({ content: 'the quick brown fox jumps over the lazy dog' }, deps);
    await storeMemory({ content: 'the quick brown fox jumps over the lazy cat' }, deps);

    // Use a low threshold so these get merged during consolidation
    const output = consolidate(
      { commit: true, similarity_threshold: 0.5 },
      ctx.db,
      ctx.vecStore,
      ctx.embedder,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(output.type).toBe('result');
    if (output.type === 'result') {
      expect(output.result.merged).toBeGreaterThanOrEqual(1);
    }

    // One should be tombstoned
    const tombstoned = ctx.db
      .prepare('SELECT COUNT(*) as cnt FROM memories WHERE is_deleted = 1')
      .get() as { cnt: number };
    expect(tombstoned.cnt).toBeGreaterThanOrEqual(1);
  });

  it('decay reduces importance of old unaccessed memories', () => {
    // Insert a memory created long ago with no access
    const oldDate = new Date(Date.now() - 90 * 86_400_000).toISOString();
    insertTestMemory(ctx, {
      content: 'old memory',
      importance: 0.8,
      created_at: oldDate,
      last_accessed_at: null,
      source: 'auto',
      source_trust: 'medium',
    });

    const output = consolidate(
      { commit: true, decay_lambda: 0.05 },
      ctx.db,
      ctx.vecStore,
      ctx.embedder,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(output.type).toBe('result');
    if (output.type === 'result') {
      expect(output.result.decayed).toBeGreaterThanOrEqual(1);
    }

    // Check that importance was reduced
    const row = ctx.db
      .prepare('SELECT importance FROM memories WHERE content = ?')
      .get('old memory') as { importance: number };
    expect(row.importance).toBeLessThan(0.8);
  });

  it('logs consolidation actions', () => {
    const pastDate = new Date(Date.now() - 86_400_000).toISOString();
    insertTestMemory(ctx, { content: 'expired2', expires_at: pastDate });

    consolidate(
      { commit: true },
      ctx.db,
      ctx.vecStore,
      ctx.embedder,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    const logs = ctx.db
      .prepare('SELECT COUNT(*) as cnt FROM consolidation_log')
      .get() as { cnt: number };
    expect(logs.cnt).toBeGreaterThanOrEqual(1);
  });
});
