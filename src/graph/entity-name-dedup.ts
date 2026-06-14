/**
 * entity-name-dedup.ts — one-time destructive migration for the v0.26
 * canonical-key fix.
 *
 * Pre-v0.26 `upsertEntity` keyed on (LOWER(name), entity_type, namespace),
 * so the same real-world entity accumulated one row per extractor-assigned
 * type ("NeuroMCP" as project + concept + tool). v0.26 drops entity_type
 * from the key for NEW writes; this pass merges the duplicates that already
 * exist.
 *
 * Winner selection per duplicate group (same LOWER(TRIM(name)) + namespace):
 *   most memory_entities links wins; ties go to the oldest row (it has the
 *   longest provenance). Losers' memory links and relations are re-pointed
 *   to the winner, then the losers are soft-deleted (tombstoned, not
 *   physically removed — reversible by hand if a merge was wrong).
 *
 * DESTRUCTIVE in the sense that the merge collapses rows; always run with
 * dryRun: true first and review the proposed plan (the CLI wrapper in
 * scripts/ defaults to dry-run).
 */
import type Database from 'better-sqlite3';

export interface NameDedupPair {
  readonly key: string; // LOWER(TRIM(name)) + '@' + namespace
  readonly winnerId: string;
  readonly winnerName: string;
  readonly winnerType: string;
  readonly loserId: string;
  readonly loserType: string;
}

export interface NameDedupResult {
  readonly proposed: readonly NameDedupPair[];
  readonly merged: number;
  readonly relinked_memory_entities: number;
  readonly relinked_relations: number;
}

interface EntityRow {
  readonly id: string;
  readonly name: string;
  readonly entity_type: string;
  readonly namespace: string;
  readonly created_at: string;
  readonly link_count: number;
}

export function mergeDuplicateEntityNames(
  db: Database.Database,
  options: { dryRun?: boolean } = {},
): NameDedupResult {
  const dryRun = options.dryRun ?? true;

  const rows = db
    .prepare(
      `SELECT e.id, e.name, e.entity_type, e.namespace, e.created_at,
              (SELECT COUNT(*) FROM memory_entities me WHERE me.entity_id = e.id) AS link_count
         FROM entities e
        WHERE e.is_deleted = 0
        ORDER BY e.namespace, LOWER(TRIM(e.name))`,
    )
    .all() as EntityRow[];

  // Group on the canonical key
  const groups = new Map<string, EntityRow[]>();
  for (const row of rows) {
    const key = `${row.name.trim().toLowerCase()}@${row.namespace}`;
    const arr = groups.get(key) ?? [];
    arr.push(row);
    groups.set(key, arr);
  }

  const proposed: NameDedupPair[] = [];
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    // Winner: most links; tie → oldest created_at
    const sorted = [...members].sort((a, b) => {
      if (b.link_count !== a.link_count) return b.link_count - a.link_count;
      return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
    });
    const winner = sorted[0]!;
    for (const loser of sorted.slice(1)) {
      proposed.push({
        key,
        winnerId: winner.id,
        winnerName: winner.name,
        winnerType: winner.entity_type,
        loserId: loser.id,
        loserType: loser.entity_type,
      });
    }
  }

  if (dryRun || proposed.length === 0) {
    return { proposed, merged: 0, relinked_memory_entities: 0, relinked_relations: 0 };
  }

  let relinked = 0;
  let relinkedRelations = 0;
  const tx = db.transaction(() => {
    const relinkStmt = db.prepare(
      `INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, role)
       SELECT memory_id, ?, role FROM memory_entities WHERE entity_id = ?`,
    );
    const dropOldLinksStmt = db.prepare('DELETE FROM memory_entities WHERE entity_id = ?');
    const repointSourceStmt = db.prepare(
      'UPDATE relations SET source_entity_id = ? WHERE source_entity_id = ? AND is_deleted = 0',
    );
    const repointTargetStmt = db.prepare(
      'UPDATE relations SET target_entity_id = ? WHERE target_entity_id = ? AND is_deleted = 0',
    );
    const dropSelfLoopStmt = db.prepare(
      'UPDATE relations SET is_deleted = 1 WHERE source_entity_id = ? AND target_entity_id = ? AND is_deleted = 0',
    );
    const softDeleteStmt = db.prepare(
      "UPDATE entities SET is_deleted = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    );

    for (const p of proposed) {
      relinked += relinkStmt.run(p.winnerId, p.loserId).changes;
      dropOldLinksStmt.run(p.loserId);
      relinkedRelations += repointSourceStmt.run(p.winnerId, p.loserId).changes;
      relinkedRelations += repointTargetStmt.run(p.winnerId, p.loserId).changes;
      dropSelfLoopStmt.run(p.winnerId, p.winnerId);
      softDeleteStmt.run(p.loserId);
    }
  });
  tx();

  return {
    proposed,
    merged: proposed.length,
    relinked_memory_entities: relinked,
    relinked_relations: relinkedRelations,
  };
}
