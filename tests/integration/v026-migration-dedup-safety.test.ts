import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase } from '../../src/storage/database.js';
import { applySchema } from '../../src/storage/schema.js';
import { upsertEntity, linkMemoryEntity } from '../../src/graph/entities.js';
import { createRelation } from '../../src/graph/relations.js';
// New v0.26 exports — these imports are the failing-first gate for this file.
import { tryAlterAddColumn, backupDatabase } from '../../src/storage/migrations.js';
import { mergeDuplicateEntityNames } from '../../src/graph/entity-name-dedup.js';

describe('v0.26 migration safety + entity-name dedup', () => {
  const testDb = join(tmpdir(), `neuromcp-v026-mig-${Date.now()}-${randomUUID()}.db`);
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    db = openDatabase(testDb);
    applySchema(db);
  });

  afterEach(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm', '.backup-test']) {
      try {
        unlinkSync(testDb + suffix);
      } catch {
        // ignore
      }
    }
  });

  describe('tryAlterAddColumn', () => {
    it('swallows duplicate-column errors (idempotent re-run)', () => {
      expect(() =>
        tryAlterAddColumn(db, 'ALTER TABLE memories ADD COLUMN surprise_score REAL NOT NULL DEFAULT 0.0'),
      ).not.toThrow();
    });

    it('rethrows every other error instead of silently stamping the schema version', () => {
      expect(() =>
        tryAlterAddColumn(db, 'ALTER TABLE table_that_does_not_exist ADD COLUMN x TEXT'),
      ).toThrow(/no such table/i);
    });
  });

  describe('backupDatabase', () => {
    it('produces a consistent backup of a live WAL database (VACUUM INTO)', () => {
      db.prepare(
        `INSERT INTO memories
           (id, content_hash, content, namespace, source, source_trust, category, tags,
            importance, metadata, created_at, updated_at, schema_version, visibility,
            embedding_model, embedding_dim)
         VALUES ('bk1', 'h1', 'backup canary', 'default', 'user', 'medium', 'general', '[]',
                 0.5, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 2,
                 'namespace', 'fake', 8)`,
      ).run();

      const backupPath = testDb + '.backup-test';
      backupDatabase(db, backupPath);
      expect(existsSync(backupPath)).toBe(true);

      const backup = new Database(backupPath, { readonly: true });
      try {
        const integrity = backup.pragma('integrity_check') as Array<{ integrity_check: string }>;
        expect(integrity[0]!.integrity_check).toBe('ok');
        const row = backup.prepare("SELECT content FROM memories WHERE id = 'bk1'").get() as
          | { content: string }
          | undefined;
        expect(row?.content).toBe('backup canary');
      } finally {
        backup.close();
      }
    });
  });

  describe('mergeDuplicateEntityNames (destructive migration, dry-run first)', () => {
    function seedDuplicates(): { winner: string; loser: string } {
      // Two entities with the same canonical name key but different types —
      // the pre-v0.26 upsert key included entity_type, so these accumulated.
      // The v0.26 upsert key can no longer CREATE such duplicates, so seed
      // them via direct SQL exactly as a pre-v0.26 database would contain.
      const insertEntity = db.prepare(
        `INSERT INTO entities (id, name, entity_type, namespace, metadata, created_at, updated_at)
         VALUES (?, 'NeuroMCP', ?, 'ns1', '{}', ?, ?)`,
      );
      const aId = 'a'.repeat(32);
      const bId = 'b'.repeat(32);
      insertEntity.run(aId, 'concept', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      insertEntity.run(bId, 'project', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
      const a = { id: aId };
      const b = { id: bId };

      // winner = most links: give b two memory links, a none
      db.prepare(
        `INSERT INTO memories
           (id, content_hash, content, namespace, source, source_trust, category, tags,
            importance, metadata, created_at, updated_at, schema_version, visibility,
            embedding_model, embedding_dim)
         VALUES ('mm1', 'hh1', 'x', 'ns1', 'user', 'medium', 'general', '[]',
                 0.5, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 2,
                 'namespace', 'fake', 8),
                ('mm2', 'hh2', 'y', 'ns1', 'user', 'medium', 'general', '[]',
                 0.5, '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 2,
                 'namespace', 'fake', 8)`,
      ).run();
      linkMemoryEntity(db, 'mm1', b.id);
      linkMemoryEntity(db, 'mm2', b.id);

      const other = upsertEntity(db, 'Acme Things', 'organization', 'ns1');
      createRelation(db, a.id, other.id, 'related_to', 'ns1');

      return { winner: b.id, loser: a.id };
    }

    it('dry-run reports the plan without mutating anything', () => {
      const { loser } = seedDuplicates();
      const plan = mergeDuplicateEntityNames(db, { dryRun: true });
      expect(plan.proposed.length).toBe(1);
      expect(plan.merged).toBe(0);

      const loserRow = db.prepare('SELECT is_deleted FROM entities WHERE id = ?').get(loser) as {
        is_deleted: number;
      };
      expect(loserRow.is_deleted).toBe(0);
    });

    it('apply merges losers into the most-linked winner and re-points links + relations', () => {
      const { winner, loser } = seedDuplicates();
      const result = mergeDuplicateEntityNames(db, { dryRun: false });
      expect(result.merged).toBe(1);

      const loserRow = db.prepare('SELECT is_deleted FROM entities WHERE id = ?').get(loser) as {
        is_deleted: number;
      };
      expect(loserRow.is_deleted).toBe(1);

      const links = db
        .prepare('SELECT COUNT(*) AS n FROM memory_entities WHERE entity_id = ?')
        .get(winner) as { n: number };
      expect(links.n).toBe(2);

      const orphanRelations = db
        .prepare(
          'SELECT COUNT(*) AS n FROM relations WHERE (source_entity_id = ? OR target_entity_id = ?) AND is_deleted = 0',
        )
        .get(loser, loser) as { n: number };
      expect(orphanRelations.n).toBe(0);

      const winnerRelations = db
        .prepare('SELECT COUNT(*) AS n FROM relations WHERE source_entity_id = ? AND is_deleted = 0')
        .get(winner) as { n: number };
      expect(winnerRelations.n).toBe(1);
    });
  });
});
