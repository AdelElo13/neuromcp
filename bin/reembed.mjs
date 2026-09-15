#!/usr/bin/env node
/**
 * neuromcp-reembed — the documented way out of an embedding-provider switch.
 *
 * The situation it fixes: `memories_vec` is a vec0 virtual table with a FIXED
 * width (float[384] for the ONNX fallback, float[768] for Ollama's
 * nomic-embed-text). Once it exists, a provider of a different width cannot
 * write to it. Since 0.29.3 the server no longer crashes on that — it starts
 * in DEGRADED mode (full-text search only) — but the index still has to be
 * rebuilt before vector search comes back with the new provider.
 *
 * Safety model (deliberately paranoid — this touches the memory database):
 *   - It NEVER rebuilds in place. The work always happens on a COPY made
 *     with SQLite's own backup API (consistent even with WAL and other
 *     clients attached).
 *   - Default run = dry run: build the copy, report, leave everything alone.
 *   - `--apply` swaps the rebuilt copy in and keeps the original as
 *     `<db>.pre-reembed-<timestamp>`. Nothing is ever deleted.
 *   - Stop every neuromcp client first; a running writer means your last few
 *     memories may stay behind in the original file.
 *
 * Usage:
 *   npx neuromcp-reembed                     # dry run on a copy
 *   npx neuromcp-reembed --apply             # rebuild + swap in (keeps backup)
 *   npx neuromcp-reembed --db /path/to.db    # explicit database
 *   npx neuromcp-reembed --limit 200         # only embed the first N (smoke test)
 *   npx neuromcp-reembed --keep-copy         # dry run, but leave the copy on disk
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainModule } from './is-main.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/**
 * @typedef {{ db: string | null, apply: boolean, keepCopy: boolean, limit: number | null, help: boolean, force: boolean }} ReembedArgs
 */

/**
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {ReembedArgs}
 */
export function parseReembedArgs(argv) {
  /** @type {ReembedArgs} */
  const out = { db: null, apply: false, keepCopy: false, limit: null, help: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--keep-copy') out.keepCopy = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--db') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error('--db requires a path');
      out.db = v;
    } else if (arg === '--limit') {
      const v = argv[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) throw new Error('--limit requires a positive integer');
      out.limit = n;
    } else {
      throw new Error(`unknown flag: ${arg} (use --db, --apply, --keep-copy, --limit, --force)`);
    }
  }
  if (out.apply && out.limit !== null) {
    // A limited rebuild drops ALL vectors but re-embeds only the first n
    // memories — applying that installs a partial index with stale
    // embedding_model stamps on the rest: exactly the mismatch state this
    // tool exists to fix. --limit is a dry-run smoke-test knob only.
    throw new Error('--limit cannot be combined with --apply (a partial rebuild must never be swapped in)');
  }
  return out;
}

/**
 * @typedef {{ available: boolean, pids: number[] }} AttachedPidsResult
 */

/**
 * PIDs of OTHER processes that currently have the database file open, via
 * `lsof -t` (macOS/Linux). `available: false` means the detection itself
 * could not run (lsof missing) — the guard treats that as "safety cannot
 * be established", NOT as "no clients": an attached-but-idle connection
 * holds no SQLite lock, so the checkpoint probe alone cannot see it.
 *
 * @param {string} dbPath
 * @param {number} [selfPid]
 * @returns {AttachedPidsResult}
 */
