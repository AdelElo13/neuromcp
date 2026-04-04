import { statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { NeuromcpConfig } from '../config.js';
import type { MemoryStats } from '../types.js';

export interface StatsInput {
  readonly namespace?: string;
}

export function memoryStats(
  input: StatsInput,
  db: Database.Database,
  embedder: EmbeddingProvider,
  config: NeuromcpConfig,
): MemoryStats {
  const namespace = input.namespace ?? config.defaultNamespace;
  const isAll = namespace === '*';

  const nsClause = isAll ? '1=1' : 'namespace = ?';
  const nsParams = isAll ? [] : [namespace];

  // Total active memories
  const totalRow = db
    .prepare(
      `SELECT COUNT(*) as count FROM memories WHERE is_deleted = 0 AND ${nsClause}`,
    )
    .get(...nsParams) as { count: number };

  // By category
  const catRows = db
    .prepare(
      `SELECT category, COUNT(*) as count FROM memories WHERE is_deleted = 0 AND ${nsClause} GROUP BY category`,
    )
    .all(...nsParams) as Array<{ category: string; count: number }>;
  const byCategory: Record<string, number> = {};
  for (const row of catRows) {
    byCategory[row.category] = row.count;
  }

  // By source
  const srcRows = db
    .prepare(
      `SELECT source, COUNT(*) as count FROM memories WHERE is_deleted = 0 AND ${nsClause} GROUP BY source`,
    )
    .all(...nsParams) as Array<{ source: string; count: number }>;
  const bySource: Record<string, number> = {};
  for (const row of srcRows) {
    bySource[row.source] = row.count;
  }

  // By trust
  const trustRows = db
    .prepare(
      `SELECT source_trust, COUNT(*) as count FROM memories WHERE is_deleted = 0 AND ${nsClause} GROUP BY source_trust`,
    )
    .all(...nsParams) as Array<{ source_trust: string; count: number }>;
  const byTrust: Record<string, number> = {};
  for (const row of trustRows) {
    byTrust[row.source_trust] = row.count;
  }

  // Avg importance
  const avgRow = db
    .prepare(
      `SELECT AVG(importance) as avg_imp FROM memories WHERE is_deleted = 0 AND ${nsClause}`,
    )
    .get(...nsParams) as { avg_imp: number | null };

  // Min/max created_at
  const rangeRow = db
    .prepare(
      `SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM memories WHERE is_deleted = 0 AND ${nsClause}`,
    )
    .get(...nsParams) as { oldest: string | null; newest: string | null };

  // DB file size
  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(config.dbPath).size;
  } catch {
    // file might not exist in tests
  }

  // Last consolidation from consolidation_log
  const lastConsRow = db
    .prepare(
      `SELECT MAX(created_at) as last_cons FROM consolidation_log`,
    )
    .get() as { last_cons: string | null };

  // Tombstone count
  const tombstoneRow = db
    .prepare(
      `SELECT COUNT(*) as count FROM memories WHERE is_deleted = 1`,
    )
    .get() as { count: number };

  return {
    total: totalRow.count,
    by_category: byCategory,
    by_source: bySource,
    by_trust: byTrust,
    avg_importance: avgRow.avg_imp ?? 0,
    oldest: rangeRow.oldest,
    newest: rangeRow.newest,
    embedding_model: embedder.name,
    db_size_bytes: dbSizeBytes,
    last_consolidation: lastConsRow.last_cons,
    tombstone_count: tombstoneRow.count,
  };
}
