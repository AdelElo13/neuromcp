import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDatabase, closeDatabase } from '../../src/storage/database.js';
import { applySchema } from '../../src/storage/schema.js';
import { ftsCandidates } from '../../src/tools/search.js';

/**
 * Regression: the FTS5 leg of hybrid search had no namespace pushdown — the
 * limit*3 candidate budget was consumed by other namespaces' rows, which the
 * post-filter then threw away. In multi-tenant DBs this starves the FTS leg
 * exactly like the vec-side recall collapse that was already fixed.
 */
describe('ftsCandidates namespace pushdown', () => {
  const testDb = join(tmpdir(), `neuromcp-v026-fts-${Date.now()}-${randomUUID()}.db`);
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    db = openDatabase(testDb);
    applySchema(db);

    const insert = db.prepare(
      `INSERT INTO memories
         (id, content_hash, content, namespace, source, source_trust, category, tags,
          importance, metadata, created_at, updated_at, schema_version, visibility,
          embedding_model, embedding_dim)
       VALUES (?, ?, ?, ?, 'user', 'medium', 'general', '[]',
               0.5, '{}', ?, ?, 2, 'namespace', 'fake', 384)`,
    );
    const fts = db.prepare(
      "INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES ((SELECT rowid FROM memories WHERE id = ?), ?, NULL, '[]', 'general')",
    );
    const now = new Date().toISOString();

    const seed = db.transaction(() => {
      // 40 crowd rows in namespace 'crowd' that all match the term.
      for (let i = 0; i < 40; i++) {
        const id = randomUUID().replaceAll('-', '');
        const content = `zebrafish observation number ${i} in the crowd tank`;
        insert.run(id, `h${i}`, content, 'crowd', now, now);
        fts.run(id, content);
      }
      // 1 row in namespace 'mine' that matches the same term.
      const id = 'mine0000000000000000000000000000';
      const content = 'zebrafish husbandry notes for my own tank';
      insert.run(id, 'hmine', content, 'mine', now, now);
      fts.run(id, content);
    });
    seed();
  });

  afterEach(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(testDb + suffix);
      } catch {
        // ignore missing files
      }
    }
  });

  it('returns only rows from the requested namespace', () => {
    const rows = ftsCandidates(db, '"zebrafish"', 30, 'mine') as Array<{ id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe('mine0000000000000000000000000000');
  });

  it('searches all namespaces when namespace is undefined', () => {
    const rows = ftsCandidates(db, '"zebrafish"', 50, undefined) as Array<{ id: string }>;
    expect(rows.length).toBe(41);
  });
});