export function listAttachedPids(dbPath, selfPid = process.pid) {
  /** @param {string} stdout @returns {number[]} */
  const parse = (stdout) =>
    stdout
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== selfPid);
  try {
    const stdout = execFileSync('lsof', ['-t', '--', dbPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { available: true, pids: parse(stdout) };
  } catch (err) {
    // lsof exits 1 with empty output when NO process has the file open —
    // that is a successful, empty answer. Anything else (ENOENT, signal,
    // unexpected status) means the detection layer is unavailable.
    const e = /** @type {{ status?: unknown, stdout?: unknown, code?: unknown }} */ (err);
    if (typeof e.status === 'number' && e.status === 1) {
      return { available: true, pids: typeof e.stdout === 'string' ? parse(e.stdout) : [] };
    }
    return { available: false, pids: [] };
  }
}

/**
 * Refuse to swap the rebuilt copy in while the original database is still in
 * use. A client that stays attached across the swap keeps writing to the OLD
 * inode — those writes silently vanish. Two layers, both best-effort:
 *
 *   1. `lsof` names other processes holding the file open (covers idle
 *      clients that hold no lock).
 *   2. `wal_checkpoint(TRUNCATE)` refuses while any connection is actively
 *      reading/writing — and on success it has folded the pending WAL into
 *      the main file, so the `copyFileSync` backup that follows is complete.
 *
 * @param {new (path: string, opts?: object) => { pragma: (s: string) => unknown, close: () => void }} Database
 * @param {string} dbPath
 * @param {{ attachedPids?: (p: string) => AttachedPidsResult }} [deps]
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function guardApplySwap(Database, dbPath, deps = {}) {
  const { attachedPids = listAttachedPids } = deps;

  /** @type {AttachedPidsResult} */
  let attachment = { available: false, pids: [] };
  try {
    attachment = attachedPids(dbPath);
  } catch {
    // treated as unavailable below — fail closed, not open
  }
  if (!attachment.available) {
    return {
      ok: false,
      reason:
        'cannot verify that no client is attached (lsof unavailable) — an idle connection holds ' +
        'no SQLite lock, so safety cannot be established. Install lsof, or pass --force to override',
    };
  }
  if (attachment.pids.length > 0) {
    return {
      ok: false,
      reason:
        `other processes still have the database open (pid ${attachment.pids.join(', ')}) — ` +
        'stop every neuromcp client (Claude Desktop / Claude Code / Codex / the daemon) first',
    };
  }

  const db = new Database(dbPath);
  try {
    const rows = db.pragma('wal_checkpoint(TRUNCATE)');
    const row = Array.isArray(rows) ? rows[0] : rows;
    const busy =
      row !== null && typeof row === 'object' && typeof (/** @type {{busy?: unknown}} */ (row).busy) === 'number'
        ? /** @type {{busy: number}} */ (row).busy
        : 1;
    if (busy !== 0) {
      return {
        ok: false,
        reason:
          'the database is busy (another connection is reading or writing) — ' +
          'stop every neuromcp client first',
      };
    }
    return { ok: true };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * PREVENT writes to the ORIGINAL database between the snapshot and the swap
 * by holding `BEGIN IMMEDIATE` (SQLite's reserved write lock) for the whole
 * window. The re-embed can take minutes; without this a client could write
 * during it and the swap would install the stale snapshot, silently
 * dropping those writes from the active file.
 *
 * Prevention, not detection: a `data_version` sentinel was tried first and
 * is unreliable here — the guard's own `wal_checkpoint(TRUNCATE)` bumps
 * data_version with ZERO commits (measured: {busy:0, log:0, checkpointed:0}
 * still changed it), guaranteeing a false refusal. With the lock held,
 * interim commits are impossible: a straggler client gets SQLITE_BUSY
 * (loud, at that client) while readers — including the snapshot backup —
 * keep working.
 *
 * @param {new (path: string, opts?: object) => {
 *   pragma: (s: string, o?: object) => unknown,
 *   prepare: (sql: string) => { run: (...a: unknown[]) => unknown },
 *   close: () => void,
 * }} Database
 * @param {string} dbPath
 * @param {{ busyTimeoutMs?: number }} [deps]
 * @returns {{ ok: true, release: () => void } | { ok: false, reason: string }}
 */
export function acquireApplyLock(Database, dbPath, deps = {}) {
  const { busyTimeoutMs = 2000 } = deps;
  const db = new Database(dbPath);
  try {
    db.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    db.prepare('BEGIN IMMEDIATE').run();
  } catch (err) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason:
        `could not take the write lock (${msg}) — another connection is writing; ` +
        'stop every neuromcp client first',
    };
  }
  return {
    ok: true,
    release() {
      try {
        db.prepare('ROLLBACK').run();
      } catch {
        /* transaction already gone */
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string | null} flagDb
 * @param {string} [home]
 * @returns {string}
 */
export function resolveDbPath(env, flagDb, home = homedir()) {
  if (flagDb !== null && flagDb !== undefined) return resolve(flagDb);
  return resolve(env.NEUROMCP_DB_PATH ?? resolve(home, '.neuromcp', 'memory.db'));
}

/**
 * `<db>.reembed-<timestamp>` — same directory, so the rename is atomic.
 *
 * @param {string} dbPath
 * @param {() => Date} [now]
 * @returns {string}
 */
export function buildCopyPath(dbPath, now = () => new Date()) {
  return `${dbPath}.reembed-${now().toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * @param {string} dbPath
 * @param {() => Date} [now]
 * @returns {string}
 */
export function buildBackupPath(dbPath, now = () => new Date()) {
  return `${dbPath}.pre-reembed-${now().toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Parse the width out of the vec0 DDL.
 *
 * @param {{ prepare: (sql: string) => { get: (...a: unknown[]) => unknown } }} db
 * @returns {number | null}
 */
export function readVecDimension(db) {
  const row = /** @type {{ sql?: unknown } | undefined} */ (
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_vec'").get()
  );
  if (row === undefined || typeof row.sql !== 'string') return null;
  const m = row.sql.match(/float\[(\d+)\]/);
  return m ? Number(m[1]) : null;
}

/**
 * @param {string} spec
 * @returns {any}
 */
function requireFrom(spec) {
  return createRequire(import.meta.url)(spec);
}

async function loadDist() {
  const distDir = resolve(REPO_ROOT, 'dist');
  if (!existsSync(resolve(distDir, 'index.js'))) {
    throw new Error(`dist/ missing at ${distDir} — run \`npm run build\` first`);
  }
  const [factory, cfg, log, vec] = await Promise.all([
    import(pathToFileURL(resolve(distDir, 'embeddings/factory.js')).href),
    import(pathToFileURL(resolve(distDir, 'config.js')).href),
    import(pathToFileURL(resolve(distDir, 'observability/logger.js')).href),
    import(pathToFileURL(resolve(distDir, 'vectors/sqlite-vec.js')).href),
  ]);
  return {
    createEmbeddingProvider: factory.createEmbeddingProvider,
    loadConfig: cfg.loadConfig,
    createLogger: log.createLogger,
    SqliteVecStore: vec.SqliteVecStore,
  };
}

/**
 * Rebuild the vector index of `copyPath` with `embedder`. The copy must
 * already exist. Returns counts for the report.
 *
 * @param {string} copyPath
 * @param {{ name: string, dimensions: number, embedBatch: (texts: string[]) => Promise<Float32Array[]> }} embedder
 * @param {{
 *   Database: any,
 *   SqliteVecStore: any,
 *   limit?: number | null,
 *   log?: (s: string) => void,
 *   loadVec?: (db: any) => void,
 * }} deps
 * @returns {Promise<{ total: number, embedded: number, errors: number, oldDim: number | null, newDim: number }>}
 */
export async function rebuildIndex(copyPath, embedder, deps) {
  const {
    Database,
    SqliteVecStore,
    limit = null,
    log = () => {},
    loadVec = (db) => requireFrom('sqlite-vec').load(db),
  } = deps;
  const db = new Database(copyPath);
  try {
    db.pragma('journal_mode = WAL');
    const oldDim = readVecDimension(db);

    // The vec0 module must be loaded on THIS connection before a vec0 table
    // can even be dropped ("no such module: vec0" otherwise).
    loadVec(db);

    // Drop + recreate at the new width. This is the ONLY destructive step,
    // and it happens on the copy.
    db.exec('DROP TABLE IF EXISTS memories_vec');
    const store = new SqliteVecStore(embedder.dimensions);
    store.initialize(db);

    let rows = /** @type {Array<{ id: string, content: string }>} */ (
      db.prepare('SELECT id, content FROM memories WHERE is_deleted = 0 ORDER BY created_at').all()
    );
    if (limit !== null) rows = rows.slice(0, limit);

    let embedded = 0;
    let errors = 0;
    const batchSize = 16;
    const update = db.prepare(
      'UPDATE memories SET embedding_model = ?, embedding_dim = ? WHERE id = ?',
    );
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      try {
        const vectors = await embedder.embedBatch(batch.map((r) => r.content));
        store.upsertBatch(batch.map((r, idx) => ({ id: r.id, embedding: vectors[idx] })));
        const writeAll = db.transaction(() => {
          for (const r of batch) update.run(embedder.name, embedder.dimensions, r.id);
        });
        writeAll();
        embedded += batch.length;
      } catch (err) {
        errors += batch.length;
        log(`  ! batch at ${i} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (i > 0 && i % (batchSize * 10) === 0) {
        log(`  … ${embedded}/${rows.length} embedded`);
      }
    }
    return { total: rows.length, embedded, errors, oldDim, newDim: embedder.dimensions };
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

function printHelp() {
  process.stdout.write(`
neuromcp-reembed — rebuild the vector index for a new embedding provider

Usage:
  neuromcp-reembed [--db <path>] [--apply] [--keep-copy] [--limit <n>] [--force]

  (no flags)    dry run: rebuild on a COPY, report, delete the copy
  --apply       rebuild on a copy, then swap it in (original kept as
                <db>.pre-reembed-<timestamp>)
  --keep-copy   dry run but leave the rebuilt copy on disk for inspection
  --limit <n>   only embed the first n memories (smoke test)
  --db <path>   database to work on (default: $NEUROMCP_DB_PATH or ~/.neuromcp/memory.db)
  --force       skip the live-client guard on --apply (NOT recommended)

Stop every neuromcp client (Claude Desktop / Claude Code / Codex / the daemon)
before running with --apply. The swap refuses (exit 3) while another process
still has the database open or a connection is actively reading/writing, and
holds SQLite's write lock for the whole rebuild — a straggler client that
tries to write during it gets SQLITE_BUSY instead of silently losing data.
`);
}

async function main() {
  let args;
  try {
    args = parseReembedArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`neuromcp-reembed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
    return;
  }
  if (args.help) {
    printHelp();
    process.exit(0);
    return;
  }

  const dbPath = resolveDbPath(process.env, args.db);
  if (!existsSync(dbPath)) {
    process.stderr.write(`neuromcp-reembed: no database at ${dbPath}\n`);
    process.exit(2);
    return;
  }

  const Database = requireFrom('better-sqlite3');
  const { createEmbeddingProvider, loadConfig, createLogger, SqliteVecStore } = await loadDist();
  const config = loadConfig();
  const logger = createLogger({ level: 'warn', format: 'text' });

  const embedder = await createEmbeddingProvider(config, logger);

  // --apply preflight: refuse BEFORE minutes of embedding work when a
  // client is clearly attached, then take the write lock that makes
  // interim writes impossible for the whole snapshot→rebuild→swap window.
  // Order matters: the guard's wal_checkpoint(TRUNCATE) folds the WAL into
  // the file FIRST (so the byte-copy backup is complete), the lock comes
  // after — a checkpoint cannot complete against a held write lock.
  let applyLock = null;
  if (args.apply && !args.force) {
    const verdict = guardApplySwap(Database, dbPath);
    if (verdict.ok !== true) {
      process.stderr.write(
        `\n✗ not starting: ${verdict.reason}.\n  Nothing was changed.\n\n`,
      );
      process.exit(3);
      return;
    }
    const lock = acquireApplyLock(Database, dbPath);
    if (lock.ok !== true) {
      process.stderr.write(
        `\n✗ not starting: ${lock.reason}.\n  Nothing was changed.\n\n`,
      );
      process.exit(3);
      return;
    }
    applyLock = lock;
  }

  const copyPath = buildCopyPath(dbPath);
  process.stdout.write(
    `\nneuromcp-reembed\n  database : ${dbPath}\n  provider : ${embedder.name} (${embedder.dimensions}d)\n`,
  );

  // Consistent copy via SQLite's backup API — safe with WAL and other readers.
  const source = new Database(dbPath, { readonly: true });
  try {
    const before = readVecDimension(source);
    process.stdout.write(
      `  index    : ${before === null ? 'none' : `${before}d`}\n  copy     : ${copyPath}\n\n`,
    );
    await source.backup(copyPath);
  } finally {
    try {
      source.close();
    } catch {
      /* ignore */
    }
  }

  const result = await rebuildIndex(copyPath, embedder, {
    Database,
    SqliteVecStore,
    limit: args.limit,
    log: (/** @type {string} */ s) => process.stdout.write(`${s}\n`),
  });

  process.stdout.write(
    `\n  rebuilt  : ${result.embedded}/${result.total} memories at ${result.newDim}d ` +
      `(was ${result.oldDim === null ? 'none' : `${result.oldDim}d`}), ${result.errors} error(s)\n`,
  );

  if (result.errors > 0) {
    process.stdout.write(
      `\n✗ errors during rebuild — NOT swapping anything in. The copy is at:\n  ${copyPath}\n`,
    );
    process.exit(1);
    return;
  }

  if (!args.apply) {
    if (args.keepCopy) {
      process.stdout.write(
        `\n✓ dry run complete. Rebuilt copy kept at:\n  ${copyPath}\n` +
          `  Inspect it with: NEUROMCP_DB_PATH=${copyPath} npx neuromcp-doctor check\n` +
          '  Re-run with --apply to swap it in.\n\n',
      );
    } else {
      unlinkSync(copyPath);
      for (const sidecar of [`${copyPath}-wal`, `${copyPath}-shm`]) {
        try {
          unlinkSync(sidecar);
        } catch {
          /* no sidecar */
        }
      }
      process.stdout.write(
        '\n✓ dry run complete, copy removed. Re-run with --apply to swap it in ' +
          '(or --keep-copy to inspect it first).\n\n',
      );
    }
    process.exit(0);
    return;
  }

  // Final pre-swap check. The write lock has been held since BEFORE the
  // snapshot, so no client can have committed in between — interim writes
  // are prevented, not merely detected (a straggler writer got SQLITE_BUSY
  // at its own end). NO checkpoint runs here: it could not complete against
  // our own lock, and a TRUNCATE checkpoint is exactly what made the
  // earlier data_version sentinel fire falsely. The only remaining risk is
  // a process that ATTACHED during the rebuild (idle, no lock yet, would
  // write to the renamed-away inode after the swap) — re-check lsof for
  // that. Refusal keeps the rebuilt copy: only the swap is blocked.
  if (!args.force) {
    const attachment = listAttachedPids(dbPath);
    const problem = !attachment.available
      ? 'cannot verify that no client attached during the rebuild (lsof unavailable)'
      : attachment.pids.length > 0
        ? `processes attached to the database during the rebuild (pid ${attachment.pids.join(', ')})`
        : null;
    if (problem !== null) {
      applyLock?.release();
      process.stderr.write(
        `\n✗ not swapping: ${problem}.\n` +
          `  Nothing was changed. The rebuilt copy is kept at:\n  ${copyPath}\n` +
          '  Stop the clients and re-run with --apply (or add --force to override).\n\n',
      );
      process.exit(3);
      return;
    }
  }

  const backupPath = buildBackupPath(dbPath);
  copyFileSync(dbPath, backupPath);
  renameSync(copyPath, dbPath);
  applyLock?.release();
  process.stdout.write(
    `\n✓ applied. ${dbPath} now has a ${result.newDim}d index.\n` +
      `  Original kept at: ${backupPath}\n` +
      '  Rollback: stop all clients, then move that file back over the database.\n' +
      '  Restart your MCP clients.\n\n',
  );
  process.exit(0);
}

if (isMainModule(import.meta.url)) {
  void main();
}
