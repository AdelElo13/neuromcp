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
 *   npx neuromcp-backfill-embeddings --where "category='wiki'"
 *   npx neuromcp-backfill-embeddings --limit 100
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
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
const whereIdx = args.indexOf('--where');
const EXTRA_WHERE = whereIdx !== -1 ? args[whereIdx + 1] : null;

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

// Build query. We respect any extra filter the caller passed via --where.
const whereClauses = ['is_deleted = 0', '(embedding_dim = 0 OR embedding_dim IS NULL)'];
if (EXTRA_WHERE) whereClauses.push(`(${EXTRA_WHERE})`);
const where = whereClauses.join(' AND ');
const countSql = `SELECT COUNT(*) AS n FROM memories WHERE ${where}`;
const total = db.prepare(countSql).get().n;
info(`${total} memories need embedding`);
if (total === 0) { db.close(); process.exit(0); }
if (DRY_RUN) { db.close(); process.exit(0); }

const selectSql = `
  SELECT id, content FROM memories
  WHERE ${where}
  ORDER BY created_at DESC
  ${LIMIT ? `LIMIT ${LIMIT}` : ''}
`;
const rows = db.prepare(selectSql).all();

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
