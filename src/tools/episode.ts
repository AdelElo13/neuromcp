import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Episode, EpisodeWithStats } from '../types.js';
import { writeActive, clearActive } from '../episode/active-state.js';

const AMBIENT_TITLE_PREFIX = 'ambient-';
const AMBIENT_WINDOW_MS = Number.parseInt(process.env.NEUROMCP_AMBIENT_EPISODE_WINDOW_MS ?? '', 10) || 4 * 60 * 60 * 1000;

export function ensureAmbientEpisode(
  db: Database.Database,
  namespace: string,
): string {
  const cutoff = new Date(Date.now() - AMBIENT_WINDOW_MS).toISOString();
  const row = db
    .prepare(
      `SELECT id FROM episodes
       WHERE namespace = ?
         AND ended_at IS NULL
         AND title LIKE ?
         AND started_at >= ?
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get(namespace, `${AMBIENT_TITLE_PREFIX}%`, cutoff) as { id: string } | undefined;

  if (row) return row.id;

  const id = randomUUID().replace(/-/g, '').slice(0, 32);
  const now = new Date().toISOString();
  const title = `${AMBIENT_TITLE_PREFIX}${now.slice(0, 13)}-${process.pid}`;
  db.prepare(
    `INSERT INTO episodes (id, title, namespace, started_at, metadata)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, title, namespace, now, JSON.stringify({ ambient: true, pid: process.pid }));
  return id;
}

export function startEpisode(
  db: Database.Database,
  input: { title: string; namespace?: string; metadata?: Record<string, unknown> },
  defaultNamespace: string,
): Episode {
  const id = randomUUID().replace(/-/g, '').slice(0, 32);
  const namespace = input.namespace ?? defaultNamespace;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO episodes (id, title, namespace, started_at, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, input.title, namespace, now, JSON.stringify(input.metadata ?? {}));

  // Bug #7 (v0.21.0): mark this episode as the per-process "active"
  // one. Subsequent store_memory calls without explicit episode_id
  // attach here instead of to the ambient episode.
  try {
    writeActive({ episode_id: id, started_at: now, pid: process.pid, namespace });
  } catch {
    // Non-fatal — DB record is still created. Active-state file is a
    // convenience hook; caller can still pass episode_id explicitly.
  }

  return {
    id,
    title: input.title,
    namespace,
    started_at: now,
    ended_at: null,
    summary: null,
    metadata: JSON.stringify(input.metadata ?? {}),
  };
}

export function endEpisode(
  db: Database.Database,
  input: { episode_id: string; summary?: string },
): EpisodeWithStats {
  const now = new Date().toISOString();

  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(input.episode_id) as Episode | undefined;
  if (!episode) {
    throw new Error(`Episode not found: ${input.episode_id}`);
  }
  if (episode.ended_at) {
    throw new Error(`Episode already ended: ${input.episode_id}`);
  }

  // Count memories in this episode
  const countRow = db.prepare(
    'SELECT COUNT(*) as c FROM memories WHERE episode_id = ? AND is_deleted = 0'
  ).get(input.episode_id) as { c: number };

  // Auto-generate summary if not provided
  let summary = input.summary ?? null;
  if (!summary && countRow.c > 0) {
    // Extractive: take the most important memory's content as summary seed
    const topMemories = db.prepare(`
      SELECT content FROM memories
      WHERE episode_id = ? AND is_deleted = 0
      ORDER BY importance DESC, created_at ASC
      LIMIT 5
    `).all(input.episode_id) as Array<{ content: string }>;

    summary = topMemories.map(m => {
      const first = m.content.split(/[.!?\n]/)[0]?.trim();
      return first && first.length > 10 ? first : m.content.slice(0, 100);
    }).join('. ');

    if (summary.length > 500) summary = summary.slice(0, 497) + '...';
  }

  db.prepare(`
    UPDATE episodes SET ended_at = ?, summary = ? WHERE id = ?
  `).run(now, summary, input.episode_id);

  // Bug #7 (v0.21.0): if the ended episode was the active one, clear
  // the marker so the next store falls back to ambient.
  try {
    clearActive(input.episode_id);
  } catch {
    /* non-fatal */
  }

  return {
    ...episode,
    ended_at: now,
    summary,
    memory_count: countRow.c,
  };
}

export function listEpisodes(
  db: Database.Database,
  input: { namespace?: string; limit?: number; active_only?: boolean },
  defaultNamespace: string,
): readonly EpisodeWithStats[] {
  const namespace = input.namespace ?? defaultNamespace;
  const limit = input.limit ?? 20;

  let query = `
    SELECT e.*, COUNT(m.id) as memory_count
    FROM episodes e
    LEFT JOIN memories m ON m.episode_id = e.id AND m.is_deleted = 0
    WHERE e.namespace = ?
  `;

  if (input.active_only) {
    query += ' AND e.ended_at IS NULL';
  }

  query += ' GROUP BY e.id ORDER BY e.started_at DESC LIMIT ?';

  return db.prepare(query).all(namespace, limit) as EpisodeWithStats[];
}

export function getEpisode(
  db: Database.Database,
  episodeId: string,
): EpisodeWithStats | null {
  const row = db.prepare(`
    SELECT e.*, COUNT(m.id) as memory_count
    FROM episodes e
    LEFT JOIN memories m ON m.episode_id = e.id AND m.is_deleted = 0
    WHERE e.id = ?
    GROUP BY e.id
  `).get(episodeId) as EpisodeWithStats | undefined;

  return row ?? null;
}
