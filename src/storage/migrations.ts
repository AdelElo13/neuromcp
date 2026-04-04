import { copyFileSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import type { Logger } from '../observability/logger.js';
import { applySchema, SCHEMA_VERSION } from './schema.js';

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

export function runMigrations(db: Database, dbPath: string, logger: Logger): void {
  const currentVersion = getCurrentVersion(db);

  if (currentVersion >= SCHEMA_VERSION) {
    logger.debug('migrations', 'Schema is up to date', {
      currentVersion,
      targetVersion: SCHEMA_VERSION,
    });
    return;
  }

  // Back up before migration (only if DB has existing data)
  if (currentVersion > 0) {
    const backupPath = `${dbPath}.backup-v${currentVersion}`;
    logger.info('migrations', 'Backing up database before migration', {
      from: currentVersion,
      to: SCHEMA_VERSION,
      backupPath,
    });
    copyFileSync(dbPath, backupPath);
  }

  logger.info('migrations', 'Applying schema migration', {
    from: currentVersion,
    to: SCHEMA_VERSION,
  });

  applySchema(db);
  recordVersion(db, SCHEMA_VERSION, `Migration from v${currentVersion} to v${SCHEMA_VERSION}`);

  logger.info('migrations', 'Schema migration complete', {
    version: SCHEMA_VERSION,
  });
}
