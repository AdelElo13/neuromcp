import type Database from 'better-sqlite3';
import type { Memory } from '../types.js';
import { currentValiditySql } from '../governance/validity.js';

/**
 * Read-side query helpers for the memory:// resources. Extracted from
 * resources/index.ts so the current-validity invariant (v0.29) lives in one
 * tested place: the `memory://recent` and `memory://namespace/{ns}` browsing
 * surfaces show only currently-valid memories by default (superseded /
 * window-closed rows are historical, opt-in elsewhere).
 */

/** Last `limit` currently-valid memories across all namespaces, newest first. */
export function recentMemories(db: Database.Database, limit: number): Memory[] {
  const v = currentValiditySql(new Date().toISOString());
  return db
    .prepare(
      `SELECT * FROM memories WHERE is_deleted = 0 AND (${v.clause})
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...v.params, limit) as Memory[];
}

/** Currently-valid memories in a namespace, newest first. */
export function namespaceMemories(db: Database.Database, namespace: string, limit: number): Memory[] {
  const v = currentValiditySql(new Date().toISOString());
  return db
    .prepare(
      `SELECT * FROM memories WHERE is_deleted = 0 AND namespace = ? AND (${v.clause})
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(namespace, ...v.params, limit) as Memory[];
}
