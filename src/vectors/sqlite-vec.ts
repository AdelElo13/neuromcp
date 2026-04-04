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

  search(query: Float32Array, k: number): VectorSearchResult[] {
    const db = this.getDb();
    const buf = Buffer.from(query.buffer, query.byteOffset, query.byteLength);

    const rows = db
      .prepare(
        'SELECT id, distance FROM memories_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?',
      )
      .all(buf, k) as Array<{ id: string; distance: number }>;

    return rows.map((row) => ({
      id: row.id,
      distance: row.distance,
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
