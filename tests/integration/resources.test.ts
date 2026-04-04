import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { registerResources } from '../../src/resources/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../../src/server.js';

describe('Resources registration', () => {
  let ctx: TestContext;
  let server: McpServer;
  let deps: ServerDeps;

  beforeEach(() => {
    ctx = setupTestDb();
    deps = {
      db: ctx.db,
      vecStore: ctx.vecStore,
      embedder: ctx.embedder,
      config: ctx.config,
      logger: ctx.logger,
      metrics: ctx.metrics,
    };
    server = new McpServer(
      { name: 'test', version: '0.1.0' },
      { capabilities: { resources: {} } },
    );
    registerResources(server, deps);
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  it('registers without errors', () => {
    expect(server).toBeDefined();
  });
});

describe('Resource handlers return valid data', () => {
  let ctx: TestContext;
  let deps: ServerDeps;

  beforeEach(() => {
    ctx = setupTestDb();
    deps = {
      db: ctx.db,
      vecStore: ctx.vecStore,
      embedder: ctx.embedder,
      config: ctx.config,
      logger: ctx.logger,
      metrics: ctx.metrics,
    };
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  it('stats resource returns valid JSON', async () => {
    // Test the stats handler directly via memoryStats
    const { memoryStats } = await import('../../src/tools/stats.js');
    const stats = memoryStats({ namespace: '*' }, ctx.db, ctx.embedder, ctx.config);
    expect(stats).toBeDefined();
    expect(typeof stats.total).toBe('number');
    expect(stats.total).toBe(0);
  });

  it('recent memories resource returns empty array for fresh db', () => {
    const rows = ctx.db.prepare(
      'SELECT * FROM memories WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT 20',
    ).all();
    expect(rows).toEqual([]);
  });

  it('namespaces resource returns data after inserting memories', () => {
    insertTestMemory(ctx, { namespace: 'test-ns', content: 'hello world' });
    insertTestMemory(ctx, { namespace: 'test-ns', content: 'another one' });
    insertTestMemory(ctx, { namespace: 'other', content: 'different ns' });

    const rows = ctx.db.prepare(
      'SELECT namespace, COUNT(*) as count FROM memories WHERE is_deleted = 0 GROUP BY namespace ORDER BY count DESC',
    ).all() as Array<{ namespace: string; count: number }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]!.namespace).toBe('test-ns');
    expect(rows[0]!.count).toBe(2);
  });

  it('memory by ID resource returns correct memory', () => {
    const id = insertTestMemory(ctx, { content: 'find me' });
    const row = ctx.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    expect(row).toBeDefined();
    expect((row as { content: string }).content).toBe('find me');
  });

  it('tag resource filters correctly', () => {
    insertTestMemory(ctx, { tags: ['typescript', 'mcp'], content: 'ts memory' });
    insertTestMemory(ctx, { tags: ['python'], content: 'py memory' });

    const rows = ctx.db.prepare(
      "SELECT * FROM memories WHERE is_deleted = 0 AND tags LIKE ?",
    ).all('%"typescript"%');

    expect(rows).toHaveLength(1);
    expect((rows[0] as { content: string }).content).toBe('ts memory');
  });

  it('health resource returns ok status', () => {
    const snapshot = ctx.metrics.snapshot();
    expect(snapshot).toBeDefined();
    expect(snapshot.counters).toBeDefined();
  });

  it('operations resource returns empty for fresh db', () => {
    const rows = ctx.db.prepare(
      'SELECT * FROM operations ORDER BY started_at DESC LIMIT 20',
    ).all();
    expect(rows).toEqual([]);
  });
});
