import type Database from 'better-sqlite3';
import type { Logger } from '../observability/logger.js';

/** Soft-delete a memory by setting is_deleted=1 and tombstoned_at=now. */
export function tombstone(db: Database.Database, id: string): void {
  db.prepare(
    'UPDATE memories SET is_deleted = 1, tombstoned_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\', \'now\') WHERE id = ?',
  ).run(id);
}

/** Soft-delete a memory and record which memory supersedes it (lineage tracking). */
export function tombstoneWithLineage(
  db: Database.Database,
  tombstoneId: string,
  supersededById: string,
): void {
  db.prepare(
    `UPDATE memories
       SET is_deleted = 1,
           tombstoned_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
           superseded_by_id = ?
     WHERE id = ?`,
  ).run(supersededById, tombstoneId);
}

/** Permanently delete tombstoned memories older than ttlDays. Returns count of purged rows. */
export function purgeTombstones(
  db: Database.Database,
  ttlDays: number,
  logger: Logger,
): number {
  const cutoff = new Date(Date.now() - ttlDays * 86_400_000).toISOString();
  const result = db
    .prepare(
      'DELETE FROM memories WHERE is_deleted = 1 AND tombstoned_at < ?',
    )
    .run(cutoff);

  const purged = result.changes;
  logger.info('tombstone', `Purged ${purged} tombstones older than ${ttlDays} days`, { ttlDays, purged });
  return purged;
}

/** Count soft-deleted memories. */
export function countTombstones(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM memories WHERE is_deleted = 1').get() as { count: number };
  return row.count;
}
