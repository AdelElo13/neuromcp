import * as sqliteVec from 'sqlite-vec';
import type Database from 'better-sqlite3';
import type { VectorSearchResult, VectorStore } from './types.js';

export class SqliteVecStore implements VectorStore {
  readonly name = 'sqlite-vec';
  readonly dimensions: number;

  private db: Database.Database | null = null;

  constructor(dimensions: number) {
    this.dimensions = dimensions;
  }

  initialize(db: Database.Database): void {
    sqliteVec.load(db);

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec
      USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${this.dimensions}]
      );
    `);

    this.db = db;
  }

  upsert(id: string, embedding: Float32Array): void {
    const db = this.getDb();
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    db.prepare('DELETE FROM memories_vec WHERE id = ?').run(id);
    db.prepare('INSERT INTO memories_vec (id, embedding) VALUES (?, ?)').run(id, buf);
  }

  upsertBatch(
    entries: ReadonlyArray<{ readonly id: string; readonly embedding: Float32Array }>,
  ): void {
    const db = this.getDb();
    const deleteStmt = db.prepare('DELETE FROM memories_vec WHERE id = ?');
    const insertStmt = db.prepare('INSERT INTO memories_vec (id, embedding) VALUES (?, ?)');

    const runBatch = db.transaction(() => {
      for (const entry of entries) {
        const buf = Buffer.from(
          entry.embedding.buffer,
          entry.embedding.byteOffset,
          entry.embedding.byteLength,
        );
        deleteStmt.run(entry.id);
        insertStmt.run(entry.id, buf);
      }
    });

    runBatch();
  }

  search(query: Float32Array, k: number, namespace?: string): VectorSearchResult[] {
    // sprint1 Q1 fix: guard against k <= 0 — sqlite-vec behaviour is
    // unspecified for non-positive k and silently returns 0 rows in some
    // builds, which masquerades as a recall miss to the caller.
    if (!Number.isFinite(k) || k <= 0) {
      throw new Error(`SqliteVecStore.search: k must be a positive integer, got ${k}`);
    }
    const db = this.getDb();
    const buf = Buffer.from(query.buffer, query.byteOffset, query.byteLength);

    // Without a namespace, search the whole index. With a namespace, push
    // the filter into the vec query by over-fetching then joining on
    // `memories`. This prevents a catastrophic recall collapse in
    // multi-tenant deployments: the raw top-k by embedding is dominated by
    // whichever namespace has the most chunks, and the namespace filter
    // later in searchMemory throws most candidates away. Measured on the
    // LongMemEval-S benchmark (500 tenants, 124K total chunks): callers
    // asking for k=100 were receiving ~8 candidates after filtering.
    // sqlite-vec constraint: a vec0 MATCH query can specify EITHER `k = ?`
    // OR `LIMIT ?`, not both. Violating this throws
    // "SqliteError: Only LIMIT or 'k =?' can be provided, not both".
    // We use `k = ?` as the KNN bound and skip LIMIT. Over-fetch on the
    // namespace branch is still needed because the JOIN can't be pushed
    // into the MATCH.
    let rows: Array<{ id: string; distance: number }>;
    if (namespace === undefined) {
      rows = db
        .prepare(
          'SELECT id, distance FROM memories_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance',
        )
        .all(buf, k) as Array<{ id: string; distance: number }>;
    } else {
      // Over-fetch by 10× to cushion the namespace filter. sqlite-vec can't
      // push the join predicate into the KNN query, so anything dropped by
      // the join is lost. sqlite-vec hard-caps k at 4096 — clamp to stay
      // below that or the query throws "k too large". We still LIMIT k
      // after the JOIN — that's an outer SQL LIMIT, not a vec0 one, so
      // it doesn't hit the constraint above.
      const overfetch = Math.min(k * 10, 4000);
      rows = db
        .prepare(
          `SELECT v.id AS id, v.distance AS distance
             FROM (
               SELECT id, distance FROM memories_vec
                WHERE embedding MATCH ? AND k = ?
                ORDER BY distance
             ) v
             JOIN memories m ON m.id = v.id
            WHERE m.namespace = ?
              AND m.is_deleted = 0
            ORDER BY v.distance
            LIMIT ?`,
        )
        .all(buf, overfetch, namespace, k) as Array<{ id: string; distance: number }>;
    }

    // sqlite-vec returns L2 (Euclidean) distance.
    // For L2-normalized vectors: cosine_similarity = 1 - L2²/2
    // We convert to "cosine distance" (1 - cosine_similarity = L2²/2)
    // so that `1 - distance` gives true cosine similarity.
    return rows.map((row) => ({
      id: row.id,
      distance: (row.distance * row.distance) / 2,
    }));
  }

  remove(id: string): void {
    const db = this.getDb();
    db.prepare('DELETE FROM memories_vec WHERE id = ?').run(id);
  }

  clear(): void {
    const db = this.getDb();
    db.prepare('DELETE FROM memories_vec').run();
  }

  count(): number {
    const db = this.getDb();
    const row = db.prepare('SELECT COUNT(*) as cnt FROM memories_vec').get() as { cnt: number };
    return row.cnt;
  }

  private getDb(): Database.Database {
    if (this.db === null) {
      throw new Error('SqliteVecStore not initialized. Call initialize() first.');
    }
    return this.db;
  }
}
