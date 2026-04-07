import type Database from 'better-sqlite3';
import type { ProposedSweep, ProposedPrune } from '../types.js';

/**
 * Finds active memories that have passed their expires_at timestamp.
 */
export function findExpired(
  db: Database.Database,
  namespace: string,
): readonly ProposedSweep[] {
  const isAll = namespace === '*';
  const nsClause = isAll ? '1=1' : 'namespace = ?';
  const nsParams = isAll ? [] : [namespace];

  const now = new Date().toISOString();

  const rows = db
    .prepare(
      `SELECT id, expires_at FROM memories
       WHERE is_deleted = 0
         AND expires_at IS NOT NULL
         AND expires_at < ?
         AND ${nsClause}`,
    )
    .all(now, ...nsParams) as Array<{ id: string; expires_at: string }>;

  return rows.map((row) => ({
    id: row.id,
    expired_at: row.expires_at,
  }));
}

/**
 * Finds memories not accessed in staleDays+ days.
 * These are candidates for auto-pruning — knowledge that hasn't been
 * useful to any search in a long time is likely stale.
 *
 * Uses last_accessed_at (falls back to created_at if never accessed).
 * Only prunes memories with low importance (< 0.3) to avoid deleting
 * important-but-rarely-queried memories.
 */
export function findStale(
  db: Database.Database,
  namespace: string,
  staleDays: number = 90,
  maxImportance: number = 0.3,
): readonly ProposedPrune[] {
  const isAll = namespace === '*';
  const nsClause = isAll ? '1=1' : 'namespace = ?';
  const nsParams = isAll ? [] : [namespace];

  const rows = db
    .prepare(
      `SELECT id, importance, access_count,
              COALESCE(last_accessed_at, created_at) as last_touch,
              julianday('now') - julianday(COALESCE(last_accessed_at, created_at)) as days_stale
       FROM memories
       WHERE is_deleted = 0
         AND importance < ?
         AND julianday('now') - julianday(COALESCE(last_accessed_at, created_at)) > ?
         AND ${nsClause}`,
    )
    .all(maxImportance, staleDays, ...nsParams) as Array<{
      id: string;
      importance: number;
      access_count: number;
      days_stale: number;
    }>;

  return rows.map((row) => ({
    id: row.id,
    importance: row.importance,
    access_count: row.access_count,
    age_days: Math.round(row.days_stale),
    reason: `stale: not accessed in ${Math.round(row.days_stale)} days, importance ${row.importance.toFixed(3)}`,
  }));
}
