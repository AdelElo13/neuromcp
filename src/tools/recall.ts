import type Database from 'better-sqlite3';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { NeuromcpConfig } from '../config.js';
import type { Memory } from '../types.js';

export interface RecallInput {
  readonly id?: string;
  readonly namespace?: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly limit?: number;
}

export function recallMemory(
  input: RecallInput,
  db: Database.Database,
  config: NeuromcpConfig,
  logger: Logger,
  metrics: Metrics,
): readonly Memory[] {
  const start = Date.now();
  const limit = input.limit ?? 20;
  const namespace = input.namespace ?? config.defaultNamespace;

  const conditions: string[] = ['is_deleted = 0'];
  const params: unknown[] = [];

  // Namespace filter ('*' means all)
  if (namespace !== '*') {
    conditions.push('namespace = ?');
    params.push(namespace);
  }

  if (input.id !== undefined) {
    conditions.push('id = ?');
    params.push(input.id);
  }

  if (input.category !== undefined) {
    conditions.push('category = ?');
    params.push(input.category);
  }

  const sql = `SELECT * FROM memories WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Memory[];

  // Post-filter by tags (all requested tags must be present)
  const filtered =
    input.tags !== undefined && input.tags.length > 0
      ? rows.filter((row) => {
          const memTags: string[] = JSON.parse(row.tags);
          return input.tags!.every((t) => memTags.includes(t));
        })
      : rows;

  // Bump access_count and last_accessed_at for returned memories
  if (filtered.length > 0) {
    const bumpStmt = db.prepare(
      "UPDATE memories SET access_count = access_count + 1, last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    );
    const bumpAll = db.transaction(() => {
      for (const row of filtered) {
        bumpStmt.run(row.id);
      }
    });
    bumpAll();
  }

  logger.info('recall', 'recall complete', {
    results: filtered.length,
    namespace,
  });
  metrics.increment('recall.queries');
  metrics.record('recall.results', filtered.length);
  metrics.record('recall.duration_ms', Date.now() - start);

  return filtered;
}
