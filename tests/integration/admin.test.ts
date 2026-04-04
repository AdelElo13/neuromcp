import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory } from '../helpers/index.js';
import type { TestContext } from '../helpers/index.js';
import { exportMemories, importMemories } from '../../src/tools/admin.js';

describe('exportMemories', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestDb();
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  it('exports as JSONL by default', () => {
    insertTestMemory(ctx, { content: 'line one' });
    insertTestMemory(ctx, { content: 'line two' });

    const output = exportMemories({}, ctx.db, ctx.config);
    const lines = output.split('\n').filter((l) => l.length > 0);

    expect(lines.length).toBe(2);
    // Each line should be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.content).toBeDefined();
    }
  });

  it('exports as JSON array', () => {
    insertTestMemory(ctx, { content: 'json export' });

    const output = exportMemories({ format: 'json' }, ctx.db, ctx.config);
    const parsed = JSON.parse(output);

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    expect(parsed[0].content).toBe('json export');
  });

  it('excludes tombstoned by default', () => {
    insertTestMemory(ctx, { content: 'active' });
    insertTestMemory(ctx, { content: 'deleted', is_deleted: 1 });

    const output = exportMemories({}, ctx.db, ctx.config);
    const lines = output.split('\n').filter((l) => l.length > 0);

    expect(lines.length).toBe(1);
  });

  it('includes tombstoned when requested', () => {
    insertTestMemory(ctx, { content: 'active' });
    insertTestMemory(ctx, { content: 'deleted', is_deleted: 1 });

    const output = exportMemories(
      { include_tombstoned: true },
      ctx.db,
      ctx.config,
    );
    const lines = output.split('\n').filter((l) => l.length > 0);

    expect(lines.length).toBe(2);
  });

  it('strips embedding fields from export', () => {
    insertTestMemory(ctx, { content: 'check fields' });

    const output = exportMemories({}, ctx.db, ctx.config);
    const parsed = JSON.parse(output);

    expect(parsed.embedding_model).toBeUndefined();
    expect(parsed.embedding_dim).toBeUndefined();
  });
});

describe('importMemories', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestDb();
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  it('imports from JSONL data', async () => {
    const data = [
      JSON.stringify({ content: 'imported one', category: 'test' }),
      JSON.stringify({ content: 'imported two', tags: ['tag1'] }),
    ].join('\n');

    const result = await importMemories(
      { data },
      ctx.db,
      ctx.vecStore,
      ctx.embedder,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);

    const count = ctx.db
      .prepare('SELECT COUNT(*) as cnt FROM memories WHERE is_deleted = 0')
      .get() as { cnt: number };
    expect(count.cnt).toBe(2);
  });

  it('imports from JSON array', async () => {
    const data = JSON.stringify([
      { content: 'array item one' },
      { content: 'array item two' },
    ]);

    const result = await importMemories(
      { data },
      ctx.db,
      ctx.vecStore,
      ctx.embedder,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(result.imported).toBe(2);
  });

  it('sets trust to unverified by default', async () => {
    const data = JSON.stringify({ content: 'untrusted import' });

    await importMemories(
      { data: `[${data}]` },
      ctx.db,
      ctx.vecStore,
      ctx.embedder,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    const row = ctx.db
      .prepare('SELECT source_trust FROM memories WHERE is_deleted = 0')
      .get() as { source_trust: string };
    expect(row.source_trust).toBe('unverified');
  });

  it('skips duplicates via content_hash', async () => {
    const data = JSON.stringify([
      { content: 'same content' },
      { content: 'same content' },
    ]);

    const result = await importMemories(
      { data },
      ctx.db,
      ctx.vecStore,
      ctx.embedder,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('generates fresh embeddings', async () => {
    const data = JSON.stringify([{ content: 'embed me fresh' }]);

    await importMemories(
      { data },
      ctx.db,
      ctx.vecStore,
      ctx.embedder,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    // Verify vector was stored
    expect(ctx.vecStore.count()).toBe(1);
  });

  it('counts records with missing content as errors', async () => {
    const data = JSON.stringify([
      { content: 'valid' },
      { category: 'no content here' },
    ]);

    const result = await importMemories(
      { data },
      ctx.db,
      ctx.vecStore,
      ctx.embedder,
      ctx.config,
      ctx.logger,
      ctx.metrics,
    );

    expect(result.imported).toBe(1);
    expect(result.errors).toBe(1);
  });
});
