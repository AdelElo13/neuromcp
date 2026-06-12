#!/usr/bin/env node
/**
 * neuromcp daemon entrypoint.
 *
 * One long-running process exposes:
 *   - MCP Streamable HTTP transport on `/mcp` (multi-client, per-session).
 *   - REST/SSE endpoints (/health, /api/store, /api/search, /events).
 *
 * Each MCP-capable client (Claude Code, Claude Desktop, ChatGPT desktop, …)
 * points its config at `http://<host>:<port>/mcp`. They share a single DB
 * and a single embedding pipeline, so memory is consistent across clients.
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
import { createServer } from './server.js';
import { startScheduler } from './scheduler.js';
import { startMcpHttpDaemon, type McpHttpDaemonDeps } from './transport/mcp-http-daemon.js';
import { NEUROMCP_VERSION } from './version.js';

function readPortFromEnv(name: string, fallback: number): number {
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

function validateHost(host: string): void {
  if (LOOPBACK_BIND_ADDRESSES.has(host.toLowerCase())) return;
  if (process.env.NEUROMCP_DAEMON_INSECURE_NON_LOOPBACK === '1') return;
  throw new Error(
    `Refusing to start neuromcp daemon on non-loopback host "${host}". ` +
      `The daemon is unauthenticated and trusts the loopback boundary. ` +
      `If you intentionally want a non-loopback bind (behind a reverse proxy ` +
      `with auth), set NEUROMCP_DAEMON_INSECURE_NON_LOOPBACK=1.`,
  );
}

async function main(): Promise<void> {
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

  const deps: McpHttpDaemonDeps = { db, vecStore, embedder, config, logger, metrics };
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

  const httpServer = await startMcpHttpDaemon(
    () => createServer(deps),
    { port, host, extraAllowedHosts },
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
    httpServer.close(() => {
      process.exit(0);
    });
    // Hard exit after 5s if close() hangs.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  process.stderr.write(`Fatal error: ${message}\n`);
  if (stack !== undefined) {
    process.stderr.write(`${stack}\n`);
  }
  process.exit(1);
});
