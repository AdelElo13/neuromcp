import type Database from 'better-sqlite3';
import type { ProposedSweep } from '../types.js';

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
