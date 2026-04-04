import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import {
  tombstone,
  tombstoneWithLineage,
  purgeTombstones,
  countTombstones,
} from '../../src/governance/tombstone.js';
import type { Logger } from '../../src/observability/logger.js';

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_model TEXT NOT NULL DEFAULT 'test',
  embedding_dim INTEGER NOT NULL DEFAULT 384,
  namespace TEXT NOT NULL DEFAULT 'default',
  source TEXT NOT NULL DEFAULT 'user',
  source_trust TEXT NOT NULL DEFAULT 'high',
  visibility TEXT NOT NULL DEFAULT 'private',
  schema_version INTEGER NOT NULL DEFAULT 1,
  category TEXT NOT NULL DEFAULT 'general',
  tags TEXT DEFAULT '[]',
  importance REAL NOT NULL DEFAULT 0.5,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_accessed_at TEXT,
  expires_at TEXT,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  tombstoned_at TEXT,
  supersedes_id TEXT,
  superseded_by_id TEXT,
  metadata TEXT DEFAULT '{}',
  project_id TEXT,
  agent_id TEXT,
  summary TEXT
)`;

function createMockLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function insertMemory(db: Database.Database, id: string, content: string): void {
  db.prepare(
    'INSERT INTO memories (id, content, content_hash) VALUES (?, ?, ?)',
  ).run(id, content, `hash_${id}`);
}

describe('tombstone utilities', () => {
  let db: Database.Database;
  let dbPath: string;
  const logger = createMockLogger();

  beforeEach(() => {
    dbPath = join(tmpdir(), `neuromcp-test-${randomUUID()}.db`);
    db = new Database(dbPath);
    db.exec(CREATE_TABLE);
  });

  afterEach(() => {
    db.close();
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore cleanup errors
    }
  });

  describe('tombstone', () => {
    it('soft-deletes a memory', () => {
      insertMemory(db, 'mem-1', 'hello');
      tombstone(db, 'mem-1');

      const row = db.prepare('SELECT is_deleted, tombstoned_at FROM memories WHERE id = ?').get('mem-1') as {
        is_deleted: number;
        tombstoned_at: string | null;
      };
      expect(row.is_deleted).toBe(1);
      expect(row.tombstoned_at).toBeTruthy();
    });
  });

  describe('tombstoneWithLineage', () => {
    it('soft-deletes and sets superseded_by_id', () => {
      insertMemory(db, 'old-mem', 'old content');
      insertMemory(db, 'new-mem', 'new content');
      tombstoneWithLineage(db, 'old-mem', 'new-mem');

      const row = db.prepare(
        'SELECT is_deleted, tombstoned_at, superseded_by_id FROM memories WHERE id = ?',
      ).get('old-mem') as {
        is_deleted: number;
        tombstoned_at: string | null;
        superseded_by_id: string | null;
      };
      expect(row.is_deleted).toBe(1);
      expect(row.tombstoned_at).toBeTruthy();
      expect(row.superseded_by_id).toBe('new-mem');
    });
  });

  describe('countTombstones', () => {
    it('counts soft-deleted memories', () => {
      insertMemory(db, 'a', 'a');
      insertMemory(db, 'b', 'b');
      insertMemory(db, 'c', 'c');

      expect(countTombstones(db)).toBe(0);

      tombstone(db, 'a');
      expect(countTombstones(db)).toBe(1);

      tombstone(db, 'b');
      expect(countTombstones(db)).toBe(2);
    });
  });

  describe('purgeTombstones', () => {
    it('permanently deletes old tombstones', () => {
      insertMemory(db, 'old', 'old');
      insertMemory(db, 'recent', 'recent');

      // Manually tombstone with an old date
      db.prepare(
        "UPDATE memories SET is_deleted = 1, tombstoned_at = '2020-01-01T00:00:00Z' WHERE id = 'old'",
      ).run();

      // Tombstone recent one with current time
      tombstone(db, 'recent');

      const purged = purgeTombstones(db, 30, logger);
      expect(purged).toBe(1);

      // Old one is gone
      const oldRow = db.prepare("SELECT * FROM memories WHERE id = 'old'").get();
      expect(oldRow).toBeUndefined();

      // Recent one still exists
      const recentRow = db.prepare("SELECT * FROM memories WHERE id = 'recent'").get();
      expect(recentRow).toBeTruthy();
    });

    it('returns 0 when no tombstones qualify', () => {
      insertMemory(db, 'alive', 'alive');
      const purged = purgeTombstones(db, 30, logger);
      expect(purged).toBe(0);
    });
  });
});
