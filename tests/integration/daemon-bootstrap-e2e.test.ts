import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end guard for the boot-race fix over the REAL production chain:
 *
 *   node dist/daemon-bootstrap.js
 *     → startEarlyBind (port bound immediately, requests buffered)
 *     → dynamic import('./daemon-core.js')
 *     → runDaemon(handoff) → startMcpHttpDaemon({ handoff }) → takeover
 *
 * The in-process tests in daemon-early-bind.test.ts inject a fake core, so
 * they cannot catch a wiring regression in this chain — e.g. daemon-core
 * dropping `handoff` from the transport options would make the core listen()
 * on a port the bootstrap already owns → EADDRINUSE → process exit on every
 * production cold boot, while all in-process tests stay green.
 *
 * NEUROMCP_TEST_INIT_DELAY_MS (the documented seam in daemon-core) stretches
 * the init window so the test can deterministically observe the buffering
 * phase. Embeddings resolve against an in-test fake Ollama server, so this
 * runs in CI without a real Ollama.
 *
 * Requires a build (`npm run build`) — CI builds before running tests.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BOOTSTRAP = join(REPO_ROOT, 'dist', 'daemon-bootstrap.js');
const INIT_DELAY_MS = 4000;

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
  return new Promise((resolvePromise, reject) => {
    const parsed = new URL(url);
    const req = httpRequest(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method, headers },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: raw }));
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

/** Minimal Ollama look-alike: /api/tags + /api/embed with a fixed 768-d vector. */
function startFakeOllama(): Promise<{ server: Server; url: string }> {
  const server = createHttpServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/embed') {
      // Drain the body, then answer with a constant non-zero vector.
      req.on('data', () => undefined);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ embeddings: [Array.from({ length: 768 }, () => 0.1)] }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolvePromise({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

/** Reserve a free TCP port by binding :0 and releasing it. */
function findFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolvePromise(port));
    });
  });
}

const MCP_ACCEPT = 'application/json, text/event-stream';
const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    clientInfo: { name: 'bootstrap-e2e', version: '0.0.0' },
    capabilities: {},
  },
});

describe('daemon-bootstrap E2E (real production chain)', () => {
  let fakeOllama: { server: Server; url: string };
  let tmpDir: string;
  let child: ChildProcess | undefined;
  let childStderr = '';
  let baseUrl: string;

  beforeAll(async () => {
    expect(existsSync(BOOTSTRAP), `missing ${BOOTSTRAP} — run \`npm run build\``).toBe(true);
    fakeOllama = await startFakeOllama();
    tmpDir = mkdtempSync(join(tmpdir(), 'neuromcp-bootstrap-e2e-'));
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    child = spawn(process.execPath, [BOOTSTRAP], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NEUROMCP_DAEMON_PORT: String(port),
        NEUROMCP_DB_PATH: join(tmpDir, 'e2e.db'),
        NEUROMCP_EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_HOST: fakeOllama.url,
        NEUROMCP_TEST_INIT_DELAY_MS: String(INIT_DELAY_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr!.on('data', (chunk: Buffer) => { childStderr += chunk.toString(); });
    child.stdout!.on('data', () => undefined);
  }, 20_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolvePromise) => child!.once('exit', () => resolvePromise()));
      child.kill('SIGTERM');
      await exited;
    }
    await new Promise<void>((resolvePromise) => fakeOllama.server.close(() => resolvePromise()));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('binds the port during the init window (503 starting), buffers an MCP initialize, and answers it after takeover', async () => {
    // 1. The port must accept connections LONG before the init delay ends.
    //    Poll until the first HTTP response; it must be the bootstrap's 503.
    const pollStart = Date.now();
    let first: RawHttpResponse | undefined;
    while (first === undefined) {
      if (Date.now() - pollStart > INIT_DELAY_MS) {
        throw new Error(`port never opened within the ${INIT_DELAY_MS}ms init window; stderr:\n${childStderr}`);
      }
      try {
        first = await rawHttp('GET', `${baseUrl}/health`, { Accept: 'application/json' });
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(first.status, `expected the bootstrap's starting response; stderr:\n${childStderr}`).toBe(503);
    expect(JSON.parse(first.body)).toEqual({ status: 'starting' });

    // 2. Fire an MCP initialize DURING the window — this is the Claude Code
    //    cold-boot attach. It must be buffered and answered, not refused.
    const res = await rawHttp(
      'POST',
      `${baseUrl}/mcp`,
      { 'Content-Type': 'application/json', Accept: MCP_ACCEPT },
      INIT_BODY,
    );
    expect(res.status, `initialize failed; stderr:\n${childStderr}`).toBe(200);
    expect(res.headers['mcp-session-id']).toBeDefined();
    const payload = extractJsonRpc(res);
    expect(payload).not.toBeNull();
    const result = payload!.result as { serverInfo?: { name?: string } } | undefined;
    expect(result?.serverInfo?.name).toBe('neuromcp');

    // 3. After takeover the real REST surface answers on the same port.
    const health = await rawHttp('GET', `${baseUrl}/health`, { Accept: 'application/json' });
    expect(health.status).toBe(200);
    expect((JSON.parse(health.body) as { status?: string }).status).toBe('ok');
  }, 30_000);
});
