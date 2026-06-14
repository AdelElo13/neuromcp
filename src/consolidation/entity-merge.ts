/**
 * entity-merge.ts — Sprint 4: cross-row entity dedup pass.
 *
 * Codex Sprint 2.3 Q2 follow-up. The LLM extractor produces canonical names
 * within ONE chunk, but `upsertEntity` matches on exact lowercased name +
 * type + namespace. So row 1's "Emily" and row 2's "Emily Williams" land as
 * two distinct rows for the same person. The graph-boost path then spreads
 * over disconnected nodes.
 *
 * This module provides a periodic merge pass that:
 *   - groups entities by namespace + type
 *   - within each group, finds pairs where one name is a prefix-extension of
 *     the other (e.g. "Emily" ⊂ "Emily Williams") OR a small Levenshtein
 *     distance (typo dedup like "Yosemite" / "Yosmite")
 *   - merges the shorter/typo'd entity into the canonical one (longer name
 *     wins as the canonical form), re-points all memory_entities, soft-
 *     deletes the loser
 *
 * Designed to be safe: only merges within the SAME namespace + entity_type.
 * Never crosses namespace boundaries (multi-tenant isolation preserved).
 */
import type Database from 'better-sqlite3';
import type { Entity } from '../types.js';

export interface MergePair {
  readonly canonicalId: string;
  readonly canonicalName: string;
  readonly mergedId: string;
  readonly mergedName: string;
  readonly reason: 'prefix_extension' | 'levenshtein';
}

export interface MergeOptions {
  readonly maxLevenshtein?: number; // default 2
  readonly minNameLen?: number;     // skip ultra-short names (default 4)
  readonly dryRun?: boolean;        // default false — true = plan only
}

export interface MergeResult {
  readonly proposed: readonly MergePair[];
  readonly merged: number;
  readonly relinked_memory_entities: number;
  readonly relinked_relations: number;
}

/**
 * Run the merge pass for one namespace. Returns the count of merges and
 * the list of pair decisions (useful for audit logs).
 */
export function mergeEntitiesInNamespace(
  db: Database.Database,
  namespace: string,
  options: MergeOptions = {},
): MergeResult {
  const maxLev = options.maxLevenshtein ?? 2;
  const minLen = options.minNameLen ?? 4;
  const dryRun = options.dryRun ?? false;

  // Group entities by entity_type within the namespace; only consider active
  // (non-deleted) entities.
  const entities = db
    .prepare(
      `SELECT id, name, entity_type FROM entities
        WHERE namespace = ? AND is_deleted = 0`,
    )
    .all(namespace) as Array<Pick<Entity, 'id' | 'name' | 'entity_type'>>;

  const byType = new Map<string, Array<{ id: string; name: string }>>();
  for (const e of entities) {
    if (e.name.length < minLen) continue;
    const arr = byType.get(e.entity_type) ?? [];
    arr.push({ id: e.id, name: e.name });
    byType.set(e.entity_type, arr);
  }

  const proposed: MergePair[] = [];
  const consumed = new Set<string>(); // entity ids already losing in a merge

  for (const list of byType.values()) {
    // Sort by name length DESC so longer (more informative) names act as
    // canonical anchors; shorter aliases attach to them.
    list.sort((a, b) => b.name.length - a.name.length);

    for (let i = 0; i < list.length; i++) {
      const canon = list[i]!;
      if (consumed.has(canon.id)) continue;
      const canonLower = canon.name.toLowerCase();

      for (let j = i + 1; j < list.length; j++) {
        const other = list[j]!;
        if (consumed.has(other.id)) continue;
        const otherLower = other.name.toLowerCase();
        if (canonLower === otherLower) continue; // upsert already dedupes

        // Rule A: prefix-extension. "Emily Williams" canonical → swallow "Emily"
        // when canon starts with other + word boundary, or vice versa.
        const prefixHit =
          (canonLower.startsWith(otherLower + ' ') ||
            canonLower.endsWith(' ' + otherLower)) &&
          otherLower.length >= minLen;

        // Rule B: small Levenshtein (typo dedup).
        let levHit = false;
        if (
          !prefixHit &&
          Math.abs(canonLower.length - otherLower.length) <= maxLev &&
          canonLower.length >= minLen + 2 // avoid spurious 4-char merges
        ) {
          const d = levenshtein(canonLower, otherLower, maxLev);
          if (d >= 0 && d <= maxLev) levHit = true;
        }

        if (!prefixHit && !levHit) continue;
        proposed.push({
          canonicalId: canon.id,
          canonicalName: canon.name,
          mergedId: other.id,
          mergedName: other.name,
          reason: prefixHit ? 'prefix_extension' : 'levenshtein',
        });
        consumed.add(other.id);
      }
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
    const dropOldLinksStmt = db.prepare(
      `DELETE FROM memory_entities WHERE entity_id = ?`,
    );
    // Relations used to be left pointing at the soft-deleted loser, orphaning
    // every edge the loser participated in (traversal filters deleted
    // entities, so those edges silently vanished from the graph).
    const repointSourceStmt = db.prepare(
      `UPDATE relations SET source_entity_id = ? WHERE source_entity_id = ? AND is_deleted = 0`,
    );
    const repointTargetStmt = db.prepare(
      `UPDATE relations SET target_entity_id = ? WHERE target_entity_id = ? AND is_deleted = 0`,
    );
    // A merge can turn an alias→canonical edge into a self-loop; drop those.
    const dropSelfLoopStmt = db.prepare(
      `UPDATE relations SET is_deleted = 1 WHERE source_entity_id = ? AND target_entity_id = ? AND is_deleted = 0`,
    );
    const softDeleteStmt = db.prepare(
      `UPDATE entities SET is_deleted = 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?`,
    );
    for (const p of proposed) {
      const info = relinkStmt.run(p.canonicalId, p.mergedId);
      relinked += info.changes;
      dropOldLinksStmt.run(p.mergedId);
      relinkedRelations += repointSourceStmt.run(p.canonicalId, p.mergedId).changes;
      relinkedRelations += repointTargetStmt.run(p.canonicalId, p.mergedId).changes;
      dropSelfLoopStmt.run(p.canonicalId, p.canonicalId);
      softDeleteStmt.run(p.mergedId);
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

/**
 * Bounded Levenshtein distance. Returns -1 if distance exceeds `maxDist` —
 * lets the caller prune pairs cheaply without computing the full matrix.
 *
 * Standard DP table approach with early exit when the row's minimum
 * already exceeds maxDist.
 */
export function levenshtein(a: string, b: string, maxDist: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return -1;
  const m = a.length;
  const n = b.length;
  // dp[j] = distance for prefix a[0..i], b[0..j]
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const ins = curr[j - 1]! + 1;
      const del = prev[j]! + 1;
      const sub = prev[j - 1]! + cost;
      const v = Math.min(ins, del, sub);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > maxDist) return -1;
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}
