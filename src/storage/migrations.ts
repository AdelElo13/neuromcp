import { existsSync, unlinkSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import type { Logger } from '../observability/logger.js';
import { applySchema, SCHEMA_VERSION } from './schema.js';

/**
 * Run an idempotent ALTER TABLE ... ADD COLUMN. Swallows ONLY the
 * "duplicate column name" error (the re-run case); every other failure —
 * SQLITE_BUSY, I/O errors, missing table — propagates so the migration
 * aborts BEFORE the schema version is stamped. The old blanket catch{}
 * could leave a DB permanently marked migrated with the migration half
 * applied.
 */
export function tryAlterAddColumn(db: Database, stmt: string): void {
  try {
    db.prepare(stmt).run();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate column name/i.test(msg)) return;
    throw err;
  }
}

/**
 * Consistent point-in-time backup of a live database. copyFileSync on a
 * WAL-mode DB can miss recent commits that only exist in the -wal file (or
 * tear mid-checkpoint); VACUUM INTO produces a transactionally consistent
 * snapshot regardless of WAL state.
 */
export function backupDatabase(db: Database, backupPath: string): void {
  if (existsSync(backupPath)) unlinkSync(backupPath);
  db.prepare('VACUUM INTO ?').run(backupPath);
}

function getCurrentVersion(db: Database): number {
  // Check if schema_version table exists
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
  ).get() as { name: string } | undefined;

  if (row === undefined) {
    return 0;
  }

  const versionRow = db.prepare(
    'SELECT MAX(version) AS version FROM schema_version'
  ).get() as { version: number | null } | undefined;

  return versionRow?.version ?? 0;
}

function recordVersion(db: Database, version: number, description: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO schema_version (version, applied_at, description) VALUES (?, strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\'), ?)'
  ).run(version, description);
}

function migrateV1ToV2(db: Database, logger: Logger): void {
  logger.info('migrations', 'Running v1 to v2 migration: knowledge graph + temporal + cognitive');

  const alterStatements = [
    'ALTER TABLE memories ADD COLUMN valid_from TEXT',
    'ALTER TABLE memories ADD COLUMN valid_to TEXT',
    'ALTER TABLE memories ADD COLUMN surprise_score REAL NOT NULL DEFAULT 0.0',
  ];

  for (const stmt of alterStatements) {
    tryAlterAddColumn(db, stmt);
  }

  applySchema(db);
}

