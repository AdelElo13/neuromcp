import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as createHttpServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { SqliteVecStore } from '../../src/vectors/sqlite-vec.js';

const execFileAsync = promisify(execFile);

/**
 * v0.29.3 round-3 regression — `reembed --apply` on a QUIET WAL database
 * must succeed (exit 0), through the real CLI.
 *
 * History of this exact scenario: the first swap-safety attempt used a
 * `data_version` sentinel, and the guard's own `wal_checkpoint(TRUNCATE)`
 * bumped that value with zero external commits — Codex reproduced the CLI
 * refusing a perfectly safe apply on every WAL database (neuromcp's
 * default journal mode) with "the database CHANGED during the rebuild",
 * exit 3. The fix holds a write lock across snapshot→rebuild→swap instead
 * of detecting changes afterwards. This test pins the whole path end to
 * end: real bin/reembed.mjs, real SQLite + vec0, embeddings served by an
 * in-test fake Ollama.
 *
 * Requires a build (`npm run build`) — reembed loads dist/; CI builds
 * before running tests.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REEMBED = join(REPO_ROOT, 'bin', 'reembed.mjs');

function startFakeOllama(dims: number): Promise<{ server: Server; url: string }> {
  const server = createHttpServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/embed') {
      req.on('data', () => undefined);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // reembed batches up to 16 inputs; answer with one vector per input
        // is not knowable without parsing — return 16, extras are ignored.
        res.end(
          JSON.stringify({
            embeddings: Array.from({ length: 16 }, () => Array.from({ length: dims }, () => 0.1)),
          }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolvePromise({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe('reembed --apply E2E on a quiet WAL database', () => {
  let fakeOllama: { server: Server; url: string };
  let dir: string;
  let dbPath: string;

  beforeAll(async () => {
    expect(existsSync(join(REPO_ROOT, 'dist', 'index.js')), 'run `npm run build` first').toBe(true);
    fakeOllama = await startFakeOllama(768);
    dir = mkdtempSync(join(tmpdir(), 'neuromcp-reembed-e2e-'));
    dbPath = join(dir, 'memory.db');

    // A 384-dim WAL database with data — the exact provider-switch shape.
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    sqliteVec.load(db);
    db.prepare(
      `CREATE TABLE memories (
         id TEXT PRIMARY KEY, content_hash TEXT, content TEXT,
         embedding_model TEXT, embedding_dim INTEGER,
         namespace TEXT DEFAULT 'default', is_deleted INTEGER DEFAULT 0,
         created_at TEXT DEFAULT (datetime('now')))`,
    ).run();
    const vecStore = new SqliteVecStore(384);
    vecStore.initialize(db);
    const insert = db.prepare(
      'INSERT INTO memories (id, content_hash, content, embedding_model, embedding_dim) VALUES (?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 3; i++) {
      insert.run(`mem-${i}`, `hash-${i}`, `memory number ${i}`, 'bge-small-en-v1.5', 384);
      vecStore.upsert(`mem-${i}`, new Float32Array(384).fill(0.5));
    }
    db.close();
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolvePromise) => fakeOllama.server.close(() => resolvePromise()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0, swaps a 768-dim index in, and keeps a timestamped backup', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [REEMBED, '--db', dbPath, '--apply'],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          OLLAMA_HOST: fakeOllama.url,
          NEUROMCP_EMBEDDING_PROVIDER: 'ollama',
        },
        timeout: 60_000,
      },
    );
    // execFileAsync throws on non-zero exit — reaching here IS exit 0.
    expect(stdout).toMatch(/applied/);

    const swapped = new Database(dbPath, { readonly: true });
    const ddl = (
      swapped.prepare("SELECT sql FROM sqlite_master WHERE name='memories_vec'").get() as { sql: string }
    ).sql;
    swapped.close();
    expect(ddl).toMatch(/float\[768\]/);

    const backups = readdirSync(dir).filter((f) => f.includes('.pre-reembed-'));
    expect(backups.length).toBe(1);
  }, 60_000);
});
