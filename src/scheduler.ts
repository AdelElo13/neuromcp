import type Database from 'better-sqlite3';
import type { VectorStore } from './vectors/types.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import type { NeuromcpConfig } from './config.js';
import type { Logger } from './observability/logger.js';
import type { Metrics } from './observability/metrics.js';
import { consolidate } from './tools/consolidate.js';
import { compressMemories } from './consolidation/compress.js';
import { mergeEntitiesInNamespace } from './consolidation/entity-merge.js';
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
      const purged = purgeTombstones(db, config.tombstoneTtlDays, logger, vecStore);
      if (purged > 0) {
        logger.info('scheduler', 'Tombstone purge complete', { purged });
      }

      // sprint4: cross-row entity dedup. Walks every namespace that has
      // entities and merges aliases within each. Opt-in via env to keep
      // existing deployments side-effect free until reviewed.
      if (process.env.NEUROMCP_ENTITY_MERGE === '1') {
        try {
          const namespaces = (
            db.prepare(
              'SELECT DISTINCT namespace FROM entities WHERE is_deleted = 0',
            ).all() as Array<{ namespace: string }>
          ).map((r) => r.namespace);
          let totalMerged = 0;
          for (const ns of namespaces) {
            const r = mergeEntitiesInNamespace(db, ns);
            totalMerged += r.merged;
          }
          if (totalMerged > 0) {
            logger.info('scheduler', 'Entity merge complete', {
              merged: totalMerged,
              namespaces: namespaces.length,
            });
          }
        } catch (mergeErr: unknown) {
          const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
          logger.warn('scheduler', 'Entity merge failed', { error: msg });
        }
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
