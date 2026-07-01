import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import {
  createServer as createHttpServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { NeuromcpConfig } from '../config.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import { createRestRequestHandler, type HttpDeps } from './http.js';
import { isAllowedHost, isAllowedOrigin } from './host-guard.js';

/** Result of starting the daemon: the server plus a graceful shutdown hook. */
export interface DaemonHandle {
  readonly server: Server;
  /**
   * Gracefully stop the daemon: close all MCP session transports, stop the
   * idle sweep, then close the HTTP server — destroying lingering sockets
   * (open SSE /events streams) that would otherwise pin httpServer.close()
   * until a hard-exit timer.
   */
  readonly shutdown: () => Promise<void>;
}

export interface McpHttpDaemonOptions {
  readonly port: number;
  readonly host: string;
  /**
   * Extra hosts to accept in the Host-header allowlist beyond loopback
   * (127.0.0.1, ::1, localhost). Typically empty. Daemon entrypoint
   * populates this with the configured bind host when the operator has
   * explicitly opted into a non-loopback bind via
   * `NEUROMCP_DAEMON_INSECURE_NON_LOOPBACK=1` (otherwise validateHost in
   * `src/daemon.ts` refuses to start). Without this, normal traffic to a
   * non-loopback bind hits 421 because the Host header is the public
   * hostname, not 127.0.0.1.
   */
  readonly extraAllowedHosts?: ReadonlyArray<string>;
}

export interface McpHttpDaemonDeps {
  readonly db: Database.Database;
  readonly vecStore: VectorStore;
  readonly embedder: EmbeddingProvider;
  readonly config: NeuromcpConfig;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly reranker?: import('../rerank/types.js').RerankProvider | null;
}

interface SessionState {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
  lastActivityAt: number;
  /**
   * Count of open GET-/mcp SSE streams for this session. The idle sweep
   * SKIPS sessions with activeStreams > 0 so a long-lived notification
   * subscriber that sends no POSTs is not reaped.
   */
  activeStreams?: number;
}

/**
 * Maximum request body size for POST /mcp in bytes. Anything larger is
 * rejected with 413 to avoid OOM via malformed/oversized payloads.
 * 8 MiB comfortably covers tool-call payloads (incl. large `store_memory`
 * content) without leaving the door open to abuse.
 */
const MAX_MCP_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Cap on concurrent MCP sessions. Far above the realistic steady-state of
 * a handful of MCP clients (Claude Code, Claude Desktop, ChatGPT desktop,
 * Cursor, …) — but bounded so a runaway client that never sends DELETE
 * and never closes cannot exhaust memory by spinning up sessions.
 */
const MAX_MCP_SESSIONS = 64;

/**
 * After this many milliseconds with no activity, a session is closed and
 * removed from the map. Necessary because POST /mcp is stateless: when a
 * client crashes or is restarted without sending `DELETE /mcp`, the socket
 * close does NOT trigger `transport.onclose` (the transport already
 * responded and detached from the request). Without an idle sweep the
 * session would persist until the daemon restarts, eventually saturating
 * the cap.
 */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * How often the daemon sweeps for idle sessions. Frequent enough that a
 * crashed client is reaped within a few minutes of the timeout firing,
 * infrequent enough that the sweep is essentially free.
 */
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute

function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let received = 0;
    let exceeded = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (exceeded) return;
      received += chunk.length;
      if (received > MAX_MCP_BODY_BYTES) {
        exceeded = true;
        // Write the 413 response BEFORE tearing down the socket. If we
        // destroy first, the client sees a connection reset instead of
        // the documented JSON error.
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'payload_too_large' },
            id: null,
          }));
        }
        reject(new Error('payload_too_large_handled'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (exceeded) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err: unknown) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}

function writeJsonError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: status === 400 ? -32000 : -32603, message },
      id: null,
    }),
  );
}

function getSessionIdHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers['mcp-session-id'];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * Start the unified neuromcp daemon HTTP server.
 *
 * Serves three URL families on a single port:
 *  - `POST/GET/DELETE /mcp` — MCP Streamable HTTP transport (stateful, per-session McpServer).
 *  - `GET /health`, `GET/POST /api/*`, `GET /events` — the existing REST/SSE surface.
 *  - Anything else — `404 not_found`.
 *
 * Multi-client friendly: every initialize request mints a fresh session id +
 * dedicated McpServer + dedicated transport. Sessions are kept in an in-memory
 * map keyed by session id; `onclose` removes them so the map cannot leak.
 *
 * `serverFactory` is called once per session; share DB / embedder via closure.
 *
 * Port-bind errors are surfaced as a rejected Promise (not an uncaught
 * 'error' event), so the caller can fall back or report gracefully.
 */
export async function startMcpHttpDaemon(
  serverFactory: () => McpServer,
  options: McpHttpDaemonOptions,
  deps: McpHttpDaemonDeps,
  logger: Logger,
): Promise<DaemonHandle> {
  const sessions = new Map<string, SessionState>();
  // In-flight initialize counter — reserved capacity that has not yet
  // been written into `sessions` because `onsessioninitialized` only
  // fires after `handleRequest`. Without this, concurrent initializes
  // can bypass MAX_MCP_SESSIONS.
  let pendingInits = 0;

  const extraAllowed: ReadonlySet<string> = new Set(
    (options.extraAllowedHosts ?? []).map((h) => h.toLowerCase()),
  );

  const restDeps: HttpDeps = {
    db: deps.db,
    vecStore: deps.vecStore,
    embedder: deps.embedder,
    config: deps.config,
    logger: deps.logger,
    metrics: deps.metrics,
  };
  // Forward the operator's extra allowed hosts so REST endpoints accept the
  // same non-loopback Host the outer /mcp guard does.
  const restHandler = createRestRequestHandler(logger, restDeps, extraAllowed);

  const handleMcpRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';

    // DELETE /mcp closes a session.
    if (method === 'DELETE') {
      const sid = getSessionIdHeader(req);
      if (!sid) {
        writeJsonError(res, 400, 'Bad Request: missing session id');
        return;
      }
      if (!sessions.has(sid)) {
        // Match the POST branch: 404 lets clients drop stale state.
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'session_not_found' },
          id: null,
        }));
        return;
      }
      const session = sessions.get(sid);
      sessions.delete(sid);
      if (session) {
        try {
          await session.transport.close();
        } catch (err: unknown) {
          logger.warn('mcp-http', 'transport.close threw on DELETE', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      res.writeHead(204).end();
      return;
    }

    // GET /mcp opens an SSE notifications stream; requires existing session.
    if (method === 'GET') {
      const sid = getSessionIdHeader(req);
      if (!sid) {
        writeJsonError(res, 400, 'Bad Request: missing session id');
        return;
      }
      if (!sessions.has(sid)) {
        // Match the POST branch: 404 lets SSE-reconnecting clients drop
        // stale state and re-initialize instead of treating it as 400.
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'session_not_found' },
          id: null,
        }));
        return;
      }
      const session = sessions.get(sid)!;
      session.lastActivityAt = Date.now();
      // A live SSE stream is silent traffic — the idle sweep would
      // otherwise close compliant clients that subscribe to
      // notifications but send no POSTs. Mark the session as actively
      // streaming for the duration of this request so the sweeper
      // skips it.
      session.activeStreams = (session.activeStreams ?? 0) + 1;
      const tick = setInterval(() => { session.lastActivityAt = Date.now(); }, 60_000);
      tick.unref();
      const releaseStream = (): void => {
        clearInterval(tick);
        if (session.activeStreams !== undefined) {
          session.activeStreams = Math.max(0, session.activeStreams - 1);
        }
        session.lastActivityAt = Date.now();
      };
      res.on('close', releaseStream);
      try {
        await session.transport.handleRequest(req, res);
      } catch (err: unknown) {
        logger.warn('mcp-http', 'GET /mcp handleRequest failed', {
          sid,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) writeJsonError(res, 500, 'internal_error');
      } finally {
        // Belt-and-braces in case 'close' did not fire.
        clearInterval(tick);
      }
      return;
    }

    // POST /mcp — main JSON-RPC transport.
    if (method !== 'POST') {
      writeJsonError(res, 405, 'Method Not Allowed');
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req, res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // `payload_too_large_handled` means readJsonBody already wrote the
      // 413 response before tearing down the socket. Anything else is a
      // parse error or transport error — return 400.
      if (msg !== 'payload_too_large_handled') {
        writeJsonError(res, 400, msg);
      }
      return;
    }

    const sid = getSessionIdHeader(req);

    if (sid && sessions.has(sid)) {
      const session = sessions.get(sid)!;
      session.lastActivityAt = Date.now();
      // Long-running tool calls (e.g. backfill_embeddings or
      // compress_memories on a large DB) can run for >30 minutes.
      // Without an in-flight marker, the idle sweep would mark the
      // session as expired and tear down the transport mid-flight.
      // Mark the session as "doing real work" for the duration of this
      // request and keep lastActivityAt fresh while it runs.
      session.activeStreams = (session.activeStreams ?? 0) + 1;
      const tick = setInterval(() => { session.lastActivityAt = Date.now(); }, 60_000);
      tick.unref();
      try {
        await session.transport.handleRequest(req, res, body);
      } catch (err: unknown) {
        logger.warn('mcp-http', 'POST /mcp existing-session handleRequest failed', {
          sid,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) writeJsonError(res, 500, 'internal_error');
      } finally {
        clearInterval(tick);
        if (session.activeStreams !== undefined) {
          session.activeStreams = Math.max(0, session.activeStreams - 1);
        }
        session.lastActivityAt = Date.now();
      }
      return;
    }

    // Stale session id (was valid before daemon restart / idle sweep, now gone).
    // The Streamable HTTP transport spec uses 404 for "session not found" —
    // 400 is reserved for "no session id, not an init request". Returning 404
    // lets compliant clients drop their stale state and reinitialize. Without
    // this they get the generic 400 and may get stuck retrying.
    if (sid && !sessions.has(sid)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'session_not_found' },
        id: null,
      }));
      return;
    }

    if (!sid && isInitializeRequest(body)) {
      // Cap concurrent sessions so a misbehaving or adversarial client
      // cannot exhaust memory by initialising without ever closing. We
      // RESERVE the slot before awaiting any async work — otherwise a
      // burst of concurrent initialize requests can all observe
      // `sessions.size` below the cap before any of them call
      // `onsessioninitialized` (which only fires after `handleRequest`).
      if (sessions.size + pendingInits >= MAX_MCP_SESSIONS) {
        logger.warn('mcp-http', 'session cap reached, rejecting initialize', {
          cap: MAX_MCP_SESSIONS,
          current: sessions.size,
          pending: pendingInits,
        });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'session_cap_reached' },
          id: null,
        }));
        return;
      }
      pendingInits++;
      let pendingReleased = false;
      const releasePending = (): void => {
        if (pendingReleased) return;
        pendingReleased = true;
        pendingInits--;
      };

      const server = serverFactory();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initSid: string) => {
          sessions.set(initSid, { transport, server, lastActivityAt: Date.now() });
          releasePending();
          logger.info('mcp-http', 'session initialized', { sid: initSid });
        },
      });
      transport.onclose = () => {
        // If the transport closes BEFORE onsessioninitialized fired (rare:
        // hard error during handleRequest), the pending counter would
        // leak. Release here as a backstop.
        releasePending();
        const closedSid = transport.sessionId;
        if (closedSid && sessions.has(closedSid)) {
          sessions.delete(closedSid);
          logger.info('mcp-http', 'session closed', { sid: closedSid });
        }
      };
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        // handleRequest may *normally* reject an initialize POST (bad
        // Accept header, wrong Content-Type, missing JSON-RPC id) by
        // writing a 4xx and returning without throwing AND without
        // calling onsessioninitialized. Without this guard, the
        // reserved pending slot would never be released and a malicious
        // or buggy client could DoS the daemon by sending 64 such
        // requests. If no session was created, release the slot and
        // close the transport.
        if (transport.sessionId === undefined) {
          releasePending();
          try {
            await transport.close();
          } catch (closeErr: unknown) {
            logger.warn('mcp-http', 'transport.close failed after rejected init', {
              error: closeErr instanceof Error ? closeErr.message : String(closeErr),
            });
          }
        }
      } catch (err: unknown) {
        logger.warn('mcp-http', 'POST /mcp initialize failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          await transport.close();
        } catch (closeErr: unknown) {
          logger.warn('mcp-http', 'transport.close failed during init-error cleanup', {
            error: closeErr instanceof Error ? closeErr.message : String(closeErr),
          });
        }
        releasePending();
        if (!res.headersSent) {
          writeJsonError(res, 500, 'internal_error');
        }
      }
      return;
    }

    writeJsonError(res, 400, 'Bad Request: No valid session ID provided');
  };

  // Pick the ACAO value to mirror for /mcp responses. /mcp is the MCP
  // Streamable HTTP transport; browser-based clients (e.g. an MCP
  // inspector served from another loopback port) will send a preflight
  // and read response headers including `mcp-session-id`.
  const pickMcpAcao = (originHeader: string | string[] | undefined): string | null => {
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (origin === undefined || origin === '') return null;
    try {
      const parsed = new URL(origin);
      const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (host === '127.0.0.1' || host === '::1' || host === 'localhost') return origin;
    } catch { /* malformed */ }
    return null;
  };

  const httpServer = createHttpServer(async (req, res) => {
    // DNS-rebinding guard. Any request whose Host header is not in the
    // allowlist is rejected up front, BEFORE routing or body parsing.
    if (!isAllowedHost(req.headers.host, extraAllowed)) {
      res.writeHead(421, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'misdirected_request' }));
      return;
    }

    // Belt-and-braces: even though isAllowedHost rejects malformed Host
    // headers, a hostile/buggy client could still craft a Host that
    // passes the allowlist but trips `new URL()` (e.g. via path edge
    // cases). Catch defensively so an unhandled throw cannot crash the
    // daemon.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request_uri' }));
      return;
    }
    if (url.pathname === '/mcp') {
      // MCP-spec Origin validation (defense-in-depth beyond the Host
      // guard): a browser-context request carrying a non-loopback Origin
      // is REJECTED outright — previously the Origin header only decided
      // which ACAO value to echo, so a non-preflighted request with a
      // hostile Origin sailed through as long as the Host header matched.
      if (!isAllowedOrigin(req.headers.origin, extraAllowed)) {
        writeJsonError(res, 403, 'forbidden_origin');
        return;
      }
      // CORS handling on /mcp itself. Without this, a browser-based MCP
      // client gets a preflight failure and a sessionId header it cannot
      // read. Loopback-only reflection — same policy as the REST handler.
      const mcpAcao = pickMcpAcao(req.headers.origin);
      if (req.method === 'OPTIONS') {
        const headers: Record<string, string> = {
          'Access-Control-Allow-Methods': 'GET, POST, DELETE',
          'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id, mcp-protocol-version',
          'Access-Control-Max-Age': '600',
        };
        if (mcpAcao !== null) headers['Access-Control-Allow-Origin'] = mcpAcao;
        res.writeHead(204, headers);
        res.end();
        return;
      }
      if (mcpAcao !== null) {
        res.setHeader('Access-Control-Allow-Origin', mcpAcao);
        // Browsers cannot read mcp-session-id by default — explicitly
        // expose it so JS clients can capture it on init.
        res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
      }
      try {
        await handleMcpRequest(req, res);
      } catch (err: unknown) {
        logger.warn('mcp-http', '/mcp top-level handler threw', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          writeJsonError(res, 500, 'internal_error');
        }
      }
      return;
    }
    await restHandler(req, res);
  });

  // Track open sockets so graceful shutdown can destroy lingering SSE
  // streams (GET /mcp, /events) that never close on their own and would
  // otherwise pin httpServer.close() until a hard-exit timer.
  const openSockets = new Set<Socket>();
  httpServer.on('connection', (socket: Socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  // Idle-session sweep. POST is stateless: when a crashed client never
  // sends DELETE, its session would otherwise persist until daemon restart.
  // We close idle transports here, which triggers their `onclose` handler
  // which removes them from the map.
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    const expired: Array<[string, SessionState]> = [];
    for (const entry of sessions) {
      const [, state] = entry;
      // Skip sessions with live SSE streams — a notification subscriber
      // that sends no POSTs is still active, not abandoned.
      if (state.activeStreams !== undefined && state.activeStreams > 0) continue;
      if (now - state.lastActivityAt > SESSION_IDLE_TIMEOUT_MS) {
        expired.push(entry);
      }
    }
    if (expired.length === 0) return;
    logger.info('mcp-http', 'sweeping idle sessions', { count: expired.length });
    for (const [sid, session] of expired) {
      session.transport.close().catch((err: unknown) => {
        logger.warn('mcp-http', 'transport.close failed during idle sweep', {
          sid,
          error: err instanceof Error ? err.message : String(err),
        });
        // Belt-and-braces: ensure the entry is removed even if close()
        // never triggers onclose.
        sessions.delete(sid);
      });
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweepInterval.unref();

  // Stop sweeping when the HTTP server is closed so the timer cannot
  // keep the event loop alive past shutdown.
  httpServer.on('close', () => clearInterval(sweepInterval));

  let shuttingDown = false;
  const shutdown = async (graceMs = 250): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(sweepInterval);
    // 1. Stop accepting NEW connections. In-flight requests keep their sockets
    //    and continue running — httpServer.close() only blocks new accepts.
    const closed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
    // 2. Free idle keep-alive connections immediately (they hold no in-flight
    //    request). Genuine in-flight requests are untouched here.
    httpServer.closeIdleConnections();
    // 3. Grace window: let in-flight MCP requests — e.g. a POST still awaiting
    //    a tool result on its SSE stream — FINISH before we touch their
    //    transports. The previous order closed transports first, which ended
    //    the active stream and cleared pending-response state mid-flight,
    //    truncating the request. Drain first, force second.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, graceMs);
      t.unref();
    });
    // 4. Now close the MCP session transports. They own the long-lived SSE
    //    streams that never end on their own and would otherwise pin
    //    httpServer.close() open until the hard-exit timer.
    await Promise.allSettled(
      [...sessions.values()].map((s) => s.transport.close()),
    );
    sessions.clear();
    // 5. Destroy whatever sockets survive (e.g. the /events SSE streams).
    for (const socket of openSockets) socket.destroy();
    openSockets.clear();
    await closed;
  };

  return new Promise<DaemonHandle>((resolve, reject) => {
    const onError = (err: Error): void => {
      httpServer.removeListener('listening', onListening);
      clearInterval(sweepInterval);
      reject(err);
    };
    const onListening = (): void => {
      httpServer.removeListener('error', onError);
      // Persistent handler so a post-listen accept error is logged rather
      // than crashing the daemon as an unhandled 'error' event.
      httpServer.on('error', (err: Error) => {
        logger.warn('mcp-http', 'daemon HTTP server error after listen', { error: err.message });
      });
      logger.info('mcp-http', 'neuromcp daemon listening', {
        mcp: `http://${options.host}:${options.port}/mcp`,
        rest: {
          health: `http://${options.host}:${options.port}/health`,
          search: `http://${options.host}:${options.port}/api/search?q=...`,
          store: `http://${options.host}:${options.port}/api/store`,
          events: `http://${options.host}:${options.port}/events`,
        },
        idleTimeoutMinutes: SESSION_IDLE_TIMEOUT_MS / 60000,
      });
      resolve({ server: httpServer, shutdown });
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(options.port, options.host);
  });
}
