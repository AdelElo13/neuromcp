import type Database from 'better-sqlite3';
import type { Memory } from '../types.js';
import { currentValiditySql } from '../governance/validity.js';

export interface TimelineEntry {
  readonly memory: Memory;
  readonly superseded_by?: { id: string; content: string; created_at: string } | null;
  readonly supersedes?: { id: string; content: string; created_at: string } | null;
}

export interface TimelineResult {
  readonly entries: readonly TimelineEntry[];
  readonly topic_summary: string;
  readonly total_revisions: number;
}

/**
 * Track how knowledge about a topic evolved over time.
 * Follows supersession chains and orders by creation date.
 */
export function memoryTimeline(
  db: Database.Database,
  input: {
    query: string;
    namespace?: string;
    after?: string;
    before?: string;
    include_superseded?: boolean;
    limit?: number;
  },
  defaultNamespace: string,
): TimelineResult {
  const namespace = input.namespace ?? defaultNamespace;
  const includeSuperseded = input.include_superseded !== false;
  const limit = input.limit ?? 20;

  // v0.29: when include_superseded is false the timeline shows only CURRENT
  // entries — the old `AND is_deleted = 0` gate was semantically broken
  // (it never hid superseded/window-closed rows). Reuse the shared helper.
  const nowIso = new Date().toISOString();
  const matchValidity = includeSuperseded ? null : currentValiditySql(nowIso, 'm');
  const matchValidityClause = matchValidity !== null ? ` AND (${matchValidity.clause})` : '';
  const matchValidityParams = matchValidity !== null ? matchValidity.params : [];
  const likeValidity = includeSuperseded ? null : currentValiditySql(nowIso);
  const likeValidityClause = likeValidity !== null ? ` AND (${likeValidity.clause})` : '';
  const likeValidityParams = likeValidity !== null ? likeValidity.params : [];

  // Find memories matching the query (FTS)
  let matchIds: string[];
  try {
    const ftsQuery = '"' + input.query.replace(/"/g, '""') + '"';
    const ftsRows = db.prepare(`
      SELECT m.id FROM memories_fts f
      JOIN memories m ON m.rowid = f.rowid
      WHERE memories_fts MATCH ? AND m.namespace = ? AND m.is_deleted = 0${matchValidityClause}
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, namespace, ...matchValidityParams, limit * 3) as Array<{ id: string }>;
    matchIds = ftsRows.map(r => r.id);
  } catch {
    // FTS failed, try LIKE fallback
    const likeRows = db.prepare(`
      SELECT id FROM memories
      WHERE namespace = ? AND content LIKE ? AND is_deleted = 0${likeValidityClause}
      ORDER BY created_at DESC LIMIT ?
    `).all(namespace, `%${input.query}%`, ...likeValidityParams, limit * 3) as Array<{ id: string }>;
    matchIds = likeRows.map(r => r.id);
  }

  if (matchIds.length === 0) {
    return { entries: [], topic_summary: 'No memories found for this topic.', total_revisions: 0 };
  }

  // Expand via supersession chains
  const allIds = new Set(matchIds);
  for (const id of matchIds) {
    // Follow supersedes chain backwards
    let current = id;
    for (let depth = 0; depth < 10; depth++) {
      const prev = db.prepare('SELECT supersedes_id FROM memories WHERE id = ?').get(current) as { supersedes_id: string | null } | undefined;
      if (!prev?.supersedes_id) break;
      allIds.add(prev.supersedes_id);
      current = prev.supersedes_id;
    }
    // Follow superseded_by chain forwards
    current = id;
    for (let depth = 0; depth < 10; depth++) {
      const next = db.prepare('SELECT superseded_by_id FROM memories WHERE id = ?').get(current) as { superseded_by_id: string | null } | undefined;
      if (!next?.superseded_by_id) break;
      allIds.add(next.superseded_by_id);
      current = next.superseded_by_id;
    }
  }

  // Fetch all memories. When include_superseded is false, the chain
  // expansion above re-introduces superseded ids — re-apply the current
  // filter here so `false` genuinely returns only current entries.
  const placeholders = [...allIds].map(() => '?').join(',');
  let query = `SELECT * FROM memories WHERE id IN (${placeholders})`;
  const params: unknown[] = [...allIds];

  if (!includeSuperseded) {
    const v = currentValiditySql(nowIso);
    query += ` AND (${v.clause})`;
    params.push(...v.params);
  }

  if (input.after) {
    query += ' AND created_at > ?';
    params.push(input.after);
  }
  if (input.before) {
    query += ' AND created_at < ?';
    params.push(input.before);
  }

  query += ' ORDER BY COALESCE(valid_from, created_at) ASC LIMIT ?';
  params.push(limit);

  const memories = db.prepare(query).all(...params) as Memory[];

  // Build timeline entries with supersession context
  const entries: TimelineEntry[] = memories.map(mem => {
    let supersededBy: TimelineEntry['superseded_by'] = null;
    let supersedes: TimelineEntry['supersedes'] = null;

    if (mem.superseded_by_id) {
      const next = db.prepare('SELECT id, content, created_at FROM memories WHERE id = ?').get(mem.superseded_by_id) as { id: string; content: string; created_at: string } | undefined;
      if (next) supersededBy = next;
    }
    if (mem.supersedes_id) {
      const prev = db.prepare('SELECT id, content, created_at FROM memories WHERE id = ?').get(mem.supersedes_id) as { id: string; content: string; created_at: string } | undefined;
      if (prev) supersedes = prev;
    }

    return { memory: mem, superseded_by: supersededBy, supersedes };
  });

  // Generate topic summary
  const first = entries[0]?.memory;
  const last = entries[entries.length - 1]?.memory;
  const revisions = entries.filter(e => e.supersedes || e.superseded_by).length;
  const topicSummary = first && last
    ? `${entries.length} memories about "${input.query}" from ${first.created_at.slice(0, 10)} to ${last.created_at.slice(0, 10)}. ${revisions} revisions in the chain.`
    : 'No timeline data.';

  return { entries, topic_summary: topicSummary, total_revisions: revisions };
}
