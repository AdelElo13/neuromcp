import { createServer as createHttpServer, type Server } from 'node:http';
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
 * Start an HTTP server with Streamable HTTP transport + search API.
 * Runs alongside stdio — enables remote MCP clients and hook consumption.
 */
export async function startHttpTransport(
  server: McpServer,
  options: HttpTransportOptions,
  logger: Logger,
  deps?: HttpDeps,
): Promise<Server> {
  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // CORS preflight — permissive because server binds to 127.0.0.1 only (not externally accessible)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return;
    }

    // Health endpoint
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: pkg.version }));
      return;
    }

    // Search API — lightweight endpoint for hooks / auto-context injection
    if (url.pathname === '/api/search' && req.method === 'GET' && deps) {
      const query = url.searchParams.get('q') ?? '';
      const namespace = url.searchParams.get('namespace') ?? deps.config.defaultNamespace;
      const limit = Math.min(20, parseInt(url.searchParams.get('limit') ?? '5', 10));

      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'q parameter required' }));
        return;
      }

      try {
        const results = await searchMemory(
          { query, namespace, limit, hybrid: true },
          deps,
        );

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'search failed' }));
      }
      return;
    }

    // Store API — enables hooks to use the full store pipeline (dedup, contradiction, embeddings, claims)
    if (url.pathname === '/api/store' && req.method === 'POST' && deps) {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const input = JSON.parse(body);
          if (!input.content || typeof input.content !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'content (string) required' }));
            return;
          }
          const result = await storeMemory(input, deps);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(result));
        } catch (err: unknown) {
          logger.warn('http', 'Store API failed', { error: err instanceof Error ? err.message : String(err) });
          res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'store failed' }));
        }
      });
      return;
    }

    // SSE event stream endpoint
    if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

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
  });

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
