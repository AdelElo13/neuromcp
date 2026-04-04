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
});
