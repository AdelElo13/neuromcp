import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { createServer } from '../../src/server.js';
import type { ServerDeps } from '../../src/server.js';
import { SqliteVecStore } from '../../src/vectors/sqlite-vec.js';
import { DegradedEmbeddingProvider } from '../../src/embeddings/runtime.js';

/**
 * v0.29.3 — the degraded notice over the REAL MCP tool surface.
 *
 * The in-process tests in v0293-provider-switch.test.ts prove the notice
 * helpers work; this file proves the REGISTRATION layer actually attaches
 * them, by driving the tools end-to-end through an MCP client on an
 * in-memory transport. A degraded install must be visible on every tool a
 * user reaches for when memory "feels off": store, search, stats — and
 * backfill, which is the very tool the degraded banner points them at.
 */

function parseToolJson(result: { content?: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = result.content?.[0]?.text;
  expect(text, 'tool result must carry a JSON text payload').toBeTypeOf('string');
  return JSON.parse(text as string) as Record<string, unknown>;
}

describe('v0.29.3 degraded notice on the MCP tool surface', () => {
  let ctx: TestContext;
  let client: Client;

  beforeEach(async () => {
    ctx = setupTestDb();
    // A 768-dim index exists, but no matching provider is reachable →
    // exactly the runtime state resolveEmbeddingRuntime() degrades into.
    const vecStore = new SqliteVecStore(768);
    vecStore.initialize(ctx.db);
    const embedder = new DegradedEmbeddingProvider(
      768,
      'the existing vector index is 768-dimensional and no embedding provider was reachable.',
    );
    const deps: ServerDeps = {
      db: ctx.db,
      vecStore,
      embedder,
      config: ctx.config,
      logger: ctx.logger,
      metrics: ctx.metrics,
    };
    const server = createServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'degraded-surface-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    teardownTestDb(ctx);
  });

  it('store_memory carries neuromcp_notice', async () => {
    const res = await client.callTool({
      name: 'store_memory',
      arguments: { content: 'degraded-mode store keeps working via FTS' },
    });
    const payload = parseToolJson(res as never);
    expect(payload.neuromcp_notice).toMatch(/DEGRADED/);
    expect(payload.id).toBeTruthy();
  });

  it('search_memory carries neuromcp_notice', async () => {
    await client.callTool({
      name: 'store_memory',
      arguments: { content: 'the postmortem lives in the runbook repository' },
    });
    const res = await client.callTool({
      name: 'search_memory',
      arguments: { query: 'postmortem' },
    });
    const payload = parseToolJson(res as never);
    expect(payload.neuromcp_notice).toMatch(/DEGRADED/);
  });

  it('memory_stats carries neuromcp_notice and embeddings status', async () => {
    const res = await client.callTool({ name: 'memory_stats', arguments: {} });
    const payload = parseToolJson(res as never);
    expect(payload.neuromcp_notice).toMatch(/DEGRADED/);
    const embeddings = payload.embeddings as Record<string, unknown>;
    expect(embeddings.status).toBe('degraded');
  });

  it('backfill_embeddings carries neuromcp_notice (it cannot backfill without a provider)', async () => {
    const res = await client.callTool({ name: 'backfill_embeddings', arguments: {} });
    const payload = parseToolJson(res as never);
    expect(payload.neuromcp_notice).toMatch(/DEGRADED/);
    expect(payload.embedded).toBe(0);
  });
});
