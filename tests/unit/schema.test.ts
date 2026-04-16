import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { openDatabase, closeDatabase } from '../../src/storage/database.js';
import { applySchema, SCHEMA_VERSION } from '../../src/storage/schema.js';

function tmpDbPath(): string {
  return join(tmpdir(), `neuromcp-schema-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

const cleanupPaths: string[] = [];

function cleanup(p: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const full = `${p}${suffix}`;
      if (existsSync(full)) unlinkSync(full);
    } catch {
      // ignore
    }
  }
}

afterEach(() => {
  closeDatabase();
  for (const p of cleanupPaths) {
    cleanup(p);
  }
  cleanupPaths.length = 0;
});

function getTableNames(db: ReturnType<typeof openDatabase>): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function getColumnNames(db: ReturnType<typeof openDatabase>, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('applySchema', () => {
  it('creates all expected tables', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);
    applySchema(db);

    const tables = getTableNames(db);
    expect(tables).toContain('memories');
    expect(tables).toContain('consolidation_log');
    expect(tables).toContain('operations');
    expect(tables).toContain('schema_version');
    expect(tables).toContain('memories_fts');
  });

  it('memories table has all governance columns', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);
    applySchema(db);

    const columns = getColumnNames(db, 'memories');
    const expected = [
      'id', 'content_hash', 'content', 'summary',
      'embedding_model', 'embedding_dim', 'namespace',
      'project_id', 'agent_id', 'source', 'source_trust',
      'visibility', 'schema_version', 'category', 'tags',
      'importance', 'access_count', 'created_at', 'updated_at',
      'last_accessed_at', 'expires_at', 'is_deleted',
      'tombstoned_at', 'supersedes_id', 'superseded_by_id', 'metadata',
    ];
    for (const col of expected) {
      expect(columns).toContain(col);
    }
  });

  it('consolidation_log table has correct columns', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);
    applySchema(db);

    const columns = getColumnNames(db, 'consolidation_log');
    const expected = [
      'id', 'operation_id', 'action', 'source_ids',
      'result_id', 'plan_snapshot', 'reason', 'namespace', 'created_at',
    ];
    for (const col of expected) {
      expect(columns).toContain(col);
    }
  });

  it('operations table has correct columns', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);
    applySchema(db);

    const columns = getColumnNames(db, 'operations');
    const expected = [
      'id', 'type', 'status', 'namespace', 'started_at',
      'completed_at', 'items_total', 'items_processed', 'error', 'metadata',
    ];
    for (const col of expected) {
      expect(columns).toContain(col);
    }
  });

  it('is idempotent — calling twice does not throw', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);
    applySchema(db);
    applySchema(db); // second call should not throw

    const tables = getTableNames(db);
    expect(tables).toContain('memories');
    expect(tables).toContain('memories_fts');
  });

  it('creates indexes', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);
    applySchema(db);

    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all() as Array<{ name: string }>;
    const indexNames = rows.map((r) => r.name);

    expect(indexNames).toContain('idx_memories_namespace');
    expect(indexNames).toContain('idx_memories_content_hash');
    expect(indexNames).toContain('idx_memories_category');
    expect(indexNames).toContain('idx_memories_importance');
    expect(indexNames).toContain('idx_memories_is_deleted');
    expect(indexNames).toContain('idx_memories_namespace_deleted');
    expect(indexNames).toContain('idx_consolidation_log_operation_id');
    expect(indexNames).toContain('idx_operations_type');
  });
});

describe('SCHEMA_VERSION', () => {
  it('equals 8', () => {
    expect(SCHEMA_VERSION).toBe(8);
  });
});
