import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { NeuromcpConfig } from '../config.js';
import type { ForgetResult } from '../types.js';
import { tombstone } from '../governance/tombstone.js';

export interface ForgetInput {
  readonly id?: string;
  readonly namespace?: string;
  readonly tags?: readonly string[];
  readonly older_than_days?: number;
  readonly below_importance?: number;
  readonly dry_run?: boolean;
}

export function forgetMemory(
  input: ForgetInput,
  db: Database.Database,
  vecStore: VectorStore,
  config: NeuromcpConfig,
  logger: Logger,
  metrics: Metrics,
): ForgetResult {
  const start = Date.now();
  const dryRun = input.dry_run ?? false;

  // At least one filter is required
  const hasFilter =
    input.id !== undefined ||
    input.namespace !== undefined ||
    (input.tags !== undefined && input.tags.length > 0) ||
    input.older_than_days !== undefined ||
    input.below_importance !== undefined;

  if (!hasFilter) {
    throw new Error(
      'forgetMemory requires at least one filter (id, namespace, tags, older_than_days, or below_importance)',
    );
  }

  const conditions: string[] = ['is_deleted = 0'];
  const params: unknown[] = [];

  if (input.id !== undefined) {
    conditions.push('id = ?');
    params.push(input.id);
  }

  if (input.namespace !== undefined) {
    conditions.push('namespace = ?');
    params.push(input.namespace);
  }

  if (input.older_than_days !== undefined) {
    const cutoff = new Date(
      Date.now() - input.older_than_days * 86_400_000,
    ).toISOString();
    conditions.push('created_at < ?');
    params.push(cutoff);
  }

  if (input.below_importance !== undefined) {
    conditions.push('importance < ?');
    params.push(input.below_importance);
  }

  const sql = `SELECT id, tags FROM memories WHERE ${conditions.join(' AND ')}`;
  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    tags: string;
  }>;

  // Post-filter by tags
  const matched =
    input.tags !== undefined && input.tags.length > 0
      ? rows.filter((row) => {
          const memTags: string[] = JSON.parse(row.tags);
          return input.tags!.every((t) => memTags.includes(t));
        })
      : rows;

  const ids = matched.map((r) => r.id);

  if (!dryRun && ids.length > 0) {
    const operationId = randomBytes(16).toString('hex');

    const runDelete = db.transaction(() => {
      for (const id of ids) {
        tombstone(db, id);
        vecStore.remove(id);

        // Log to consolidation_log
        const logId = randomBytes(16).toString('hex');
        db.prepare(
          `INSERT INTO consolidation_log (id, operation_id, action, source_ids, result_id, reason, namespace)
           VALUES (?, ?, 'tombstone', ?, NULL, 'forget', ?)`,
        ).run(logId, operationId, JSON.stringify([id]), input.namespace ?? null);
      }
    });
    runDelete();

    logger.info('forget', 'memories deleted', {
      count: ids.length,
      operationId,
    });
    metrics.increment('forget.deleted', ids.length);
  }

  metrics.record('forget.duration_ms', Date.now() - start);

  return { count: ids.length, ids, dry_run: dryRun };
}
