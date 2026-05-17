import { createServer as createHttpServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { NeuromcpConfig } from '../config.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import { searchMemory } from '../tools/search.js';
import { storeMemory } from '../tools/store.js';
import { storeMemoryBatch } from '../tools/store-batch.js';
import { eventBus } from './events.js';

// Resolved once at startup from the module's runtime location. The source
// tree lives in src/transport/ so `../../package.json` is correct for tsx
// runs; the tsup build flattens everything into dist/chunk-*.js so
// `../package.json` is correct for compiled runs. We try both and keep
// whichever resolves. This keeps /health accurate in both modes without
// a separate bundler plugin.
interface PackageShape { version?: unknown }

function readPackageVersion(): string {
  const attempts: string[] = [];
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const raw = readFileSync(new URL(rel, import.meta.url), 'utf8');
      const parsed = JSON.parse(raw) as PackageShape;
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
      attempts.push(`${rel}: parsed but version field missing or empty`);
    } catch (err) {
      attempts.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Loud fallback — something is wrong with the install layout. Stderr
  // rather than silent so the mystery version cannot ship unnoticed.
  process.stderr.write(
    `[neuromcp] WARNING: could not resolve package.json version. Attempts: ${attempts.join('; ')}\n`,
  );
  return '0.0.0-unknown';
}
const pkg = { version: readPackageVersion() };

export interface HttpTransportOptions {
  readonly port: number;
  readonly host: string;
}

export interface HttpDeps {
  readonly db: Database.Database;
  readonly vecStore: VectorStore;
  readonly embedder: EmbeddingProvider;
  readonly config: NeuromcpConfig;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/**
 * Maximum body size for REST POST endpoints (/api/store, /api/store-batch)
 * in bytes. Without this cap, the body accumulator (`body += chunk.toString()`)
 * lets a single connection allocate unbounded memory. Set generously enough
 * that real ingest payloads pass (batch ingest of large session transcripts
 * fits in 32 MiB), but bounded.
 */
const MAX_REST_BODY_BYTES = 32 * 1024 * 1024;

/**
 * The daemon binds to loopback only, but a browser can still reach
 * `http://127.0.0.1:<port>` from any open tab. Returning
 * `Access-Control-Allow-Origin: *` was the old default — that let any
 * cross-origin page read/write the user's memory via XHR. We now only
 * reflect ACAO when:
 *   - the request has no `Origin` header (i.e. comes from a non-browser
 *     client like curl or another local process), OR
 *   - the request's `Origin` is itself a loopback origin (local web tools
 *     served from 127.0.0.1 / localhost).
 * Any other Origin gets no ACAO header at all, so the browser blocks
 * the response from being read.
 */
function pickAllowedOrigin(originHeader: string | string[] | undefined): string | null {
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (origin === undefined || origin === '') return null;
  try {
    const parsed = new URL(origin);
    // Node's URL.hostname strips brackets for IPv6, but some callers / older
    // versions return `[::1]`. Accept both shapes so IPv6 loopback origins
    // (browsers served from `http://[::1]:...`) are not silently blocked.
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === '127.0.0.1' || host === '::1' || host === 'localhost') {
      return origin;
    }
  } catch {
    // Malformed Origin header — refuse.
  }
  return null;
}

/**
 * Build the REST + SSE request handler. Exported so both the legacy
 * dual-mode HTTP transport (`startHttpTransport`) and the new MCP-HTTP
 * daemon (`startMcpHttpDaemon`) can mount the same endpoints — /health,
 * /api/search, /api/store, /api/store-batch, /events — without duplicating
 * the implementation.
 *
 * The returned handler responds with `404 not_found` for any path it does
 * not own, so callers can chain it after their own route matching.
 *
 * `deps` is optional because /health works without DB/embedder access.
 */
export function createRestRequestHandler(
  logger: Logger,
  deps?: HttpDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    const allowedOrigin = pickAllowedOrigin(req.headers.origin);

    // Compose JSON response headers, only reflecting ACAO when the request
    // Origin is loopback (or absent). Default content-type is application/json
    // because every JSON response below used to set it inline.
    const jsonHeaders = (extra?: Record<string, string>): Record<string, string> => {
      const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
      if (allowedOrigin !== null) h['Access-Control-Allow-Origin'] = allowedOrigin;
      return h;
    };

    // CORS preflight — only reflect ACAO for loopback origins or no-Origin requests.
    if (req.method === 'OPTIONS') {
      const headers: Record<string, string> = {
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      };
      if (allowedOrigin !== null) headers['Access-Control-Allow-Origin'] = allowedOrigin;
      res.writeHead(204, headers);
      res.end();
      return;
    }

    // Health endpoint
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, jsonHeaders());
      res.end(JSON.stringify({ status: 'ok', version: pkg.version }));
      return;
    }

    // Search API — lightweight endpoint for hooks / auto-context injection.
    // chrono=1 bypasses hybrid ranking and returns the namespace's memories in
    // chronological order (oldest first). Used by RetainDB-style full-dump
    // strategies on benchmarks like LongMemEval where the LLM does the
    // reasoning over the whole memory rather than over a top-k slice.
    if (url.pathname === '/api/search' && req.method === 'GET' && deps) {
      const query = url.searchParams.get('q') ?? '';
      const namespace = url.searchParams.get('namespace') ?? deps.config.defaultNamespace;
      // Cap raised from 20 → 500 so chronological-dump callers can pull a full
      // user history. Hybrid callers still default to 5 if unspecified.
      const limit = Math.min(500, parseInt(url.searchParams.get('limit') ?? '5', 10));
      const chrono = url.searchParams.get('chrono') === '1';

      if (chrono) {
        try {
          const rows = deps.db
            .prepare(
              `SELECT id, content, category, importance
                 FROM memories
                WHERE namespace = ?
                  AND is_deleted = 0
                ORDER BY created_at ASC
                LIMIT ?`,
            )
            .all(namespace, limit) as Array<{
              id: string;
              content: string;
              category: string | null;
              importance: number | null;
            }>;
          res.writeHead(200, jsonHeaders());
          res.end(JSON.stringify({
            results: rows.map(r => ({ ...r, score: 1 })),
            count: rows.length,
            mode: 'chrono',
          }));
        } catch (err: unknown) {
          logger.warn('http', 'Chrono search failed', { error: err instanceof Error ? err.message : String(err) });
          res.writeHead(500, jsonHeaders());
          res.end(JSON.stringify({ error: 'chrono search failed' }));
        }
        return;
      }

      if (!query) {
        res.writeHead(400, jsonHeaders());
        res.end(JSON.stringify({ error: 'q parameter required' }));
        return;
      }

      // Temporal filters — forward optional after/before/valid_at if present.
      // These are the time-scoping filters searchMemory already supports on
      // the library side; /api/search just wasn't plumbing them through.
      const after = url.searchParams.get('after') ?? undefined;
      const before = url.searchParams.get('before') ?? undefined;
      const validAt = url.searchParams.get('valid_at') ?? undefined;

      try {
        const results = await searchMemory(
          { query, namespace, limit, hybrid: true, after, before, valid_at: validAt },
          deps,
        );

        res.writeHead(200, jsonHeaders());
        res.end(JSON.stringify({
          results: results.map(r => ({
            id: r.id,
            content: r.content,
            category: r.category,
            importance: r.importance,
            score: r.similarity_score,
            ...('explain' in r ? { explain: (r as { explain: unknown }).explain } : {}),
          })),
          count: results.length,
        }));
      } catch (err: unknown) {
        logger.warn('http', 'Search API failed', { error: err instanceof Error ? err.message : String(err) });
        res.writeHead(500, jsonHeaders());
        res.end(JSON.stringify({ error: 'search failed' }));
      }
      return;
    }

    // Helper: accumulate the request body up to MAX_REST_BODY_BYTES.
    // On overflow, write the 413 response BEFORE destroying the socket,
    // and reject with the sentinel `payload_too_large_handled` so the
    // caller knows the response is already finalized. Keeps the two
    // POST endpoints DRY.
    const readBoundedBody = (): Promise<string> => new Promise((resolve, reject) => {
      let received = 0;
      let exceeded = false;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        if (exceeded) return;
        received += chunk.length;
        if (received > MAX_REST_BODY_BYTES) {
          exceeded = true;
          if (!res.headersSent) {
            res.writeHead(413, jsonHeaders());
            res.end(JSON.stringify({ error: 'payload_too_large' }));
          }
          reject(new Error('payload_too_large_handled'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (exceeded) return;
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', reject);
    });

    // Guard for state-changing REST writes: refuse if the request has a
    // non-loopback Origin (CSRF). Without this, a browser could issue a
    // CORS-safelisted `text/plain` POST (no preflight) from any web page
    // and the body would still be JSON-parsed and stored — the browser
    // would just not see the response. Requiring Content-Type=application/json
    // also gives us a second line of defense: that content-type triggers
    // CORS preflight, which our preflight handler will reject for non-loopback.
    const isWritePath = url.pathname === '/api/store' || url.pathname === '/api/store-batch';
    if (isWritePath && req.method === 'POST') {
      const hasOrigin = req.headers.origin !== undefined && req.headers.origin !== '';
      if (hasOrigin && allowedOrigin === null) {
        res.writeHead(403, jsonHeaders());
        res.end(JSON.stringify({ error: 'cross_origin_forbidden' }));
        return;
      }
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
      if (!contentType.startsWith('application/json')) {
        res.writeHead(415, jsonHeaders());
        res.end(JSON.stringify({ error: 'content_type_must_be_application_json' }));
        return;
      }
    }

    // Store API — enables hooks to use the full store pipeline (dedup, contradiction, embeddings, claims)
    if (url.pathname === '/api/store' && req.method === 'POST' && deps) {
      try {
        const body = await readBoundedBody();
        const input = JSON.parse(body);
        if (!input.content || typeof input.content !== 'string') {
          res.writeHead(400, jsonHeaders());
          res.end(JSON.stringify({ error: 'content (string) required' }));
          return;
        }
        const result = await storeMemory(input, deps);
        res.writeHead(200, jsonHeaders());
        res.end(JSON.stringify(result));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'payload_too_large_handled') return; // 413 already written
        logger.warn('http', 'Store API failed', { error: msg });
        if (!res.headersSent) {
          res.writeHead(500, jsonHeaders());
          res.end(JSON.stringify({ error: 'store failed' }));
        }
      }
      return;
    }

    // Batch store API — fast-path for bulk ingest (benchmarks, migrations).
    // Skips dedup, contradiction, claim extraction. Use /api/store for
    // production single-doc writes with all safety machinery.
    if (url.pathname === '/api/store-batch' && req.method === 'POST' && deps) {
      try {
        const body = await readBoundedBody();
        const input = JSON.parse(body);
        if (!Array.isArray(input.items)) {
          res.writeHead(400, jsonHeaders());
          res.end(JSON.stringify({ error: 'items (array) required' }));
          return;
        }
        const result = await storeMemoryBatch(input.items, deps);
        res.writeHead(200, jsonHeaders());
        res.end(JSON.stringify(result));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'payload_too_large_handled') return; // 413 already written
        const stack = err instanceof Error ? err.stack : undefined;
        logger.warn('http', 'Batch store API failed', { error: msg, stack });
        if (!res.headersSent) {
          res.writeHead(500, jsonHeaders());
          res.end(JSON.stringify({ error: 'batch store failed', detail: msg }));
        }
      }
      return;
    }

    // SSE event stream endpoint
    if (url.pathname === '/events' && req.method === 'GET') {
      const sseHeaders: Record<string, string> = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      };
      if (allowedOrigin !== null) sseHeaders['Access-Control-Allow-Origin'] = allowedOrigin;
      res.writeHead(200, sseHeaders);

      const listener = (event: { type: string; data: unknown }): void => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      };

      eventBus.on('memory', listener);
      req.on('close', () => { eventBus.off('memory', listener); });
      res.write(': keepalive\n\n');
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  };
}

/**
 * Start an HTTP server with Streamable HTTP transport + search API.
 * Runs alongside stdio — enables remote MCP clients and hook consumption.
 */
export async function startHttpTransport(
  _server: McpServer,
  options: HttpTransportOptions,
  logger: Logger,
  deps?: HttpDeps,
): Promise<Server> {
  const handler = createRestRequestHandler(logger, deps);
  const httpServer = createHttpServer(handler);

  // NOTE: Do NOT call server.connect(transport) here — the MCP server is already
  // connected via stdio. The HTTP server provides REST API endpoints (/api/store,
  // /api/search, /events, /health) that call tool functions directly, not via MCP protocol.

  return new Promise((resolve) => {
    httpServer.listen(options.port, options.host, () => {
      logger.info('http', `HTTP API listening on ${options.host}:${options.port}`, {
        endpoints: {
          store: `http://${options.host}:${options.port}/api/store`,
          search: `http://${options.host}:${options.port}/api/search?q=...`,
          events: `http://${options.host}:${options.port}/events`,
          health: `http://${options.host}:${options.port}/health`,
        },
      });
      resolve(httpServer);
    });
  });
}
