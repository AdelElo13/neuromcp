import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory } from '../helpers/index.js';
import type { TestContext } from '../helpers/index.js';
import { storeMemory } from '../../src/tools/store.js';
import { findDuplicates } from '../../src/consolidation/dedup.js';

describe('findDuplicates', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestDb();
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  it('finds duplicates above threshold', async () => {
    // Store two very similar memories (disable dedup at store level)
    const deps = {
      db: ctx.db,
      vecStore: ctx.vecStore,
      embedder: ctx.embedder,
      logger: ctx.logger,
      metrics: ctx.metrics,
      config: { ...ctx.config, dedupThreshold: 0.999 },
    };

    await storeMemory({ content: 'the quick brown fox jumps over the lazy dog' }, deps);
    await storeMemory({ content: 'the quick brown fox jumps over the lazy cat' }, deps);

    const merges = findDuplicates(ctx.db, ctx.vecStore, 'default', 0.5);

    expect(merges.length).toBeGreaterThanOrEqual(1);
    expect(merges[0]!.keep_id).toBeDefined();
    expect(merges[0]!.tombstone_id).toBeDefined();
    expect(merges[0]!.similarity).toBeGreaterThan(0.5);
  });

  it('returns empty for dissimilar memories', async () => {
    const deps = {
      db: ctx.db,
      vecStore: ctx.vecStore,
      embedder: ctx.embedder,
      logger: ctx.logger,
      metrics: ctx.metrics,
      config: { ...ctx.config, dedupThreshold: 0.999 },
    };

    // Use very different content so embeddings are far apart
    await storeMemory({ content: 'aaaaaaaaa' }, deps);
    await storeMemory({ content: 'zzzzzzzzz' }, deps);

    const merges = findDuplicates(ctx.db, ctx.vecStore, 'default', 0.99);

    expect(merges.length).toBe(0);
  });

  it('prefers higher trust memory as keeper', async () => {
    const deps = {
      db: ctx.db,
      vecStore: ctx.vecStore,
      embedder: ctx.embedder,
      logger: ctx.logger,
      metrics: ctx.metrics,
      config: { ...ctx.config, dedupThreshold: 0.999 },
    };

    await storeMemory(
      { content: 'the quick brown fox jumps over the lazy dog', source: 'auto', source_trust: 'medium' },
      deps,
    );
    await storeMemory(
      { content: 'the quick brown fox jumps over the lazy cat', source: 'user', source_trust: 'high' },
      deps,
    );

    const merges = findDuplicates(ctx.db, ctx.vecStore, 'default', 0.5);

    if (merges.length > 0) {
      // The high-trust memory should be the keeper
      const keeper = ctx.db
        .prepare('SELECT source_trust FROM memories WHERE id = ?')
        .get(merges[0]!.keep_id) as { source_trust: string };
      expect(keeper.source_trust).toBe('high');
    }
  });

  it('merges tags as union', async () => {
    const deps = {
      db: ctx.db,
      vecStore: ctx.vecStore,
      embedder: ctx.embedder,
      logger: ctx.logger,
      metrics: ctx.metrics,
      config: { ...ctx.config, dedupThreshold: 0.999 },
    };

    await storeMemory(
      { content: 'the quick brown fox jumps over the lazy dog', tags: ['alpha', 'beta'] },
      deps,
    );
    await storeMemory(
      { content: 'the quick brown fox jumps over the lazy cat', tags: ['beta', 'gamma'] },
      deps,
    );

    const merges = findDuplicates(ctx.db, ctx.vecStore, 'default', 0.5);

    if (merges.length > 0) {
      expect(merges[0]!.merged_tags).toContain('alpha');
      expect(merges[0]!.merged_tags).toContain('beta');
      expect(merges[0]!.merged_tags).toContain('gamma');
    }
  });
});
