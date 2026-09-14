#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createLogger } from './observability/logger.js';
import { createMetrics } from './observability/metrics.js';
import { openDatabase } from './storage/database.js';
import { runMigrations } from './storage/migrations.js';
import { SqliteVecStore } from './vectors/sqlite-vec.js';
import { resolveEmbeddingRuntime } from './embeddings/runtime.js';
import { createRerankProvider } from './rerank/factory.js';
import { createServer } from './server.js';
import { startScheduler } from './scheduler.js';
import { startHttpTransport } from './transport/http.js';
import { NEUROMCP_VERSION } from './version.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, format: config.logFormat });
  const metrics = createMetrics();

  logger.info('startup', `Loading neuromcp v${NEUROMCP_VERSION}`, {
    dbPath: config.dbPath,
    embeddingProvider: config.embeddingProvider,
    defaultNamespace: config.defaultNamespace,
    autoConsolidate: config.autoConsolidate,
    httpEnabled: config.httpEnabled,
  });

  // Open database and run migrations
  const db = openDatabase(config.dbPath);
  runMigrations(db, config.dbPath, logger);

  // Resolve the embedding provider AGAINST the vector index that already
  // exists in this database: prefer the provider that matches it, retry a
  // briefly-unavailable one, and fall back to a degraded (FTS-only) start
  // instead of refusing to boot. See embeddings/runtime.ts.
  const { embedder } = await resolveEmbeddingRuntime(db, config, logger);

  // Initialize vector store
  const vecStore = new SqliteVecStore(embedder.dimensions);
  vecStore.initialize(db);

  // Optional cross-encoder reranker (v0.26). null on default 'none'.
  const reranker = await createRerankProvider(config, logger);

  // Create MCP server with all tools, resources, and prompts
  const server = createServer({ db, vecStore, embedder, config, logger, metrics, reranker });

  // Start auto-consolidation scheduler
  const stopScheduler = startScheduler({ db, vecStore, embedder, config, logger, metrics });

  // Connect via stdio transport (primary)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('startup', 'neuromcp MCP server running on stdio');

  // Optionally start HTTP transport (dual mode)
  if (config.httpEnabled) {
    try {
      await startHttpTransport(server, {
        port: config.httpPort,
        host: config.httpHost,
      }, logger, { db, vecStore, embedder, config, logger, metrics });
    } catch (err: unknown) {
      logger.warn('startup', 'HTTP transport failed to start, running stdio-only', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Cleanup on exit
  const cleanup = (): void => {
    stopScheduler();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
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
