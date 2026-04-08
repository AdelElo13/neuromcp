import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

let _db: DatabaseType | null = null;

const PRAGMAS = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA foreign_keys = ON;',
  'PRAGMA busy_timeout = 5000;',
  'PRAGMA cache_size = -64000;',
  'PRAGMA auto_vacuum = INCREMENTAL;',
] as const;

export function openDatabase(path: string): DatabaseType {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);

  for (const pragma of PRAGMAS) {
    db.pragma(pragma.replace(/^PRAGMA\s+/, '').replace(';', ''));
  }

  _db = db;
  return db;
}

export function getDatabase(): DatabaseType {
  if (_db === null) {
    throw new Error('Database not initialized. Call openDatabase() first.');
  }
  return _db;
}

let _walWriteCount = 0;
const WAL_CHECKPOINT_INTERVAL = 1000;

/**
 * Trigger a WAL checkpoint if write count exceeds threshold.
 * Call after batch inserts (e.g., verbatim ingestion).
 */
export function maybeCheckpointWal(db?: DatabaseType): void {
  _walWriteCount++;
  if (_walWriteCount >= WAL_CHECKPOINT_INTERVAL) {
    const target = db ?? _db;
    if (target !== null) {
      target.pragma('wal_checkpoint(PASSIVE)');
      _walWriteCount = 0;
    }
  }
}

/** Force a WAL checkpoint — use before shutdown or after large imports. */
export function forceCheckpointWal(db?: DatabaseType): void {
  const target = db ?? _db;
  if (target !== null) {
    target.pragma('wal_checkpoint(TRUNCATE)');
    _walWriteCount = 0;
  }
}

export function closeDatabase(): void {
  if (_db !== null) {
    forceCheckpointWal(_db);
    _db.close();
    _db = null;
  }
}
