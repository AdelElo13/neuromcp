import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { openDatabase, closeDatabase } from '../../src/storage/database.js';
import { SCHEMA_VERSION } from '../../src/storage/schema.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { createLogger } from '../../src/observability/logger.js';

function tmpDbPath(): string {
  return join(tmpdir(), `neuromcp-mig-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

const cleanupPaths: string[] = [];
const logger = createLogger({ level: 'error', format: 'text' });

function cleanup(p: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const full = `${p}${suffix}`;
      if (existsSync(full)) unlinkSync(full);
    } catch {
      // ignore
    }
  }
  // also clean up backup files
  try {
    for (let v = 0; v <= 10; v++) {
      const backup = `${p}.backup-v${v}`;
      if (existsSync(backup)) unlinkSync(backup);
    }
  } catch {
    // ignore
  }
}

afterEach(() => {
  closeDatabase();
  for (const p of cleanupPaths) {
    cleanup(p);
  }
  cleanupPaths.length = 0;
});

describe('runMigrations', () => {
  it('applies schema on a fresh database', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    runMigrations(db, dbPath, logger);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('memories');
    expect(tableNames).toContain('schema_version');
    expect(tableNames).toContain('memories_fts');
  });

  it('records the schema version', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    runMigrations(db, dbPath, logger);

    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number };
    expect(row.version).toBe(SCHEMA_VERSION);
  });

  it('is idempotent — running twice does not fail', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    runMigrations(db, dbPath, logger);
    runMigrations(db, dbPath, logger);

    const rows = db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>;
    // Should still have exactly one version record (INSERT OR REPLACE)
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(SCHEMA_VERSION);
  });

  it('on fresh DB (version 0) does not create a backup', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    runMigrations(db, dbPath, logger);

    const backupPath = `${dbPath}.backup-v0`;
    expect(existsSync(backupPath)).toBe(false);
  });

  it('does not re-apply when already at current version', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    runMigrations(db, dbPath, logger);

    // Insert a canary row
    db.prepare("INSERT INTO memories (id, content_hash, content) VALUES ('canary', 'hash', 'test')").run();

    // Run migrations again — should be a no-op
    runMigrations(db, dbPath, logger);

    const row = db.prepare("SELECT id FROM memories WHERE id = 'canary'").get() as { id: string } | undefined;
    expect(row?.id).toBe('canary');
  });

  // v13: Codex SOTA recall layer — situation graph, semantic cards,
  // working context, replay queue, and memories.{source_type,source_path,
  // project,kind,happened_at}. The auto-retrieve hook reads ALL of these;
  // a fresh install previously left them missing, causing six-layer
  // recall to silently return empty additionalContext.
  it('v13: creates all recall-layer extension tables', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    runMigrations(db, dbPath, logger);

    const required = [
      'memory_atoms',
      'memory_edges',
      'activation_cache',
      'situation_states',
      'working_context',
      'semantic_cards',
      'semantic_card_evidence',
      'replay_queue',
    ];
    for (const name of required) {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(name) as { name: string } | undefined;
      expect(row?.name, `expected table "${name}" to exist after migration`).toBe(name);
    }
  });

  it('v13: adds recall-planner metadata columns to memories', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    runMigrations(db, dbPath, logger);

    const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    for (const col of ['source_type', 'source_path', 'project', 'kind', 'happened_at']) {
      expect(colNames.has(col), `expected memories.${col} column to exist`).toBe(true);
    }
  });

  it('v13: migrates a v12 database in place without dropping data', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    // Bootstrap a v12 schema by running migrations, then forcibly
    // rewriting the version row and dropping the v13 artifacts.
    runMigrations(db, dbPath, logger);
    db.prepare("INSERT INTO memories (id, content_hash, content) VALUES ('keep-me', 'hash', 'pre-v13 content')").run();

    db.prepare('DELETE FROM schema_version').run();
    db.prepare(
      "INSERT INTO schema_version (version, applied_at, description) VALUES (12, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'simulated v12')"
    ).run();
    // Drop the v13 tables to simulate a v12-era DB upgrading to v13.
    for (const t of ['replay_queue', 'situation_states', 'activation_cache', 'memory_edges', 'memory_atoms', 'semantic_card_evidence', 'semantic_cards', 'working_context']) {
      db.prepare(`DROP TABLE IF EXISTS ${t}`).run();
    }

    // Run again — should detect v12 → v13 and reconcile.
    runMigrations(db, dbPath, logger);

    // Pre-existing data preserved
    const keep = db.prepare("SELECT id FROM memories WHERE id='keep-me'").get() as { id: string } | undefined;
    expect(keep?.id).toBe('keep-me');

    // All v13 tables present
    const required = ['memory_atoms', 'situation_states', 'working_context', 'semantic_cards', 'replay_queue'];
    for (const name of required) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as { name: string } | undefined;
      expect(row?.name, `expected table "${name}" after v12→v13 upgrade`).toBe(name);
    }

    // Version recorded as v13 (= SCHEMA_VERSION)
    const ver = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(ver.v).toBe(SCHEMA_VERSION);
  });
});
