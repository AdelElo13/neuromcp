import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import {
  startEarlyBind,
  type DaemonBootstrapHandoff,
  type DaemonCoreModule,
  type EarlyBindHandle,
} from '../../src/daemon-early-bind.js';
import { startMcpHttpDaemon, type McpHttpDaemonDeps } from '../../src/transport/mcp-http-daemon.js';
import { createServer as createMcpServer } from '../../src/server.js';

/**
 * Daemon boot-race fix — early port bind + request buffering.
 *
 * Regression context: on cold boot the daemon took ~110s to load its module
 * graph and initialize (better-sqlite3, embeddings probe, …) BEFORE binding
 * port 33200. Every MCP client that connected in that window got
 * ECONNREFUSED and showed "Could not attach to MCP server neuromcp"
 * (Claude Code connects over plain HTTP with no wait/retry wrapper).
 *
 * The fix: a dependency-free bootstrap binds the port immediately, answers
 * /health with 503 {"status":"starting"} (so mcp-remote-wait.sh keeps
 * polling), buffers all other requests, then dynamically imports the heavy
 * daemon core and replays the buffered requests into the real handler.
 *
 * These tests drive `startEarlyBind` in-process with a controlled fake core
 * so they are deterministic and need no Ollama. The "core" used in the
 * replay tests is the REAL `startMcpHttpDaemon` transport running on
 * FakeEmbedder deps — so the bootstrap→transport handoff path is the real
 * production path, not a stub.
 */

interface RawHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function rawHttp(
  method: 'GET' | 'POST',
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

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    clientInfo: { name: 'early-bind-test', version: '0.0.0' },
    capabilities: {},
  },
});

/** A manually-resolvable stand-in for `import('./daemon-core.js')`. */
function deferredCore(): {
  importCore: () => Promise<DaemonCoreModule>;
  resolve: (mod: DaemonCoreModule) => void;
  reject: (err: Error) => void;
} {
  let resolveFn!: (mod: DaemonCoreModule) => void;
  let rejectFn!: (err: Error) => void;
  const promise = new Promise<DaemonCoreModule>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { importCore: () => promise, resolve: resolveFn, reject: rejectFn };
}

/** Real transport as the daemon core, on FakeEmbedder deps. */
function realTransportCore(ctx: TestContext): DaemonCoreModule {
  return {
    async runDaemon(handoff: DaemonBootstrapHandoff): Promise<void> {
      const deps: McpHttpDaemonDeps = {
        db: ctx.db,
        vecStore: ctx.vecStore,
        embedder: ctx.embedder,
        config: ctx.config,
        logger: ctx.logger,
        metrics: ctx.metrics,
      };
      await startMcpHttpDaemon(
        () => createMcpServer(deps),
        { port: 0, host: '127.0.0.1', handoff },
        deps,
        ctx.logger,
      );
    },
  };
}

