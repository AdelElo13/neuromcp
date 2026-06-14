import type Database from 'better-sqlite3';
import type { Logger } from '../observability/logger.js';
import type { VectorStore } from '../vectors/types.js';

/** Soft-delete a memory by setting is_deleted=1 and tombstoned_at=now.
 *  Millisecond precision (%f) to match every other timestamp in the schema. */
export function tombstone(db: Database.Database, id: string): void {
  db.prepare(
    'UPDATE memories SET is_deleted = 1, tombstoned_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?',
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
           tombstoned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           superseded_by_id = ?
     WHERE id = ?`,
  ).run(supersededById, tombstoneId);
}

/**
 * Permanently delete tombstoned memories older than ttlDays. Returns count
 * of purged rows.
 *
 * Physical deletion has to clean up everything that hangs off a memory, in
 * one transaction, or it either fails outright or corrupts search:
 *  - the bare `DELETE FROM memories` used to violate the FK constraints from
 *    memory_entities / memory_clusters / claims, so purge permanently failed
 *    once the graph had linked entities;
 *  - and when it did succeed (no children), the external-content FTS5 row
 *    survived — SQLite recycles rowids, so a later memory could inherit the
 *    purged row's FTS entry and be served for the wrong search terms.
 *
 * Order matters: the FTS delete must run while the memories row still
 * exists, because external-content FTS5 reads the current column values to
 * remove its index entries.
 */
export function purgeTombstones(
  db: Database.Database,
  ttlDays: number,
  logger: Logger,
  vecStore?: VectorStore,
): number {
  const cutoff = new Date(Date.now() - ttlDays * 86_400_000).toISOString();
  const rows = db
    .prepare(
      'SELECT id, rowid FROM memories WHERE is_deleted = 1 AND tombstoned_at < ?',
    )
    .all(cutoff) as Array<{ id: string; rowid: number }>;

  if (rows.length === 0) {
    logger.info('tombstone', `Purged 0 tombstones older than ${ttlDays} days`, { ttlDays, purged: 0 });
    return 0;
  }

  const delEntities = db.prepare('DELETE FROM memory_entities WHERE memory_id = ?');
  const delClusters = db.prepare('DELETE FROM memory_clusters WHERE memory_id = ?');
  const delClaims = db.prepare('DELETE FROM claims WHERE memory_id = ?');
  const delCoRetrievals = db.prepare('DELETE FROM co_retrievals WHERE memory_a = ? OR memory_b = ?');
  const delUsefulness = db.prepare('DELETE FROM memory_usefulness WHERE memory_id = ?');
  // Recall/attribution join rows carry memory_id WITHOUT a FK to memories, so
  // they survive a memories DELETE and would let citeMemories() resurrect
  // usefulness for a purged id. Clean them here too.
  const delRetrievalJoin = db.prepare('DELETE FROM retrieval_event_memories WHERE memory_id = ?');
  const delCardEvidence = db.prepare('DELETE FROM semantic_card_evidence WHERE memory_id = ?');
  const delMemory = db.prepare('DELETE FROM memories WHERE id = ?');

  const purgeAll = db.transaction(() => {
    for (const row of rows) {
      delEntities.run(row.id);
      delClusters.run(row.id);
      delClaims.run(row.id);
      delCoRetrievals.run(row.id, row.id);
      delUsefulness.run(row.id);
      delRetrievalJoin.run(row.id);
      delCardEvidence.run(row.id);
      if (vecStore !== undefined) {
        vecStore.remove(row.id);
      }
      delMemory.run(row.id);
    }
    // Rebuild the external-content FTS index from the surviving memories
    // rows. Per-row DELETEs on an external-content FTS5 table corrupt the
    // index ("database disk image is malformed") whenever index and content
    // have drifted — which is exactly the legacy state this purge has to
    // tolerate. A rebuild is O(table) but purge runs are rare, and it is
    // self-healing: any pre-existing FTS desync is repaired as a side
    // effect.
    db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')").run();
  });
  purgeAll();

  const purged = rows.length;
  logger.info('tombstone', `Purged ${purged} tombstones older than ${ttlDays} days`, { ttlDays, purged });
  return purged;
}

/** Count soft-deleted memories. */
export function countTombstones(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM memories WHERE is_deleted = 1').get() as { count: number };
  return row.count;
}
