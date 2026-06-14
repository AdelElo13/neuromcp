import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDatabase, closeDatabase } from '../../src/storage/database.js';
import { applySchema } from '../../src/storage/schema.js';
import { SqliteVecStore } from '../../src/vectors/sqlite-vec.js';
import { createLogger } from '../../src/observability/logger.js';
import { purgeTombstones } from '../../src/governance/tombstone.js';
import { upsertEntity, linkMemoryEntity } from '../../src/graph/entities.js';
import { createRelation } from '../../src/graph/relations.js';
import { traverseGraph } from '../../src/graph/traverse.js';
import { mergeEntitiesInNamespace } from '../../src/consolidation/entity-merge.js';

const DIMS = 8;

function insertMemory(
  db: ReturnType<typeof openDatabase>,
  id: string,
  content: string,
  opts: { tombstonedDaysAgo?: number } = {},
): void {
  const now = new Date().toISOString();
  const tombstoned = opts.tombstonedDaysAgo !== undefined;
  const tombstonedAt = tombstoned
    ? new Date(Date.now() - opts.tombstonedDaysAgo! * 86_400_000).toISOString()
    : null;
  db.prepare(
    `INSERT INTO memories
       (id, content_hash, content, namespace, source, source_trust, category, tags,
        importance, metadata, created_at, updated_at, schema_version, visibility,
        embedding_model, embedding_dim, is_deleted, tombstoned_at)
     VALUES (?, ?, ?, 'default', 'user', 'medium', 'general', '[]',
             0.5, '{}', ?, ?, 2, 'namespace', 'fake', ?, ?, ?)`,
  ).run(id, `h-${id}`, content, now, now, DIMS, tombstoned ? 1 : 0, tombstonedAt);
  const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
  db.prepare(
    "INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, '[]', 'general')",
  ).run(row.rowid, content);
}

describe('v0.26 purge + graph integrity', () => {
  const testDb = join(tmpdir(), `neuromcp-v026-p2-${Date.now()}-${randomUUID()}.db`);
  let db: ReturnType<typeof openDatabase>;
  let vecStore: SqliteVecStore;
  const logger = createLogger({ level: 'error', format: 'text' });

  beforeEach(() => {
    db = openDatabase(testDb);
    applySchema(db);
    vecStore = new SqliteVecStore(DIMS);
    vecStore.initialize(db);
  });

  afterEach(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(testDb + suffix);
      } catch {
        // ignore
      }
    }
  });

  describe('purgeTombstones', () => {
    it('physically deletes a tombstone with entity links, claims, FTS row and vector', () => {
      insertMemory(db, 'm-purge-1', 'purgeable walrus content', { tombstonedDaysAgo: 90 });
      vecStore.upsert('m-purge-1', new Float32Array(DIMS).fill(0.5));

      const entity = upsertEntity(db, 'Walrus Project', 'project', 'default');
      linkMemoryEntity(db, 'm-purge-1', entity.id);
      db.prepare(
        "INSERT INTO claims (id, memory_id, content, subject, predicate, object) VALUES ('c1', 'm-purge-1', 'walrus is purgeable', 'walrus', 'is', 'purgeable')",
      ).run();

      const purged = purgeTombstones(db, 30, logger, vecStore);
      expect(purged).toBe(1);

      expect(db.prepare("SELECT id FROM memories WHERE id = 'm-purge-1'").get()).toBeUndefined();
      expect(
        db.prepare("SELECT * FROM memory_entities WHERE memory_id = 'm-purge-1'").all().length,
      ).toBe(0);
      expect(db.prepare("SELECT * FROM claims WHERE memory_id = 'm-purge-1'").all().length).toBe(0);
      // FTS index must not retain the purged row (stale rowids serve wrong results)
      expect(
        db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH '\"purgeable walrus\"'").all().length,
      ).toBe(0);
      expect(vecStore.count()).toBe(0);
    });

    it('leaves fresh tombstones and live memories untouched', () => {
      insertMemory(db, 'm-live', 'living memory heron');
      insertMemory(db, 'm-fresh-tomb', 'fresh tombstone heron', { tombstonedDaysAgo: 1 });

      const purged = purgeTombstones(db, 30, logger, vecStore);
      expect(purged).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 2 });
    });
  });

  describe('upsertEntity canonical key', () => {
    it('dedups on (LOWER(TRIM(name)), namespace) regardless of entity_type', () => {
      const first = upsertEntity(db, 'Jarvis', 'person', 'ns1');
      const second = upsertEntity(db, '  jarvis ', 'concept', 'ns1');
      expect(second.id).toBe(first.id);

      // Different namespace still creates a distinct entity
      const other = upsertEntity(db, 'Jarvis', 'person', 'ns2');
      expect(other.id).not.toBe(first.id);
    });
  });

  describe('mergeEntitiesInNamespace re-points relations', () => {
    it('moves the loser entity relations to the canonical entity', () => {
      const canon = upsertEntity(db, 'Emily Williams', 'person', 'ns1');
      const alias = upsertEntity(db, 'Emily', 'person', 'ns1');
      const company = upsertEntity(db, 'Acme Robotics', 'organization', 'ns1');
      createRelation(db, alias.id, company.id, 'works_at', 'ns1');

      const result = mergeEntitiesInNamespace(db, 'ns1');
      expect(result.merged).toBeGreaterThanOrEqual(1);

      const orphaned = db
        .prepare(
          'SELECT COUNT(*) AS n FROM relations WHERE (source_entity_id = ? OR target_entity_id = ?) AND is_deleted = 0',
        )
        .get(alias.id, alias.id) as { n: number };
      expect(orphaned.n).toBe(0);

      const repointed = db
        .prepare(
          "SELECT COUNT(*) AS n FROM relations WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = 'works_at' AND is_deleted = 0",
        )
        .get(canon.id, company.id) as { n: number };
      expect(repointed.n).toBe(1);
    });
  });

  describe('traverseGraph honors every relation_types entry', () => {
    it('returns edges for all requested relation types, not just the first', () => {
      const hub = upsertEntity(db, 'Garry Tan', 'person', 'ns1');
      const yc = upsertEntity(db, 'Y Combinator', 'organization', 'ns1');
      const gbrain = upsertEntity(db, 'GBrain Project', 'project', 'ns1');
      createRelation(db, hub.id, yc.id, 'works_at', 'ns1');
      createRelation(db, hub.id, gbrain.id, 'founded', 'ns1');

      const result = traverseGraph(db, hub.id, {
        maxDepth: 1,
        relation_types: ['works_at', 'founded'],
      });

      const types = result.edges.map((e) => e.relation.relation_type).sort();
      expect(types).toEqual(['founded', 'works_at']);
    });
  });
});
