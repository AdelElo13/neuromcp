#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createLogger } from './observability/logger.js';
import { createMetrics } from './observability/metrics.js';
import { openDatabase } from './storage/database.js';
import { runMigrations } from './storage/migrations.js';
import { SqliteVecStore } from './vectors/sqlite-vec.js';
import { createEmbeddingProvider } from './embeddings/factory.js';
import { createServer } from './server.js';
import { startScheduler } from './scheduler.js';
import { startHttpTransport } from './transport/http.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, format: config.logFormat });
  const metrics = createMetrics();

  logger.info('startup', 'Loading neuromcp v0.17.7', {
    dbPath: config.dbPath,
    embeddingProvider: config.embeddingProvider,
    defaultNamespace: config.defaultNamespace,
    autoConsolidate: config.autoConsolidate,
    httpEnabled: config.httpEnabled,
  });

  // Open database and run migrations
  const db = openDatabase(config.dbPath);
  runMigrations(db, config.dbPath, logger);

  // Initialize embedding provider
  const embedder = await createEmbeddingProvider(config, logger);

  // Initialize vector store
  const vecStore = new SqliteVecStore(embedder.dimensions);
  vecStore.initialize(db);

  // Create MCP server with all tools, resources, and prompts
  const server = createServer({ db, vecStore, embedder, config, logger, metrics });

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
