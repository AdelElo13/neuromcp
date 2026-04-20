import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { startHttpTransport, type HttpDeps } from '../../src/transport/http.js';

/** Minimal promise wrapper around Node's http.request. */
function httpReq(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('HTTP transport E2E', () => {
  let ctx: TestContext;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ctx = setupTestDb();

    const deps: HttpDeps = {
      db: ctx.db,
      vecStore: ctx.vecStore,
      embedder: ctx.embedder,
      config: ctx.config,
      logger: ctx.logger,
      metrics: ctx.metrics,
    };

    // McpServer instance — required by startHttpTransport signature but not used for HTTP endpoints
    const mcpServer = new McpServer({ name: 'test', version: '0.0.0' });

    // Port 0 = OS picks a random available port
    server = await startHttpTransport(
      mcpServer,
      { port: 0, host: '127.0.0.1' },
      ctx.logger,
      deps,
    );

    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    teardownTestDb(ctx);
  });

  it('GET /health returns status ok with version', async () => {
    const { status, data } = await httpReq('GET', `${baseUrl}/health`);

    expect(status).toBe(200);
    expect(data.status).toEqual('ok');
    expect(data.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('POST /api/store → GET /api/search full auto-capture flow with explain metadata', async () => {
    // Step 1: Store a memory via HTTP
    const storePayload = {
      content: 'TypeScript generics allow creating reusable type-safe components',
      category: 'code',
      tags: ['typescript', 'generics'],
      importance: 0.8,
      source: 'hook',
      metadata: { session: 'http-e2e-test' },
    };

    const storeRes = await httpReq('POST', `${baseUrl}/api/store`, storePayload);

    expect(storeRes.status).toBe(200);
    const storeData = storeRes.data as Record<string, unknown>;
    expect(storeData.id).toBeDefined();
    expect(typeof storeData.id).toBe('string');
    expect((storeData.id as string).length).toBe(32);
    expect(storeData.matched).toBe(false);

    // Step 2: Search for it via HTTP
    const searchRes = await httpReq(
      'GET',
      `${baseUrl}/api/search?q=TypeScript+generics&limit=5`,
    );

    expect(searchRes.status).toBe(200);
    const searchData = searchRes.data as {
      results: Array<Record<string, unknown>>;
      count: number;
    };
    expect(searchData.count).toBeGreaterThanOrEqual(1);

    // Step 3: Verify the stored memory appears in results
    const found = searchData.results.find(
      (r) => r.id === storeData.id,
    );
    expect(found).toBeDefined();
    expect(found!.content).toBe(storePayload.content);
    expect(found!.category).toBe('code');
    expect(found!.score).toBeGreaterThan(0);

    // Step 4: Verify explain metadata is present
    const explain = found!.explain as Record<string, unknown>;
    expect(explain).toBeDefined();

    // source_trust
    const sourceTrust = explain.source_trust as { level: string; reason: string };
    expect(sourceTrust).toBeDefined();
    expect(sourceTrust.level).toBeDefined();
    expect(typeof sourceTrust.reason).toBe('string');

    // temporal_validity
    const temporal = explain.temporal_validity as {
      currently_valid: boolean;
      valid_from: string | null;
      valid_to: string | null;
      superseded_by: string | null;
    };
    expect(temporal).toBeDefined();
    expect(typeof temporal.currently_valid).toBe('boolean');

    // confidence
    const confidence = explain.confidence as {
      retrieval_score: number;
      source_trust_score: number;
      temporal_valid: boolean;
      has_contradictions: boolean;
      claim_count: number;
      overall: number;
    };
    expect(confidence).toBeDefined();
    expect(typeof confidence.retrieval_score).toBe('number');
    expect(typeof confidence.source_trust_score).toBe('number');
    expect(typeof confidence.temporal_valid).toBe('boolean');
    expect(typeof confidence.overall).toBe('number');
    expect(confidence.overall).toBeGreaterThan(0);
    expect(confidence.overall).toBeLessThanOrEqual(1);
  });

  it('POST /api/store rejects missing content', async () => {
    const { status, data } = await httpReq('POST', `${baseUrl}/api/store`, {
      category: 'test',
    });

    expect(status).toBe(400);
    expect((data as Record<string, string>).error).toBe('content (string) required');
  });

  it('GET /api/search rejects missing query', async () => {
    const { status, data } = await httpReq('GET', `${baseUrl}/api/search`);

    expect(status).toBe(400);
    expect((data as Record<string, string>).error).toBe('q parameter required');
  });

  it('returns 404 for unknown routes', async () => {
    const { status, data } = await httpReq('GET', `${baseUrl}/nonexistent`);

    expect(status).toBe(404);
    expect((data as Record<string, string>).error).toBe('not_found');
  });
});
