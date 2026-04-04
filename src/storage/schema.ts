import type { Database } from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT,
    embedding_model TEXT NOT NULL DEFAULT '',
    embedding_dim INTEGER NOT NULL DEFAULT 0,
    namespace TEXT NOT NULL DEFAULT 'default',
    project_id TEXT,
    agent_id TEXT,
    source TEXT NOT NULL DEFAULT 'user',
    source_trust TEXT NOT NULL DEFAULT 'medium',
    visibility TEXT NOT NULL DEFAULT 'namespace',
    schema_version INTEGER NOT NULL DEFAULT 1,
    category TEXT NOT NULL DEFAULT 'general',
    tags TEXT NOT NULL DEFAULT '[]',
    importance REAL NOT NULL DEFAULT 0.5,
    access_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_accessed_at TEXT,
    expires_at TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    tombstoned_at TEXT,
    supersedes_id TEXT,
    superseded_by_id TEXT,
    metadata TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS consolidation_log (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    action TEXT NOT NULL,
    source_ids TEXT NOT NULL DEFAULT '[]',
    result_id TEXT,
    plan_snapshot TEXT,
    reason TEXT,
    namespace TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    namespace TEXT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT,
    items_total INTEGER,
    items_processed INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    metadata TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    description TEXT
  );
`;

const CREATE_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
  CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
  CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
  CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
  CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
  CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);
  CREATE INDEX IF NOT EXISTS idx_memories_is_deleted ON memories(is_deleted);
  CREATE INDEX IF NOT EXISTS idx_memories_expires_at ON memories(expires_at);
  CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id);
  CREATE INDEX IF NOT EXISTS idx_memories_agent_id ON memories(agent_id);
  CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
  CREATE INDEX IF NOT EXISTS idx_memories_namespace_deleted ON memories(namespace, is_deleted);
  CREATE INDEX IF NOT EXISTS idx_consolidation_log_operation_id ON consolidation_log(operation_id);
  CREATE INDEX IF NOT EXISTS idx_consolidation_log_namespace ON consolidation_log(namespace);
  CREATE INDEX IF NOT EXISTS idx_operations_type ON operations(type);
  CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
  CREATE INDEX IF NOT EXISTS idx_operations_namespace ON operations(namespace);
`;

function ftsTableExists(db: Database): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
  ).get() as { name: string } | undefined;
  return row !== undefined;
}

export function applySchema(db: Database): void {
  db.exec(CREATE_TABLES);
  db.exec(CREATE_INDEXES);

  if (!ftsTableExists(db)) {
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        summary,
        tags,
        category,
        content='memories',
        content_rowid='rowid'
      );
    `);
  }
}
