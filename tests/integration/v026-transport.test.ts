import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDatabase, closeDatabase } from '../../src/storage/database.js';
import { applySchema } from '../../src/storage/schema.js';
import { SqliteVecStore } from '../../src/vectors/sqlite-vec.js';
import { createLogger } from '../../src/observability/logger.js';
import { createMetrics } from '../../src/observability/metrics.js';
import { loadConfig } from '../../src/config.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';
import { startHttpTransport, type HttpDeps } from '../../src/transport/http.js';
import { startMcpHttpDaemon } from '../../src/transport/mcp-http-daemon.js';
import { createServer as createMcpServer } from '../../src/server.js';

const DIMS = 8;

class FakeEmbedder implements EmbeddingProvider {
  readonly name = 'fake';
  readonly dimensions = DIMS;
  readonly maxTokens = 512;
  async embed(): Promise<Float32Array> {
    return new Float32Array(DIMS).fill(0.1);
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(DIMS).fill(0.1));
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

function makeDeps(): HttpDeps {
  const dbPath = join(tmpdir(), `neuromcp-v026-transport-${Date.now()}-${randomUUID()}.db`);
  const db = openDatabase(dbPath);
  applySchema(db);
  const vecStore = new SqliteVecStore(DIMS);
  vecStore.initialize(db);
  return {
    db,
    vecStore,
    embedder: new FakeEmbedder(),
    config: loadConfig(),
    logger: createLogger({ level: 'error', format: 'text' }),
    metrics: createMetrics(),
  };
}

describe('v0.26 transport hardening', () => {
  let cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.reverse()) await c();
    cleanups = [];
    closeDatabase();
  });

  describe('startHttpTransport bind error', () => {
    it('rejects (does not crash the process) when the port is already taken', async () => {
      const blocker: Server = createHttpServer((_req, res) => res.end('busy'));
      await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
      const port = (blocker.address() as { port: number }).port;
      cleanups.push(() => new Promise<void>((r) => blocker.close(() => r())));

      const deps = makeDeps();
      await expect(
        startHttpTransport({} as never, { port, host: '127.0.0.1' }, deps.logger, deps),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    });
  });

  describe('startHttpTransport DNS-rebinding Host guard', () => {
    // fetch/undici forbids overriding the Host header, so use raw http.request.
    function reqWithHost(port: number, path: string, host: string): Promise<number> {
      return new Promise((resolve, reject) => {
        const r = httpRequest(
          { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        r.on('error', reject);
        r.end();
      });
    }

    it('rejects a request whose Host header is not loopback with 421', async () => {
      const deps = makeDeps();
      const server = await startHttpTransport({} as never, { port: 0, host: '127.0.0.1' }, deps.logger, deps);
      const port = (server.address() as { port: number }).port;
      cleanups.push(() => new Promise<void>((r) => server.close(() => r())));

      expect(await reqWithHost(port, '/api/search?q=secret', 'attacker.example.com')).toBe(421);
      // A loopback Host still works.
      expect(await reqWithHost(port, '/health', `127.0.0.1:${port}`)).toBe(200);
    });
  });

  describe('daemon graceful shutdown', () => {
    it('shutdown() resolves promptly even with an open SSE /events stream', async () => {
      const deps = makeDeps();
      const { server, shutdown } = await startMcpHttpDaemon(
        () => createMcpServer(deps),
        { port: 0, host: '127.0.0.1' },
        deps,
        deps.logger,
      );
      const port = (server.address() as { port: number }).port;

      // Open an SSE stream and leave it hanging (this is what used to pin
      // httpServer.close() until the 5s hard-exit timer).
      const ac = new AbortController();
      const ssePromise = fetch(`http://127.0.0.1:${port}/events`, {
        headers: { Host: `127.0.0.1:${port}` },
        signal: ac.signal,
      }).catch(() => undefined);
      // Give the SSE connection a moment to establish.
      await new Promise((r) => setTimeout(r, 100));

      const start = Date.now();
      await shutdown();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2_000);

      ac.abort();
      await ssePromise;
    });
  });
});
