/**
 * Early port bind for the neuromcp daemon — boot-race fix.
 *
 * Problem this solves: on cold boot the daemon spent ~100s loading its
 * module graph (better-sqlite3, MCP SDK, embeddings probe, …) BEFORE
 * binding its port. Every MCP client that connected in that window got
 * ECONNREFUSED — Claude Code connects over plain HTTP with no wait/retry
 * wrapper and surfaced "Could not attach to MCP server neuromcp".
 *
 * `startEarlyBind` owns the TCP port within milliseconds of process start:
 *   - `GET /health` answers `503 {"status":"starting"}` so pollers
 *     (mcp-remote-wait.sh uses `curl -sf`) keep waiting instead of failing.
 *   - Every other request is buffered — bounded queue, per-request hold
 *     timeout — and replayed into the real handler once the heavy daemon
 *     core has loaded and called `takeover()`.
 *
 * CONSTRAINT: this module must stay dependency-free (node builtins only).
 * Importing anything from the daemon's module graph here would reintroduce
 * the exact slow-load window it exists to hide.
 */
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';

export type BootstrapRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

/** Contract between the bootstrap and the daemon core it hands the server to. */
export interface DaemonBootstrapHandoff {
  /** The already-listening HTTP server whose port was bound at process start. */
  readonly server: Server;
  /**
   * Live sockets tracked since the first accept. The daemon core reuses this
   * set for graceful shutdown so sockets accepted BEFORE takeover are not
   * invisible to it.
   */
  readonly sockets: Set<Socket>;
  /**
   * Swap the bootstrap's queueing dispatcher for the real request handler
   * and replay all buffered requests into it, FIFO.
   */
  readonly takeover: (handler: BootstrapRequestHandler) => void;
}

export interface DaemonCoreModule {
  runDaemon(handoff: DaemonBootstrapHandoff): Promise<void>;
}

export interface EarlyBindOptions {
  readonly port: number;
  readonly host: string;
  /** Typically `() => import('./daemon-core.js')`; injectable for tests. */
  readonly importCore: () => Promise<DaemonCoreModule>;
  /** Max requests held while the core loads; beyond this → immediate 503. */
  readonly queueLimit?: number;
  /** Max time a request may wait for the core before it gets a 503. */
  readonly holdTimeoutMs?: number;
}

export interface EarlyBindHandle {
  readonly server: Server;
  /**
   * Resolves once the core has loaded and taken over. Rejects — after the
   * queue is flushed with 503 and the server is closed — when the core
   * fails to load or start.
   */
  readonly core: Promise<void>;
  /** Flush queued requests with 503, close the server, destroy sockets. */
  readonly shutdown: () => Promise<void>;
}

const DEFAULT_QUEUE_LIMIT = 64;
const DEFAULT_HOLD_TIMEOUT_MS = 120_000;

/**
 * Env parsing + bind-host validation live here (not in the daemon core)
 * because the bootstrap must resolve port/host BEFORE the heavy module
 * graph loads. The core reuses these so both entries stay in lockstep.
 */
export function readPortFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid ${name}: "${raw}" — must be an integer between 1 and 65535`);
  }
  return parsed;
}

/**
 * Hosts the daemon is allowed to bind to. The daemon has NO authentication —
 * it relies on the loopback boundary to keep memories private. Binding to
 * `0.0.0.0` or a LAN address would expose unauthenticated MCP + REST APIs to
 * the network. The downstream Host-header allowlist does not protect this
 * case: an attacker on the LAN can simply send `Host: 127.0.0.1` themselves.
 *
 * Escape hatch: `NEUROMCP_DAEMON_INSECURE_NON_LOOPBACK=1` allows a non-loopback
 * bind. Use only behind a separate auth layer (reverse proxy + auth).
 */
const LOOPBACK_BIND_ADDRESSES: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  'localhost',
]);

export function validateHost(host: string): void {
  if (LOOPBACK_BIND_ADDRESSES.has(host.toLowerCase())) return;
  if (process.env.NEUROMCP_DAEMON_INSECURE_NON_LOOPBACK === '1') return;
  throw new Error(
    `Refusing to start neuromcp daemon on non-loopback host "${host}". ` +
      `The daemon is unauthenticated and trusts the loopback boundary. ` +
      `If you intentionally want a non-loopback bind (behind a reverse proxy ` +
      `with auth), set NEUROMCP_DAEMON_INSECURE_NON_LOOPBACK=1.`,
  );
}

interface QueuedRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly holdTimer: NodeJS.Timeout;
}

function writeStarting(res: ServerResponse): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
  res.end(JSON.stringify({ status: 'starting' }));
}

export function startEarlyBind(options: EarlyBindOptions): Promise<EarlyBindHandle> {
  const queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
  const holdTimeoutMs = options.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS;

  const sockets = new Set<Socket>();
  const queue: QueuedRequest[] = [];
  let takenOver = false;

  const dropFromQueue = (res: ServerResponse): void => {
    const idx = queue.findIndex((q) => q.res === res);
    if (idx === -1) return;
    clearTimeout(queue[idx]!.holdTimer);
    queue.splice(idx, 1);
  };

  const queueingHandler: BootstrapRequestHandler = (req, res) => {
    // Health probes get an immediate "starting" so pollers keep waiting.
    // Path-prefix match is enough here: the real router takes over for
    // anything more precise once the core is up.
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      writeStarting(res);
      return;
    }
    if (queue.length >= queueLimit) {
      writeStarting(res);
      return;
    }
    const holdTimer = setTimeout(() => {
      dropFromQueue(res);
      writeStarting(res);
    }, holdTimeoutMs);
    holdTimer.unref();
    queue.push({ req, res, holdTimer });
    // Client gave up while queued — drop it so replay never touches a
    // dead response.
    res.on('close', () => dropFromQueue(res));
  };

  let handler: BootstrapRequestHandler = queueingHandler;

  const flushQueue = (): void => {
    for (const q of queue.splice(0)) {
      clearTimeout(q.holdTimer);
      writeStarting(q.res);
    }
  };

  const takeover = (nextHandler: BootstrapRequestHandler): void => {
    if (takenOver) {
      throw new Error('bootstrap takeover called twice');
    }
    takenOver = true;
    handler = nextHandler;
    for (const q of queue.splice(0)) {
      clearTimeout(q.holdTimer);
      if (q.res.destroyed || q.res.writableEnded) continue;
      // Same semantics as a live 'request' event: fire-and-forget; a
      // rejecting async handler surfaces as an unhandledRejection exactly
      // like it would for non-replayed traffic.
      void handler(q.req, q.res);
    }
  };

  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const handoff: DaemonBootstrapHandoff = { server, sockets, takeover };

  const closeServer = (): Promise<void> =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    });

  const shutdown = async (): Promise<void> => {
    flushQueue();
    await closeServer();
  };

  return new Promise<EarlyBindHandle>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      // Post-listen accept errors must not crash the process as an
      // unhandled 'error' event; the core installs its own logger-backed
      // handler on takeover.
      server.on('error', (err: Error) => {
        process.stderr.write(`neuromcp bootstrap: server error: ${err.message}\n`);
      });
      const core = (async (): Promise<void> => {
        const mod = await options.importCore();
        await mod.runDaemon(handoff);
      })().catch(async (err: unknown) => {
        // Core never came up: answer whoever is still waiting, release the
        // port, and let the caller decide (entrypoint exits non-zero so
        // launchd sees the failure).
        flushQueue();
        if (!takenOver) {
          await closeServer();
        }
        throw err instanceof Error ? err : new Error(String(err));
      });
      resolve({ server, core, shutdown });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, options.host);
  });
}
