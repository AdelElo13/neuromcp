import type Database from 'better-sqlite3';
import type { VectorStore } from './vectors/types.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import type { NeuromcpConfig } from './config.js';
import type { Logger } from './observability/logger.js';
import type { Metrics } from './observability/metrics.js';
import { consolidate } from './tools/consolidate.js';
import { compressMemories } from './consolidation/compress.js';
import { purgeTombstones } from './governance/tombstone.js';

export interface SchedulerDeps {
  readonly db: Database.Database;
  readonly vecStore: VectorStore;
  readonly embedder: EmbeddingProvider;
  readonly config: NeuromcpConfig;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

/**
 * Starts the auto-consolidation scheduler.
 * Runs consolidation + tombstone purge on a configurable interval.
 * Returns a cleanup function to stop the scheduler.
 */
export function startScheduler(deps: SchedulerDeps): () => void {
  const { db, vecStore, embedder, config, logger, metrics } = deps;

  if (!config.autoConsolidate) {
    logger.info('scheduler', 'Auto-consolidation disabled');
    return () => {};
  }

  const intervalMs = config.consolidateIntervalHours * 3_600_000;

  logger.info('scheduler', 'Auto-consolidation enabled', {
    intervalHours: config.consolidateIntervalHours,
    sweepIntervalHours: config.sweepIntervalHours,
  });

  const runCycle = async (): Promise<void> => {
    try {
      logger.info('scheduler', 'Starting auto-consolidation cycle');

      // Run consolidation with commit=true (sync: dedup + decay + prune + sweep + PageRank + importance refresh)
      const output = consolidate(
        { commit: true, namespace: '*' },
        db, vecStore, embedder, config, logger, metrics,
      );

      if (output.type === 'result') {
        logger.info('scheduler', 'Auto-consolidation complete', {
          merged: output.result.merged,
          decayed: output.result.decayed,
          pruned: output.result.pruned,
          swept: output.result.swept,
        });
      }

      // Compress old memories into digests (async: requires embeddings)
      try {
        const compression = await compressMemories(db, embedder, vecStore, '*');
        if (compression.digests_created > 0 || compression.memories_hard_deleted > 0) {
          logger.info('scheduler', 'Compression complete', {
            digests: compression.digests_created,
            compressed: compression.memories_compressed,
            hardDeleted: compression.memories_hard_deleted,
          });
        }
      } catch (compressErr: unknown) {
        const msg = compressErr instanceof Error ? compressErr.message : String(compressErr);
        logger.warn('scheduler', 'Compression failed', { error: msg });
      }

      // Purge old tombstones
      const purged = purgeTombstones(db, config.tombstoneTtlDays, logger);
      if (purged > 0) {
        logger.info('scheduler', 'Tombstone purge complete', { purged });
      }

      metrics.increment('scheduler.cycles');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('scheduler', 'Auto-consolidation failed', { error: message });
      metrics.increment('scheduler.errors');
    }
  };

  // Run once at startup (delayed by 30s to let server initialize)
  const startupTimeout = setTimeout(() => void runCycle(), 30_000);

  // Then run on interval
  const interval = setInterval(() => void runCycle(), intervalMs);

  return () => {
    clearTimeout(startupTimeout);
    clearInterval(interval);
    logger.info('scheduler', 'Scheduler stopped');
  };
}
