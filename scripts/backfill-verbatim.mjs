#!/usr/bin/env node
/**
 * neuromcp-backfill-verbatim — import raw session archives into verbatim table.
 *
 * Raw sessions live as markdown files under ~/.neuromcp/raw/sessions/ — one
 * per session with user prompts + tool calls + file modifications. This
 * script reads each file and stores it verbatim in the SQLite `verbatim`
 * table, which is the authoritative store for "exact recall" queries
 * ("we talked about X on date Y"). Idempotent via content_hash dedup.
 *
 * Usage:
 *   node scripts/backfill-verbatim.mjs           # all
 *   node scripts/backfill-verbatim.mjs --limit 100
 *   node scripts/backfill-verbatim.mjs --since 2026-04-10
 *   node scripts/backfill-verbatim.mjs --dry-run
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

const HOME = homedir();
const DB_PATH = process.env.NEUROMCP_DB || join(HOME, '.neuromcp', 'memory.db');
const SESSIONS_DIR = join(HOME, '.neuromcp', 'raw', 'sessions');

const args = process.argv.slice(2);
const opts = { limit: null, since: null, dryRun: false };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit') opts.limit = parseInt(args[++i], 10);
  else if (args[i] === '--since') opts.since = args[++i];
  else if (args[i] === '--dry-run') opts.dryRun = true;
}

if (!existsSync(DB_PATH)) {
  console.error(`DB not found: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const insert = db.prepare(`
  INSERT OR IGNORE INTO verbatim (id, content, content_hash, namespace, metadata, created_at)
  VALUES (?, ?, ?, 'default', ?, ?)
`);

const exists = db.prepare(`SELECT 1 FROM verbatim WHERE content_hash = ?`).pluck();

const files = readdirSync(SESSIONS_DIR)
  .filter((f) => f.endsWith('.md') && !f.includes('checkpoint'))
  .sort();

let filtered = files;
if (opts.since) filtered = filtered.filter((f) => f >= opts.since);
if (opts.limit) filtered = filtered.slice(-opts.limit);

console.log(`verbatim backfill: ${filtered.length}/${files.length} sessions in scope (dry-run=${opts.dryRun})`);

let imported = 0;
let skipped = 0;
for (const name of filtered) {
  const path = join(SESSIONS_DIR, name);
  const content = readFileSync(path, 'utf8');
  const hash = createHash('sha256').update(content).digest('hex');
  if (exists.get(hash)) {
    skipped++;
    continue;
  }
  if (opts.dryRun) {
    imported++;
    continue;
  }
  const id = randomBytes(16).toString('hex');
  // Extract date from filename (format: YYYY-MM-DD-HHMM.md)
  const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})/);
  const createdAt = dateMatch ? `${dateMatch[1]}T00:00:00.000Z` : new Date().toISOString();
  const metadata = JSON.stringify({ source_file: name, source: 'raw_session_backfill' });
  insert.run(id, content, hash, metadata, createdAt);
  imported++;
}

console.log(`done: ${imported} imported, ${skipped} already present (deduplicated by content hash)`);
db.close();
