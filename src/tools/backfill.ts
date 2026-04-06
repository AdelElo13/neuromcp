import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { BackfillResult } from '../types.js';

/**
 * Backfill embeddings for all memories that are missing from the vector store.
 * Also syncs missing FTS entries.
 */
export async function backfillEmbeddings(
  db: Database.Database,
  vecStore: VectorStore,
  embedder: EmbeddingProvider,
  logger: Logger,
  metrics: Metrics,
): Promise<BackfillResult> {
  const start = Date.now();

  // Find all active memories
  const allMemories = db
    .prepare('SELECT id, content, category, tags FROM memories WHERE is_deleted = 0')
    .all() as Array<{ id: string; content: string; category: string; tags: string }>;

  // Find which ones already have embeddings
  const existingVecs = new Set<string>();
  const vecRows = db.prepare('SELECT id FROM memories_vec').all() as Array<{ id: string }>;
  for (const row of vecRows) {
    existingVecs.add(row.id);
  }

  const missing = allMemories.filter((m) => !existingVecs.has(m.id));

  logger.info('backfill', 'Starting embedding backfill', {
    total: allMemories.length,
    missing: missing.length,
    existing: existingVecs.size,
  });

  let embedded = 0;
  let errors = 0;

  // Process in batches of 10
  const batchSize = 10;
  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    const texts = batch.map((m) => m.content);

    try {
      const embeddings = await embedder.embedBatch(texts);
      const entries = batch.map((m, idx) => ({
        id: m.id,
        embedding: embeddings[idx]!,
      }));

      vecStore.upsertBatch(entries);

      // Also update embedding_model and embedding_dim in memories table
      const updateStmt = db.prepare(
        "UPDATE memories SET embedding_model = ?, embedding_dim = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      );
      const updateAll = db.transaction(() => {
        for (const m of batch) {
          updateStmt.run(embedder.name, embedder.dimensions, m.id);
        }
      });
      updateAll();

      // Sync FTS entries for any missing ones
      for (const m of batch) {
        const ftsExists = db
          .prepare(
            'SELECT rowid FROM memories_fts WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)',
          )
          .get(m.id);

        if (ftsExists === undefined) {
          const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(m.id) as { rowid: number } | undefined;
          if (row !== undefined) {
            try {
              db.prepare(
                'INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, ?, ?)',
              ).run(row.rowid, m.content, m.tags, m.category);
            } catch {
              // FTS entry may already exist
            }
          }
        }
      }

      embedded += batch.length;
      logger.debug('backfill', `Embedded batch ${i / batchSize + 1}`, {
        batchSize: batch.length,
        progress: `${embedded}/${missing.length}`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('backfill', 'Batch embedding failed', {
        batchStart: i,
        error: message,
      });
      errors += batch.length;
    }
  }

  metrics.record('backfill.duration_ms', Date.now() - start);
  metrics.increment('backfill.embedded', embedded);
  metrics.increment('backfill.errors', errors);

  logger.info('backfill', 'Backfill complete', {
    total: allMemories.length,
    embedded,
    skipped: existingVecs.size,
    errors,
  });

  return {
    total: allMemories.length,
    embedded,
    skipped: existingVecs.size,
    errors,
  };
}
