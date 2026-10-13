import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { startMcpHttpDaemon, type McpHttpDaemonDeps } from '../../src/transport/mcp-http-daemon.js';
import { createServer as createMcpServer } from '../../src/server.js';

/**
 * Session cap behaviour.
 *
 * Regression: on busy days (300-490 sessions/day) the 64-session cap was
 * saturated by abandoned-but-not-yet-swept sessions (30 min idle timeout),
 * and every new client got `503 session_cap_reached` — i.e. a Claude session
 * with no neuromcp tools at all. At the cap the daemon now evicts the
 * least-recently-active idle session instead; the evicted client gets 404 on
 * its next request and reinitialises per the Streamable HTTP spec. Sessions
 * that are recently active are never evicted, so a burst of fresh initialises
 * still hits the cap.
 */

interface RawHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function post(url: string, body: unknown, sid?: string): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sid) headers['mcp-session-id'] = sid;
    const req = httpRequest(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'POST', headers },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw }));
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

const initBody = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', clientInfo: { name: `cap-test-${id}`, version: '0' }, capabilities: {} },
});

const pingBody = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' });

async function initSession(baseUrl: string, id: number): Promise<RawHttpResponse & { sid?: string }> {
  const res = await post(`${baseUrl}/mcp`, initBody(id));
  const sid = res.headers['mcp-session-id'];
  return { ...res, sid: typeof sid === 'string' ? sid : undefined };
}

describe('MCP HTTP daemon session cap', () => {
  let ctx: TestContext | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  async function start(maxSessions: number, evictMinIdleMs: number): Promise<string> {
    ctx = setupTestDb();
    const deps: McpHttpDaemonDeps = {
      db: ctx.db,
      vecStore: ctx.vecStore,
      embedder: ctx.embedder,
      config: ctx.config,
      logger: ctx.logger,
      metrics: ctx.metrics,
    };
    let server: Server;
    ({ server, shutdown } = await startMcpHttpDaemon(
      () => createMcpServer(deps),
      { port: 0, host: '127.0.0.1', maxSessions, evictMinIdleMs },
      deps,
      ctx.logger,
    ));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    if (shutdown) await shutdown();
    if (ctx) teardownTestDb(ctx);
    shutdown = undefined;
    ctx = undefined;
  });

  it('evicts the least-recently-active idle session instead of rejecting a new one', async () => {
    const baseUrl = await start(2, 0);

    const first = await initSession(baseUrl, 1);
    const second = await initSession(baseUrl, 2);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Touch the first session so the SECOND becomes least-recently-active.
    await new Promise((r) => setTimeout(r, 5));
    expect((await post(`${baseUrl}/mcp`, pingBody(10), first.sid)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));

    const third = await initSession(baseUrl, 3);
    expect(third.status).toBe(200);
    expect(third.sid).toBeDefined();

    // Evicted session → 404 so the client reinitialises; the others survive.
    expect((await post(`${baseUrl}/mcp`, pingBody(11), second.sid)).status).toBe(404);
    expect((await post(`${baseUrl}/mcp`, pingBody(12), first.sid)).status).toBe(200);
    expect((await post(`${baseUrl}/mcp`, pingBody(13), third.sid)).status).toBe(200);
  });

  it('never evicts a session that holds an open SSE stream', async () => {
    const baseUrl = await start(2, 0);

    const streaming = await initSession(baseUrl, 1);
    await new Promise((r) => setTimeout(r, 5));
    const idle = await initSession(baseUrl, 2);
    expect(streaming.status).toBe(200);
    expect(idle.status).toBe(200);
    // `streaming` is now the least-recently-active session — but it holds a
    // GET /mcp SSE stream, so eviction must pick `idle` instead.
    await post(`${baseUrl}/mcp`, { jsonrpc: '2.0', method: 'notifications/initialized' }, streaming.sid);
    const { hostname, port } = new URL(baseUrl);
    const sse = httpRequest({
      hostname, port, path: '/mcp', method: 'GET',
      headers: { Accept: 'text/event-stream', 'mcp-session-id': streaming.sid! },
    });
    const opened = new Promise<void>((resolve) => sse.on('response', () => resolve()));
    sse.end();
    await opened;
    await new Promise((r) => setTimeout(r, 5));
    // Make `idle` more recent than `streaming` so LRU alone would pick `streaming`.
    expect((await post(`${baseUrl}/mcp`, pingBody(20), idle.sid)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));

    try {
      const third = await initSession(baseUrl, 3);
      expect(third.status).toBe(200);
      expect((await post(`${baseUrl}/mcp`, pingBody(21), idle.sid)).status).toBe(404);
      expect((await post(`${baseUrl}/mcp`, pingBody(22), streaming.sid)).status).toBe(200);
    } finally {
      sse.destroy();
    }
  });

  it('still rejects with 503 when every session was active within evictMinIdleMs', async () => {
    const baseUrl = await start(2, 60_000);

    expect((await initSession(baseUrl, 1)).status).toBe(200);
    expect((await initSession(baseUrl, 2)).status).toBe(200);

    const third = await initSession(baseUrl, 3);
    expect(third.status).toBe(503);
    expect(third.body).toContain('session_cap_reached');
  });
});