export function runMigrations(db: Database, dbPath: string, logger: Logger): void {
  const currentVersion = getCurrentVersion(db);

  if (currentVersion >= SCHEMA_VERSION) {
    logger.debug('migrations', 'Schema is up to date', {
      currentVersion,
      targetVersion: SCHEMA_VERSION,
    });
    return;
  }

  if (currentVersion > 0) {
    const backupPath = `${dbPath}.backup-v${currentVersion}`;
    logger.info('migrations', 'Backing up database before migration', {
      from: currentVersion,
      to: SCHEMA_VERSION,
      backupPath,
    });
    backupDatabase(db, backupPath);
  }

  logger.info('migrations', 'Applying schema migration', {
    from: currentVersion,
    to: SCHEMA_VERSION,
  });

  // Fresh database (no memories table at all): there is nothing to migrate —
  // apply the canonical schema and stamp the current version. Distinguish
  // "fresh" from "legacy pre-versioning DB with data": the latter HAS a
  // memories table but no schema_version table, and must run the legacy
  // migration chain below. The old code relied on the legacy ALTERs failing
  // with "no such table" and being silently swallowed on fresh DBs — that
  // blanket swallow also hid real migration failures, which is exactly what
  // tryAlterAddColumn now prevents.
  const hasMemoriesTable =
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
      .get() !== undefined;
  if (currentVersion === 0 && !hasMemoriesTable) {
    applySchema(db);
    recordVersion(db, SCHEMA_VERSION, 'Fresh install');
    logger.info('migrations', 'Fresh database initialized', { version: SCHEMA_VERSION });
    return;
  }

  if (currentVersion < 2) {
    migrateV1ToV2(db, logger);
  }

  if (currentVersion < 3) {
    logger.info('migrations', 'Running v2 to v3 migration: claims table, HTTP transport support');
    applySchema(db);
  }

  if (currentVersion < 4) {
    logger.info('migrations', 'Running v3 to v4 migration: episodes table, episode_id on memories');
    // episodes table is created by applySchema, just add column to existing memories
    tryAlterAddColumn(db, 'ALTER TABLE memories ADD COLUMN episode_id TEXT REFERENCES episodes(id)');
    applySchema(db);
  }

  if (currentVersion < 5) {
    logger.info('migrations', 'Running v4 to v5 migration: clusters table, cluster_id on memories');
    tryAlterAddColumn(db, 'ALTER TABLE memories ADD COLUMN cluster_id TEXT REFERENCES clusters(id)');
    applySchema(db);
  }

  if (currentVersion < 6) {
    logger.info('migrations', 'Running v5 to v6 migration: spaced repetition, agent profiles');
    const alterStatements = [
      'ALTER TABLE memories ADD COLUMN review_interval_days REAL',
      'ALTER TABLE memories ADD COLUMN ease_factor REAL DEFAULT 2.5',
      'ALTER TABLE memories ADD COLUMN next_review_at TEXT',
      'ALTER TABLE memories ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0',
    ];
    for (const stmt of alterStatements) {
      tryAlterAddColumn(db, stmt);
    }
    applySchema(db);
  }

  if (currentVersion < 7) {
    logger.info('migrations', 'Running v6 to v7 migration: verbatim table + FTS5');
    applySchema(db);
  }

  if (currentVersion < 8) {
    logger.info('migrations', 'Running v7 to v8 migration: attention-based co-retrieval');
    const coRetrievalStatements = [
      `CREATE TABLE IF NOT EXISTS co_retrievals (
        memory_a TEXT NOT NULL,
        memory_b TEXT NOT NULL,
        co_count INTEGER NOT NULL DEFAULT 1,
        last_co_retrieved_at TEXT NOT NULL,
        PRIMARY KEY (memory_a, memory_b)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_co_retrievals_a ON co_retrievals(memory_a)',
      'CREATE INDEX IF NOT EXISTS idx_co_retrievals_b ON co_retrievals(memory_b)',
    ];
    for (const stmt of coRetrievalStatements) {
      // IF NOT EXISTS handles the re-run case; real errors must propagate.
      db.prepare(stmt).run();
    }
  }

  if (currentVersion < 9) {
    logger.info('migrations', 'Running v8 to v9 migration: retrieval attribution + critic-scored usefulness');
    const attributionStatements = [
      `CREATE TABLE IF NOT EXISTS retrieval_events (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        namespace TEXT NOT NULL DEFAULT 'default',
        retrieved_ids TEXT NOT NULL DEFAULT '[]',
        cited_ids TEXT NOT NULL DEFAULT '[]',
        outcome TEXT,
        critic_reason TEXT,
        model TEXT,
        critiqued_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
      'CREATE INDEX IF NOT EXISTS idx_retrieval_events_namespace ON retrieval_events(namespace)',
      'CREATE INDEX IF NOT EXISTS idx_retrieval_events_created ON retrieval_events(created_at)',
      'CREATE INDEX IF NOT EXISTS idx_retrieval_events_outcome ON retrieval_events(outcome)',
      'CREATE INDEX IF NOT EXISTS idx_retrieval_events_query_hash ON retrieval_events(query_hash)',
      `CREATE TABLE IF NOT EXISTS memory_usefulness (
        memory_id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL DEFAULT 'default',
        helpful_count INTEGER NOT NULL DEFAULT 0,
        neutral_count INTEGER NOT NULL DEFAULT 0,
        harmful_count INTEGER NOT NULL DEFAULT 0,
        total_observed INTEGER NOT NULL DEFAULT 0,
        usefulness_score REAL NOT NULL DEFAULT 0.5,
        last_updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        decay_floor REAL NOT NULL DEFAULT 0.5
      )`,
      'CREATE INDEX IF NOT EXISTS idx_memory_usefulness_namespace ON memory_usefulness(namespace)',
      'CREATE INDEX IF NOT EXISTS idx_memory_usefulness_score ON memory_usefulness(usefulness_score)',
    ];
    for (const stmt of attributionStatements) {
      // IF NOT EXISTS handles the re-run case; real errors must propagate.
      db.prepare(stmt).run();
    }
  }

  if (currentVersion < 10) {
    logger.info('migrations', 'Running v9 to v10 migration: last_critiqued_at column for decay');
    const v10Statements = [
      'ALTER TABLE memory_usefulness ADD COLUMN last_critiqued_at TEXT',
    ];
    for (const stmt of v10Statements) {
      tryAlterAddColumn(db, stmt);
    }
  }

  if (currentVersion < 11) {
    logger.info('migrations', 'Running v10 to v11 migration: retrieval-memory join table');
    const v11Statements = [
      `CREATE TABLE IF NOT EXISTS retrieval_event_memories (
        event_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        rank INTEGER NOT NULL DEFAULT 0,
        was_cited INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (event_id, memory_id),
        FOREIGN KEY (event_id) REFERENCES retrieval_events(id) ON DELETE CASCADE
      )`,
      'CREATE INDEX IF NOT EXISTS idx_rem_memory ON retrieval_event_memories(memory_id)',
      'CREATE INDEX IF NOT EXISTS idx_rem_cited ON retrieval_event_memories(was_cited)',
    ];
    for (const stmt of v11Statements) {
      // IF NOT EXISTS handles the re-run case; real errors must propagate.
      db.prepare(stmt).run();
    }
  }

  if (currentVersion < 12) {
    logger.info('migrations', 'Running v11 to v12 migration: session_id on retrieval_events + backfill historical join rows');
    // Add session_id column (nullable for backwards compat)
    tryAlterAddColumn(db, 'ALTER TABLE retrieval_events ADD COLUMN session_id TEXT');
    db.prepare('CREATE INDEX IF NOT EXISTS idx_retrieval_events_session ON retrieval_events(session_id)').run();
    // Backfill: for every historical event, explode retrieved_ids/cited_ids
    // JSON into the retrieval_event_memories join table. Previously
    // v11 migration only created the empty table; historical data
    // stayed in JSON blobs only.
    try {
      const events = db.prepare('SELECT id, retrieved_ids, cited_ids FROM retrieval_events').all() as Array<{ id: string; retrieved_ids: string; cited_ids: string }>;
      const insert = db.prepare(
        'INSERT OR IGNORE INTO retrieval_event_memories (event_id, memory_id, rank, was_cited) VALUES (?, ?, ?, ?)'
      );
      const backfillTx = db.transaction(() => {
        let backfilled = 0;
        for (const ev of events) {
          let retrieved: string[] = [];
          let cited: string[] = [];
          try { retrieved = JSON.parse(ev.retrieved_ids); } catch { /* skip malformed */ }
          try { cited = JSON.parse(ev.cited_ids); } catch { /* skip malformed */ }
          const citedSet = new Set(cited);
          retrieved.forEach((mid, idx) => {
            insert.run(ev.id, mid, idx, citedSet.has(mid) ? 1 : 0);
            backfilled++;
          });
        }
        return backfilled;
      });
      const count = backfillTx();
      logger.info('migrations', 'v12 backfill complete', { rows: count });
    } catch (err) {
      logger.warn('migrations', 'v12 backfill skipped', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (currentVersion < 13) {
    logger.info('migrations', 'Running v12 to v13 migration: recall layer extension tables + memories metadata cols');

    // Step 1 — add planner-aware recall metadata cols on memories.
    // Idempotent: ALTER TABLE ADD COLUMN throws if column exists; swallow.
    const alterStatements = [
      'ALTER TABLE memories ADD COLUMN source_type TEXT',
      'ALTER TABLE memories ADD COLUMN source_path TEXT',
      'ALTER TABLE memories ADD COLUMN project TEXT',
      'ALTER TABLE memories ADD COLUMN kind TEXT',
      'ALTER TABLE memories ADD COLUMN happened_at TEXT',
    ];
    for (const stmt of alterStatements) {
      tryAlterAddColumn(db, stmt);
    }

    // Step 2 — apply schema. The CREATE TABLE IF NOT EXISTS / CREATE INDEX
    // IF NOT EXISTS statements in schema.ts cover the 9 v13 tables and
    // their indexes idempotently.
    applySchema(db);
  }

  if (currentVersion < 14) {
    logger.info('migrations', 'Running v13 to v14 migration: effective_importance split (user importance is never system-mutated)');
    tryAlterAddColumn(db, 'ALTER TABLE memories ADD COLUMN effective_importance REAL');
    // Backfill: today's stored importance IS the accumulated computed value
    // (surprise/dedup/adaptive/decay all wrote into it pre-v14), so it seeds
    // effective_importance. From here on the importance column only ever
    // carries user input.
    db.prepare(
      'UPDATE memories SET effective_importance = importance WHERE effective_importance IS NULL',
    ).run();
    applySchema(db);
  }

  recordVersion(db, SCHEMA_VERSION, `Migration from v${currentVersion} to v${SCHEMA_VERSION}`);

  logger.info('migrations', 'Schema migration complete', {
    version: SCHEMA_VERSION,
  });
}
