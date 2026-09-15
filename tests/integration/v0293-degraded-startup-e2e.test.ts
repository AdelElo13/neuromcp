/**
 * v0.29.3 — end-to-end proof that the stdio server BOOTS on a database
 * whose vector index no provider can match.
 *
 * The unit-level contract lives in v0293-provider-switch.test.ts; this file
 * spawns the real `dist/index.js` the way Claude Desktop does, with:
 *   - a temp database carrying a 768-dim index,
 *   - Ollama pointed at a closed port (the "provider went away" case),
 *   - the ONNX fallback allowed (384-dim → cannot match the index),
 * and asserts the process reaches "MCP server running on stdio" instead of
 * exiting with "Fatal error: Embedding dimension mismatch" (0.29.2).
 *
 * `spawn` is used with an argument array and no shell — no interpolation.
 * Skipped when dist/ has not been built.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const DIST = resolve(process.cwd(), 'dist', 'index.js');
const HAS_DIST = existsSync(DIST);

describe.skipIf(!HAS_DIST)('v0.29.3 degraded startup (real process)', () => {
  let dir: string;
  let dbPath: string;
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'neuromcp-degraded-e2e-'));
    dbPath = join(dir, 'memory.db');

    // Seed a 768-dim index — the rest of the schema is created by the server
    // itself on first boot.
    const db = new Database(dbPath);
    sqliteVec.load(db);
    db.exec(
      'CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(id TEXT PRIMARY KEY, embedding float[768]);',
    );
    db.close();
  });

  afterAll(() => {
    if (child !== null && child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts (does not crash) and announces DEGRADED mode on stderr', async () => {
    child = spawn(process.execPath, [DIST], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NEUROMCP_DB_PATH: dbPath,
        NEUROMCP_WIKI_DIR: join(dir, 'wiki'),
        // Nothing listens here: the 768-dim provider is unreachable.
        OLLAMA_HOST: 'http://127.0.0.1:1',
        OPENAI_API_KEY: '',
        NEUROMCP_EMBEDDING_PROVIDER: 'auto',
        // Keep the test fast and offline.
        NEUROMCP_EMBEDDING_RETRY_ATTEMPTS: '1',
        NEUROMCP_DISABLE_MODEL_DOWNLOAD: '1',
        NEUROMCP_AUTO_CONSOLIDATE: 'false',
        NEUROMCP_HTTP_ENABLED: 'false',
      },
    });

    let stderr = '';
    const started = new Promise<void>((resolveStarted, rejectStarted) => {
      const timer = setTimeout(() => rejectStarted(new Error(`timeout. stderr:\n${stderr}`)), 30_000);
      child!.stderr.on('data', (b: Buffer) => {
        stderr += b.toString();
        if (stderr.includes('MCP server running on stdio')) {
          clearTimeout(timer);
          resolveStarted();
        }
      });
      child!.on('exit', (code) => {
        clearTimeout(timer);
        rejectStarted(new Error(`server exited with code ${code}. stderr:\n${stderr}`));
      });
    });

    await expect(started).resolves.toBeUndefined();
    expect(stderr).toContain('DEGRADED MODE');
    expect(stderr).toContain('neuromcp-reembed');
    expect(stderr).not.toContain('Fatal error');
    expect(child.exitCode).toBeNull(); // still alive
  }, 40_000);
});
