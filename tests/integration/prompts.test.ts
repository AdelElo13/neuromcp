import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { storeMemory } from '../../src/tools/store.js';
import { searchMemory } from '../../src/tools/search.js';
import { consolidate } from '../../src/tools/consolidate.js';
import { registerPrompts } from '../../src/prompts/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../../src/server.js';

describe('Prompts registration', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestDb();
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  it('registers all prompts without errors', () => {
    const server = new McpServer(
      { name: 'test', version: '0.1.0' },
      { capabilities: { prompts: {} } },
    );
    const deps: ServerDeps = {
      db: ctx.db,
      vecStore: ctx.vecStore,
      embedder: ctx.embedder,
      config: ctx.config,
      logger: ctx.logger,
      metrics: ctx.metrics,
    };
    registerPrompts(server, deps);
    expect(server).toBeDefined();
  });
});

describe('Prompt handler logic', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestDb();
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  it('memory_context_for_task: returns "no memories" when DB is empty', async () => {
    const results = await searchMemory(
      { query: 'test task', limit: 5 },
      { db: ctx.db, vecStore: ctx.vecStore, embedder: ctx.embedder, logger: ctx.logger, metrics: ctx.metrics, config: ctx.config },
    );
    expect(results).toHaveLength(0);
  });

  it('memory_context_for_task: returns results when memories exist', async () => {
    // Store some memories first
    await storeMemory(
      { content: 'TypeScript MCP server implementation guide' },
      { db: ctx.db, vecStore: ctx.vecStore, embedder: ctx.embedder, logger: ctx.logger, metrics: ctx.metrics, config: ctx.config },
    );
    await storeMemory(
      { content: 'SQLite vector search with sqlite-vec extension' },
      { db: ctx.db, vecStore: ctx.vecStore, embedder: ctx.embedder, logger: ctx.logger, metrics: ctx.metrics, config: ctx.config },
    );

    const results = await searchMemory(
      { query: 'MCP server', limit: 5 },
      { db: ctx.db, vecStore: ctx.vecStore, embedder: ctx.embedder, logger: ctx.logger, metrics: ctx.metrics, config: ctx.config },
    );
    expect(results.length).toBeGreaterThan(0);
  });

  it('review_memory_candidate: finds near-duplicates', async () => {
    await storeMemory(
      { content: 'The quick brown fox jumps over the lazy dog' },
      { db: ctx.db, vecStore: ctx.vecStore, embedder: ctx.embedder, logger: ctx.logger, metrics: ctx.metrics, config: ctx.config },
    );

    // Search for something similar
    const results = await searchMemory(
      { query: 'quick brown fox', limit: 5 },
      { db: ctx.db, vecStore: ctx.vecStore, embedder: ctx.embedder, logger: ctx.logger, metrics: ctx.metrics, config: ctx.config },
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toContain('quick brown fox');
  });

  it('consolidation_dry_run: returns a plan', () => {
    // Insert some test memories
    insertTestMemory(ctx, { content: 'memory one', importance: 0.3 });
    insertTestMemory(ctx, { content: 'memory two', importance: 0.8 });

    const output = consolidate(
      { commit: false },
      ctx.db, ctx.vecStore, ctx.embedder, ctx.config, ctx.logger, ctx.metrics,
    );
    expect(output.type).toBe('plan');
    if (output.type === 'plan') {
      expect(output.plan.operation_id).toBeDefined();
      expect(output.plan.summary).toBeDefined();
      expect(typeof output.plan.summary.merge_count).toBe('number');
      expect(typeof output.plan.summary.decay_count).toBe('number');
      expect(typeof output.plan.summary.prune_count).toBe('number');
      expect(typeof output.plan.summary.sweep_count).toBe('number');
    }
  });
});
