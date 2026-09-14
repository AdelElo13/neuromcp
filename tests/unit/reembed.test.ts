/**
 * v0.29.3 — `neuromcp-reembed`, the documented recovery path after an
 * embedding-provider switch. Contract:
 *   - it rebuilds the vec0 index at the NEW width,
 *   - it re-stamps embedding_model / embedding_dim on every memory,
 *   - it works on a COPY (the CLI never rebuilds in place),
 *   - it leaves the memories themselves untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { SqliteVecStore } from '../../src/vectors/sqlite-vec.js';

// @ts-expect-error — plain-ESM CLI in bin/, no type declarations shipped
import {
  parseReembedArgs,
  resolveDbPath,
  buildCopyPath,
  buildBackupPath,
  readVecDimension,
  rebuildIndex,
} from '../../bin/reembed.mjs';

class FakeEmbedder {
  readonly name = 'nomic-embed-text';
  readonly dimensions = 768;

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(this.dimensions);
      v[t.length % this.dimensions] = 1;
      return v;
    });
  }
}

describe('neuromcp-reembed', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'neuromcp-reembed-'));
    dbPath = join(dir, 'memory.db');

    // A 384-dim database with two memories, as the ONNX fallback would leave it.
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, content TEXT, embedding_model TEXT,
        embedding_dim INTEGER, is_deleted INTEGER DEFAULT 0, created_at TEXT
      );
    `);
    const store = new SqliteVecStore(384);
    store.initialize(db as never);
    const insert = db.prepare(
      'INSERT INTO memories (id, content, embedding_model, embedding_dim, is_deleted, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    );
    insert.run('a', 'first memory', 'bge-small-en-v1.5', 384, '2026-01-01T00:00:00Z');
    insert.run('b', 'second memory', 'bge-small-en-v1.5', 384, '2026-01-02T00:00:00Z');
    store.upsertBatch([
      { id: 'a', embedding: new Float32Array(384) },
      { id: 'b', embedding: new Float32Array(384) },
    ]);
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses its flags', () => {
    expect(parseReembedArgs([])).toEqual({ db: null, apply: false, keepCopy: false, limit: null, help: false });
    expect(parseReembedArgs(['--apply', '--limit', '5'])).toMatchObject({ apply: true, limit: 5 });
    expect(parseReembedArgs(['--db', '/tmp/x.db'])).toMatchObject({ db: '/tmp/x.db' });
    expect(() => parseReembedArgs(['--limit', 'zero'])).toThrow(/positive integer/);
    expect(() => parseReembedArgs(['--nope'])).toThrow(/unknown flag/);
    expect(() => parseReembedArgs(['--db'])).toThrow(/--db requires/);
  });

  it('resolves the database path from the flag, then the env, then the default', () => {
    expect(resolveDbPath({}, '/tmp/explicit.db')).toBe('/tmp/explicit.db');
    expect(resolveDbPath({ NEUROMCP_DB_PATH: '/tmp/env.db' }, null)).toBe('/tmp/env.db');
    expect(resolveDbPath({}, null, '/home/x')).toBe('/home/x/.neuromcp/memory.db');
  });

  it('derives copy and backup paths in the same directory (atomic rename)', () => {
    const now = (): Date => new Date('2026-09-14T10:11:12.000Z');
    expect(buildCopyPath('/d/memory.db', now)).toBe('/d/memory.db.reembed-2026-09-14T10-11-12-000Z');
    expect(buildBackupPath('/d/memory.db', now)).toBe('/d/memory.db.pre-reembed-2026-09-14T10-11-12-000Z');
  });

  it('rebuilds a 384-dim index as 768-dim and re-stamps every memory', async () => {
    const before = new Database(dbPath);
    expect(readVecDimension(before)).toBe(384);
    before.close();

    const result = await rebuildIndex(dbPath, new FakeEmbedder(), {
      Database,
      SqliteVecStore,
    });

    expect(result).toMatchObject({ total: 2, embedded: 2, errors: 0, oldDim: 384, newDim: 768 });

    const after = new Database(dbPath);
    sqliteVec.load(after);
    expect(readVecDimension(after)).toBe(768);
    const rows = after
      .prepare('SELECT id, content, embedding_model, embedding_dim FROM memories ORDER BY id')
      .all() as Array<{ id: string; content: string; embedding_model: string; embedding_dim: number }>;
    expect(rows).toEqual([
      { id: 'a', content: 'first memory', embedding_model: 'nomic-embed-text', embedding_dim: 768 },
      { id: 'b', content: 'second memory', embedding_model: 'nomic-embed-text', embedding_dim: 768 },
    ]);
    const vecCount = after.prepare('SELECT COUNT(*) AS n FROM memories_vec').get() as { n: number };
    expect(vecCount.n).toBe(2);
    after.close();
  });

  it('--limit only embeds the first n memories (smoke test mode)', async () => {
    const result = await rebuildIndex(dbPath, new FakeEmbedder(), {
      Database,
      SqliteVecStore,
      limit: 1,
    });
    expect(result).toMatchObject({ total: 1, embedded: 1, errors: 0 });
  });

  it('reports errors instead of silently producing a half-built index', async () => {
    const broken = {
      name: 'broken',
      dimensions: 768,
      async embedBatch(): Promise<Float32Array[]> {
        throw new Error('provider went away mid-rebuild');
      },
    };
    const logged: string[] = [];
    const result = await rebuildIndex(dbPath, broken, {
      Database,
      SqliteVecStore,
      log: (s: string) => logged.push(s),
    });
    expect(result.errors).toBe(2);
    expect(result.embedded).toBe(0);
    expect(logged.join('\n')).toMatch(/provider went away/);
  });
});
