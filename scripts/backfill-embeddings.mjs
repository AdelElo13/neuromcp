#!/usr/bin/env node
/**
 * neuromcp backfill-embeddings — one-shot embed + upsert for memories
 * that were stored before (or without) a working embedding provider.
 *
 * Walks `memories WHERE embedding_dim = 0 AND is_deleted = 0`, computes
 * embeddings via the same factory used by the MCP server, and upserts
 * rows into `memories_vec`. Safe to re-run — already-embedded rows
 * are skipped via their embedding_dim column.
 *
 * Usage:
 *   npx neuromcp-backfill-embeddings            # all unembedded memories
 *   npx neuromcp-backfill-embeddings --category wiki
 *   npx neuromcp-backfill-embeddings --limit 100
 *   npx neuromcp-backfill-embeddings --rebuild-vec
 *   npx neuromcp-backfill-embeddings --dry-run
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const DB_PATH = process.env.NEUROMCP_DB || join(HOME, '.neuromcp', 'memory.db');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const REBUILD_VEC = args.includes('--rebuild-vec');
const limitIdx = args.indexOf('--limit');

function parseLimit(raw) {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100000) {
    console.error(`  ✗ --limit must be integer in [1, 100000] (got ${raw})`);
    process.exit(2);
  }
  return n;
}
const LIMIT = limitIdx !== -1 ? parseLimit(args[limitIdx + 1]) : null;

// Category filter — typed, no raw SQL.
const CATEGORY_WHITELIST = new Set(['wiki', 'fact', 'general', 'system', 'infrastructure', 'product', 'person', 'project', 'meta']);
const catIdx = args.indexOf('--category');
let CATEGORY_FILTER = null;
if (catIdx !== -1) {
  const raw = args[catIdx + 1];
  if (!CATEGORY_WHITELIST.has(raw)) {
    console.error(`  ✗ --category must be one of: ${[...CATEGORY_WHITELIST].join(', ')} (got ${raw})`);
    process.exit(2);
  }
  CATEGORY_FILTER = raw;
}

function ok(msg) { console.log(`  ✓ ${msg}`); }
function info(msg) { console.log(`  · ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); process.exit(1); }

if (!existsSync(DB_PATH)) fail(`db not found: ${DB_PATH}`);

// Resolve neuromcp dist for embedding factory.
const distRoot = join(__dirname, '..', 'dist');
if (!existsSync(distRoot)) fail('neuromcp dist/ not found — are you running from the package?');

const [{ createEmbeddingProvider }, { loadConfig }, { createLogger }] = await Promise.all([
  import(join(distRoot, 'embeddings', 'factory.js')),
  import(join(distRoot, 'config.js')),
  import(join(distRoot, 'observability', 'logger.js')),
]);

const config = loadConfig();
const logger = createLogger(config);
const embedder = await createEmbeddingProvider(config, logger);
ok(`embedder: ${embedder.name} (dim=${embedder.dimensions})`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
try { sqliteVec.load(db); } catch (err) { fail(`sqlite-vec load failed: ${err.message}`); }

// Typed WHERE — no user SQL interpolated. Category is already whitelist-
// checked above; LIMIT is integer-validated. No injection surface.
const params = [];
const whereClauses = ['is_deleted = 0'];
if (!REBUILD_VEC) whereClauses.push('(embedding_dim = 0 OR embedding_dim IS NULL)');
if (CATEGORY_FILTER) {
  whereClauses.push('category = ?');
  params.push(CATEGORY_FILTER);
}
const where = whereClauses.join(' AND ');
const total = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${where}`).get(...params).n;
info(`${total} memories need embedding${REBUILD_VEC ? ' (rebuild-vec mode: re-embedding all)' : ''}`);
if (total === 0) { db.close(); process.exit(0); }
if (DRY_RUN) { db.close(); process.exit(0); }

const limitClause = LIMIT ? ` LIMIT ${LIMIT}` : '';
const rows = db.prepare(
  `SELECT id, content FROM memories WHERE ${where} ORDER BY created_at DESC${limitClause}`,
).all(...params);

const updateMem = db.prepare(`
  UPDATE memories SET embedding_model = ?, embedding_dim = ? WHERE id = ?
`);
const upsertVec = db.transaction((id, vector) => {
  const buf = Buffer.from(Float32Array.from(vector).buffer);
  db.prepare(`DELETE FROM memories_vec WHERE id = ?`).run(id);
  db.prepare(`INSERT INTO memories_vec (id, embedding) VALUES (?, ?)`).run(id, buf);
});

let done = 0;
let failed = 0;
const startMs = Date.now();
for (const row of rows) {
  try {
    const vec = await embedder.embed(row.content);
    upsertVec(row.id, vec);
    updateMem.run(embedder.name, vec.length, row.id);
    done++;
    if (done % 25 === 0) info(`${done}/${rows.length} …`);
  } catch (err) {
    failed++;
    process.stderr.write(`[backfill] skipped ${row.id}: ${err?.message || err}\n`);
  }
}
const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
ok(`embedded ${done} rows in ${elapsed}s (${failed} failed, ${embedder.name})`);
db.close();
