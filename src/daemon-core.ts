/**
 * neuromcp daemon core.
 *
 * One long-running process exposes:
 *   - MCP Streamable HTTP transport on `/mcp` (multi-client, per-session).
 *   - REST/SSE endpoints (/health, /api/store, /api/search, /events).
 *
 * Each MCP-capable client (Claude Code, Claude Desktop, ChatGPT desktop, …)
 * points its config at `http://<host>:<port>/mcp`. They share a single DB
 * and a single embedding pipeline, so memory is consistent across clients.
 *
 * Two entrypoints load this core:
 *   - `daemon-bootstrap.ts` (used by `bin/neuromcp-daemon.mjs`): binds the
 *     port at process start and hands the listening server over via
 *     `DaemonBootstrapHandoff` — the boot-race fix. Preferred.
 *   - `daemon.ts`: direct start without early bind, kept for back-compat
 *     with configs that import `dist/daemon.js`.
 *
 * Configuration:
 *   - NEUROMCP_DAEMON_PORT   (default 3200)
 *   - NEUROMCP_DAEMON_HOST   (default 127.0.0.1 — bind only locally)
 *   - all existing NEUROMCP_* config still applies (DB path, log level, …).
 *
 * For the stdio-only mode, keep using the existing `neuromcp` binary
 * (`src/index.ts`). This daemon is a separate entrypoint.
 */
import { loadConfig } from './config.js';
import { createLogger } from './observability/logger.js';
import { createMetrics } from './observability/metrics.js';
import { openDatabase } from './storage/database.js';
import { runMigrations } from './storage/migrations.js';
import { SqliteVecStore } from './vectors/sqlite-vec.js';
import { createEmbeddingProvider } from './embeddings/factory.js';
import { validateEmbeddingCompatibility } from './embeddings/validate.js';
import { createRerankProvider } from './rerank/factory.js';
import { createServer } from './server.js';
import { startScheduler } from './scheduler.js';
import { startMcpHttpDaemon, type McpHttpDaemonDeps } from './transport/mcp-http-daemon.js';
import {
  readPortFromEnv,
  validateHost,
  type DaemonBootstrapHandoff,
} from './daemon-early-bind.js';
import { NEUROMCP_VERSION } from './version.js';

/**
 * Test seam for the early-bind boot-race tests and smoke checks: stretches
 * the pre-listen init window deterministically so a request can be fired
 * while the bootstrap is still buffering. No-op unless the env var is set.
 */
async function applyTestInitDelay(): Promise<void> {
  const raw = process.env.NEUROMCP_TEST_INIT_DELAY_MS;
  if (raw === undefined || raw === '') return;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runDaemon(handoff?: DaemonBootstrapHandoff): Promise<void> {
  await applyTestInitDelay();

  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, format: config.logFormat });
  const metrics = createMetrics();

  const port = readPortFromEnv('NEUROMCP_DAEMON_PORT', 3200);
  const host = process.env.NEUROMCP_DAEMON_HOST ?? '127.0.0.1';
  validateHost(host);

  logger.info('daemon', `Loading neuromcp daemon v${NEUROMCP_VERSION}`, {
    dbPath: config.dbPath,
    embeddingProvider: config.embeddingProvider,
    defaultNamespace: config.defaultNamespace,
    autoConsolidate: config.autoConsolidate,
    host,
    port,
  });

  const db = openDatabase(config.dbPath);
  runMigrations(db, config.dbPath, logger);

  const embedder = await createEmbeddingProvider(config, logger);
  // Fail loudly if the provider is incompatible with stored embeddings
  // (dimension or model mismatch silently corrupts recall otherwise).
  validateEmbeddingCompatibility(db, embedder, logger);
  const vecStore = new SqliteVecStore(embedder.dimensions);
  vecStore.initialize(db);
  const reranker = await createRerankProvider(config, logger);

  const deps: McpHttpDaemonDeps = { db, vecStore, embedder, config, logger, metrics, reranker };
  const stopScheduler = startScheduler(deps);

  // When the operator opted into a non-loopback bind via
  // NEUROMCP_DAEMON_INSECURE_NON_LOOPBACK=1, the public Host header that
  // clients send will not match the loopback allowlist. Forward the
  // configured host (and any user-supplied additions) so Host-header
  // checks pass for legitimate traffic to the public bind.
  const insecure = process.env.NEUROMCP_DAEMON_INSECURE_NON_LOOPBACK === '1';
  const extraAllowedHosts: string[] = [];
  if (insecure) {
    extraAllowedHosts.push(host.toLowerCase());
    const userExtra = process.env.NEUROMCP_DAEMON_EXTRA_ALLOWED_HOSTS;
    if (userExtra !== undefined && userExtra.length > 0) {
      for (const h of userExtra.split(',')) {
        const trimmed = h.trim().toLowerCase();
        if (trimmed.length > 0) extraAllowedHosts.push(trimmed);
      }
    }
  }

  const { shutdown } = await startMcpHttpDaemon(
    () => createServer(deps),
    { port, host, extraAllowedHosts, handoff },
    deps,
    logger,
  );

  let shuttingDown = false;
  const cleanup = (signal: string): void => {
    if (shuttingDown) {
      logger.info('daemon', 'shutdown already in progress, ignoring extra signal', { signal });
      return;
    }
    shuttingDown = true;
    logger.info('daemon', 'shutdown', { signal });
    stopScheduler();
    // Graceful: closes session transports + SSE sockets, then the server;
    // finally checkpoint + close the WAL DB so no committed data is lost.
    void shutdown()
      .catch((err: unknown) => {
        logger.warn('daemon', 'graceful shutdown error', { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        try { db.close(); } catch { /* already closed */ }
        process.exit(0);
      });
    // Hard exit after 5s if shutdown hangs.
    setTimeout(() => {
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    }, 5000).unref();
  };
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));
}