describe('daemon early bind (boot-race fix)', () => {
  let ctx: TestContext | undefined;
  let handle: EarlyBindHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.shutdown();
      // Cores that are never resolved leave handle.core pending forever —
      // attach a rejection guard but do NOT await settlement.
      void handle.core.catch(() => undefined);
      handle = undefined;
    }
    if (ctx) {
      teardownTestDb(ctx);
      ctx = undefined;
    }
  });

  it('binds the port immediately and serves 503 {"status":"starting"} on /health while the core is still loading', async () => {
    const core = deferredCore();
    handle = await startEarlyBind({ port: 0, host: '127.0.0.1', importCore: core.importCore });

    const addr = handle.server.address() as AddressInfo;
    const res = await rawHttp('GET', `http://127.0.0.1:${addr.port}/health`, { Accept: 'application/json' });

    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ status: 'starting' });
  });

  it('buffers a POST /mcp initialize sent during core load and replays it into the real transport after takeover', async () => {
    ctx = setupTestDb();
    const core = deferredCore();
    handle = await startEarlyBind({ port: 0, host: '127.0.0.1', importCore: core.importCore });
    const addr = handle.server.address() as AddressInfo;

    // Fire the MCP initialize while the core is still "loading" — this is
    // exactly what Claude Code does when it attaches during daemon boot.
    let settled = false;
    const pending = rawHttp(
      'POST',
      `http://127.0.0.1:${addr.port}/mcp`,
      { 'Content-Type': 'application/json', Accept: MCP_ACCEPT },
      INIT_BODY,
    ).then((res) => { settled = true; return res; });

    // Give the request time to reach the queue; it must NOT be answered yet.
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);

    core.resolve(realTransportCore(ctx));
    await handle.core;

    const res = await pending;
    expect(res.status).toBe(200);
    const sid = res.headers['mcp-session-id'];
    expect(sid, 'mcp-session-id header must be present on replayed initialize').toBeDefined();
    const payload = extractJsonRpc(res);
    expect(payload).not.toBeNull();
    const result = payload!.result as { serverInfo?: { name?: string } } | undefined;
    expect(result?.serverInfo?.name).toBe('neuromcp');
  });

  it('serves the real /health (200 {"status":"ok"}) after takeover', async () => {
    ctx = setupTestDb();
    const core = deferredCore();
    handle = await startEarlyBind({ port: 0, host: '127.0.0.1', importCore: core.importCore });
    const addr = handle.server.address() as AddressInfo;

    core.resolve(realTransportCore(ctx));
    await handle.core;

    const res = await rawHttp('GET', `http://127.0.0.1:${addr.port}/health`, { Accept: 'application/json' });
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as { status?: string }).status).toBe('ok');
  });

  it('rejects queued requests beyond queueLimit with 503 instead of buffering unboundedly', async () => {
    const core = deferredCore();
    handle = await startEarlyBind({
      port: 0,
      host: '127.0.0.1',
      importCore: core.importCore,
      queueLimit: 1,
    });
    const addr = handle.server.address() as AddressInfo;

    const first = rawHttp(
      'POST',
      `http://127.0.0.1:${addr.port}/mcp`,
      { 'Content-Type': 'application/json', Accept: MCP_ACCEPT },
      INIT_BODY,
    );
    // Give the first request time to occupy the single queue slot.
    await new Promise((r) => setTimeout(r, 100));
    const second = await rawHttp(
      'POST',
      `http://127.0.0.1:${addr.port}/mcp`,
      { 'Content-Type': 'application/json', Accept: MCP_ACCEPT },
      INIT_BODY,
    );
    expect(second.status).toBe(503);
    expect(JSON.parse(second.body)).toEqual({ status: 'starting' });

    // Shutdown flushes the still-queued first request with 503.
    await handle.shutdown();
    const firstRes = await first;
    expect(firstRes.status).toBe(503);
  });

  it('answers a queued request with 503 when holdTimeoutMs expires, and never replays it after takeover', async () => {
    const core = deferredCore();
    handle = await startEarlyBind({
      port: 0,
      host: '127.0.0.1',
      importCore: core.importCore,
      holdTimeoutMs: 50,
    });
    const addr = handle.server.address() as AddressInfo;

    // Queued during the core-load window; the hold timer must answer it.
    const timedOut = await rawHttp(
      'POST',
      `http://127.0.0.1:${addr.port}/mcp`,
      { 'Content-Type': 'application/json', Accept: MCP_ACCEPT },
      INIT_BODY,
    );
    expect(timedOut.status).toBe(503);
    expect(JSON.parse(timedOut.body)).toEqual({ status: 'starting' });

    // Takeover after the timeout must NOT re-dispatch the already-answered
    // request — the timer removed it from the queue.
    let replayed = 0;
    core.resolve({
      async runDaemon(handoff: DaemonBootstrapHandoff): Promise<void> {
        handoff.takeover(() => { replayed += 1; });
      },
    });
    await handle.core;
    expect(replayed).toBe(0);
  });

  it('replayed buffered requests still hit the Host (421) and Origin (403) guards of the real transport', async () => {
    ctx = setupTestDb();
    const core = deferredCore();
    handle = await startEarlyBind({ port: 0, host: '127.0.0.1', importCore: core.importCore });
    const addr = handle.server.address() as AddressInfo;

    // Both fired DURING the core-load window, so they are buffered by the
    // bootstrap — which itself applies no guards. The guards must run at
    // replay time inside the real rootHandler.
    const hostileHost = rawHttp(
      'POST',
      `http://127.0.0.1:${addr.port}/mcp`,
      { 'Content-Type': 'application/json', Accept: MCP_ACCEPT, Host: `attacker.com:${addr.port}` },
      INIT_BODY,
    );
    const hostileOrigin = rawHttp(
      'POST',
      `http://127.0.0.1:${addr.port}/mcp`,
      {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        Origin: 'https://attacker.example.com',
      },
      INIT_BODY,
    );
    await new Promise((r) => setTimeout(r, 100));

    core.resolve(realTransportCore(ctx));
    await handle.core;

    const hostRes = await hostileHost;
    expect(hostRes.status).toBe(421);
    expect(JSON.parse(hostRes.body)).toEqual({ error: 'misdirected_request' });

    const originRes = await hostileOrigin;
    expect(originRes.status).toBe(403);
  });

  it('flushes queued requests with 503 and rejects handle.core when the core import fails', async () => {
    const core = deferredCore();
    handle = await startEarlyBind({ port: 0, host: '127.0.0.1', importCore: core.importCore });
    const addr = handle.server.address() as AddressInfo;

    const queued = rawHttp(
      'POST',
      `http://127.0.0.1:${addr.port}/mcp`,
      { 'Content-Type': 'application/json', Accept: MCP_ACCEPT },
      INIT_BODY,
    );
    await new Promise((r) => setTimeout(r, 100));

    core.reject(new Error('module graph exploded'));

    await expect(handle.core).rejects.toThrow('module graph exploded');
    const res = await queued;
    expect(res.status).toBe(503);
  });
});
