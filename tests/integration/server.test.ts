import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { createServer, type ServerDeps } from '../../src/server.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

describe('MCP Server creation', () => {
  let ctx: TestContext;
  let server: McpServer;

  beforeEach(() => {
    ctx = setupTestDb();
    const deps: ServerDeps = {
      db: ctx.db,
      vecStore: ctx.vecStore,
      embedder: ctx.embedder,
      config: ctx.config,
      logger: ctx.logger,
      metrics: ctx.metrics,
    };
    server = createServer(deps);
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  it('creates a server instance', () => {
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });

  it('server has the correct name', () => {
    // The underlying Server stores the serverInfo
    expect((server.server as unknown as { _serverInfo: { name: string } })._serverInfo.name).toBe('neuromcp');
  });
});
