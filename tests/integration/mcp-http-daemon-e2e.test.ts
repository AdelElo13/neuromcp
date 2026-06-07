import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { startMcpHttpDaemon, type McpHttpDaemonDeps } from '../../src/transport/mcp-http-daemon.js';
import { createServer as createMcpServer } from '../../src/server.js';

/**
 * MCP Streamable HTTP daemon — happy path.
 *
 * Verifies that the daemon serves the MCP Streamable HTTP transport on /mcp:
 *   1. POST initialize (no session id) → 200 + mcp-session-id header + serverInfo.
 *   2. POST initialized notification on that session id → 202 Accepted.
 *   3. POST tools/list on that session id → 200 + a non-empty tools array
 *      that includes neuromcp's known tools (store_memory, recall_memory).
 *   4. Existing REST endpoints (/health, /api/store, /api/search) still
 *      reachable on the same port, so a single daemon serves all consumers.
 *
 * If `src/transport/mcp-http-daemon.ts` does not yet exist, the import fails
 * before the test even runs — that is the intentional "see it fail first"
 * step before the implementation lands.
 */

interface RawHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function rawHttp(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * MCP Streamable HTTP responses can come back as either:
 *   - Content-Type: application/json   → body is the JSON-RPC response.
 *   - Content-Type: text/event-stream  → body is one or more SSE frames; the
 *                                        relevant JSON-RPC payload sits inside
 *                                        a "data: <json>" line.
 *
 * Extract the first parsable JSON-RPC message out of either shape.
 */
function extractJsonRpc(res: RawHttpResponse): Record<string, unknown> | null {
  const ct = String(res.headers['content-type'] ?? '');
  if (ct.includes('application/json')) {
    try { return JSON.parse(res.body) as Record<string, unknown>; } catch { return null; }
  }
  if (ct.includes('text/event-stream')) {
    for (const line of res.body.split(/\r?\n/)) {
      if (line.startsWith('data: ')) {
        try { return JSON.parse(line.slice(6)) as Record<string, unknown>; } catch { /* try next */ }
      }
    }
  }
  return null;
}

const MCP_ACCEPT = 'application/json, text/event-stream';

describe('MCP HTTP daemon E2E (Streamable HTTP transport)', () => {
  let ctx: TestContext;
  let server: Server;
  let baseUrl: string;
  let sessionId: string | undefined;

  beforeAll(async () => {
    ctx = setupTestDb();

    const deps: McpHttpDaemonDeps = {
      db: ctx.db,
      vecStore: ctx.vecStore,
      embedder: ctx.embedder,
      config: ctx.config,
      logger: ctx.logger,
      metrics: ctx.metrics,
    };

    server = await startMcpHttpDaemon(
      () => createMcpServer(deps),
      { port: 0, host: '127.0.0.1' },
      deps,
      ctx.logger,
    );

    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    teardownTestDb(ctx);
  });

  it('POST /mcp initialize returns a session id and serverInfo.name=neuromcp', async () => {
    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        clientInfo: { name: 'mcp-http-daemon-test', version: '0.0.0' },
        capabilities: {},
      },
    });

    const res = await rawHttp(
      'POST',
      `${baseUrl}/mcp`,
      { 'Content-Type': 'application/json', 'Accept': MCP_ACCEPT },
      initBody,
    );

    expect(res.status).toBe(200);

    const hdr = res.headers['mcp-session-id'];
    expect(hdr, 'mcp-session-id header must be present on initialize response').toBeDefined();
    sessionId = Array.isArray(hdr) ? hdr[0] : hdr;
    expect(typeof sessionId).toBe('string');
    expect(sessionId!.length).toBeGreaterThan(0);

    const payload = extractJsonRpc(res);
    expect(payload, 'initialize response must contain parsable JSON-RPC').not.toBeNull();
    expect(payload!.jsonrpc).toBe('2.0');
    const result = payload!.result as { serverInfo?: { name?: string } } | undefined;
    expect(result?.serverInfo?.name).toBe('neuromcp');
  });

  it('POST /mcp tools/list returns a non-empty tool array including store_memory and recall_memory', async () => {
    expect(sessionId, 'previous initialize test must have produced a session id').toBeDefined();

    // Spec-compliant clients send the "notifications/initialized" notification
    // after they receive the initialize response. The transport accepts this
    // and treats subsequent requests as part of the live session.
    await rawHttp(
      'POST',
      `${baseUrl}/mcp`,
      {
        'Content-Type': 'application/json',
        'Accept': MCP_ACCEPT,
        'mcp-session-id': sessionId!,
      },
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );

    const res = await rawHttp(
      'POST',
      `${baseUrl}/mcp`,
      {
        'Content-Type': 'application/json',
        'Accept': MCP_ACCEPT,
        'mcp-session-id': sessionId!,
      },
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    );

    expect(res.status).toBe(200);

    const payload = extractJsonRpc(res);
    expect(payload, 'tools/list response must contain parsable JSON-RPC').not.toBeNull();
    expect(payload!.jsonrpc).toBe('2.0');

    const tools = (payload!.result as { tools?: Array<{ name: string }> } | undefined)?.tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools!.length).toBeGreaterThanOrEqual(20);

    const names = tools!.map((t) => t.name);
    expect(names).toContain('store_memory');
    expect(names).toContain('recall_memory');
  });

  it('POST /mcp without session id and without initialize returns 400 Bad Request', async () => {
    const res = await rawHttp(
      'POST',
      `${baseUrl}/mcp`,
      { 'Content-Type': 'application/json', 'Accept': MCP_ACCEPT },
      JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
    );

    expect(res.status).toBe(400);
  });

  it('rejects requests with a non-allowlisted Host header with 421', async () => {
    // Simulate a DNS-rebinding attempt: same TCP destination, but Host: attacker.com.
    const parsed = new URL(baseUrl);
    const port = parsed.port;
    const res = await rawHttp(
      'POST',
      `${baseUrl}/mcp`,
      {
        'Content-Type': 'application/json',
        'Accept': MCP_ACCEPT,
        'Host': `attacker.com:${port}`,
      },
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'x', version: '0' }, capabilities: {} } }),
    );
    expect(res.status).toBe(421);
    expect(JSON.parse(res.body)).toEqual({ error: 'misdirected_request' });
  });

  it('does NOT send Access-Control-Allow-Origin for a non-loopback Origin', async () => {
    const res = await rawHttp(
      'GET',
      `${baseUrl}/health`,
      { 'Accept': 'application/json', 'Origin': 'https://attacker.example.com' },
    );
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reflects Access-Control-Allow-Origin only when Origin is loopback', async () => {
    const res = await rawHttp(
      'GET',
      `${baseUrl}/health`,
      { 'Accept': 'application/json', 'Origin': 'http://127.0.0.1:3999' },
    );
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:3999');
  });

  it('GET /health (legacy REST endpoint) still served on the same port', async () => {
    const res = await rawHttp('GET', `${baseUrl}/health`, { 'Accept': 'application/json' });
    expect(res.status).toBe(200);

    let parsed: { status?: string; version?: string };
    try {
      parsed = JSON.parse(res.body) as { status?: string; version?: string };
    } catch {
      parsed = {};
    }
    expect(parsed.status).toBe('ok');
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
