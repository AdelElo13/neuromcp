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

export function closeDatabase(): void {
  if (_db !== null) {
    _db.close();
    _db = null;
  }
}
