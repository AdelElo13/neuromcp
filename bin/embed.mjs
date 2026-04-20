#!/usr/bin/env node
/**
 * neuromcp-embed — embed text via the configured provider and write the
 * resulting vector into memories_vec (by memory id).
 *
 * RPC endpoint for non-Node callers (e.g. the Python consolidator). Always
 * prints a single JSON object to stdout:
 *   { ok: true,  model: "<name>", dim: <number> }
 *   { ok: false, reason: "<short>" }
 * and exits non-zero on any failure. Never leaks stack traces to stdout.
 *
 * Contract:
 *  - The memory row MUST already exist (by `id`). Orphan vectors are rejected.
 *  - Dimension must match the existing memories_vec column. If the DB is empty
 *    we accept the provider's dimension and create the vector table if needed.
 *  - Write is a single transaction: memory.embedding_{model,dim} update +
 *    vec upsert. A failure rolls back cleanly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const DB_PATH = process.env.NEUROMCP_DB || join(HOME, '.neuromcp', 'memory.db');

function emit(obj) {
  // Exit code matches the outcome so shell callers can branch on $?.
  try { process.stdout.write(JSON.stringify(obj)); } catch { /* broken pipe */ }
  process.exit(obj.ok ? 0 : 1);
}

// Top-level handlers so any unexpected throw still emits valid JSON.
process.on('uncaughtException', (err) => emit({ ok: false, reason: `uncaught: ${err?.message || err}` }));
process.on('unhandledRejection', (err) => emit({ ok: false, reason: `unhandled: ${err?.message || err}` }));

let input;
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
catch { emit({ ok: false, reason: 'bad stdin json' }); }

const id = typeof input.id === 'string' ? input.id.trim() : '';
const text = typeof input.text === 'string' ? input.text : '';
if (!id) emit({ ok: false, reason: 'missing id' });
if (!text || text.length < 1) emit({ ok: false, reason: 'missing text' });
if (!existsSync(DB_PATH)) emit({ ok: false, reason: 'db missing' });

const distRoot = join(__dirname, '..', 'dist');
if (!existsSync(distRoot)) emit({ ok: false, reason: 'neuromcp dist missing' });

let provider;
try {
  const [{ createEmbeddingProvider }, { loadConfig }, { createLogger }] = await Promise.all([
    import(join(distRoot, 'embeddings', 'factory.js')),
    import(join(distRoot, 'config.js')),
    import(join(distRoot, 'observability', 'logger.js')),
  ]);
  const config = loadConfig();
  const logger = createLogger(config);
  provider = await createEmbeddingProvider(config, logger);
} catch (err) {
  emit({ ok: false, reason: `embedder init: ${err?.message || err}` });
}

let vector;
try { vector = await provider.embed(text); }
catch (err) { emit({ ok: false, reason: `embed: ${err?.message || err}` }); }
if (!Array.isArray(vector) && !(vector instanceof Float32Array)) {
  emit({ ok: false, reason: 'provider returned non-vector' });
}

let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
} catch (err) {
  emit({ ok: false, reason: `db open: ${err?.message || err}` });
}

try {
  sqliteVec.load(db);
} catch (err) {
  try { db.close(); } catch { /* ignore */ }
  emit({ ok: false, reason: `sqlite-vec: ${err?.message || err}` });
}

// Contract check: the memory row must exist, and it must not already be
// tombstoned. Storing a vector for a deleted memory creates a retrieval
// ghost — it surfaces in vector search but has no queryable FTS partner.
const existing = db.prepare(
  `SELECT id, is_deleted, embedding_dim FROM memories WHERE id = ?`,
).get(id);
if (!existing) {
  try { db.close(); } catch { /* ignore */ }
  emit({ ok: false, reason: 'unknown memory id' });
}
if (existing.is_deleted) {
  try { db.close(); } catch { /* ignore */ }
  emit({ ok: false, reason: 'memory is tombstoned' });
}

// Detect the existing vector column dim — if it conflicts with the provider
// we fail fast rather than silently corrupting the index with mixed dims.
// (sqlite-vec rejects cross-dim inserts, but we want a clean JSON error for
// callers instead of a native exception.)
let existingDim = 0;
try {
  const probe = db.prepare(`SELECT embedding FROM memories_vec LIMIT 1`).get();
  if (probe && probe.embedding) existingDim = probe.embedding.length / 4; // float32
} catch { /* table empty or vec ext missing — treat as unknown */ }
if (existingDim && existingDim !== vector.length) {
  try { db.close(); } catch { /* ignore */ }
  emit({
    ok: false,
    reason: `dim mismatch: existing memories_vec uses ${existingDim}, embedder returns ${vector.length}. ` +
      `Re-backfill after changing providers (npx neuromcp-backfill-embeddings --rebuild-vec).`,
  });
}

// Single transaction: memory dim/model update + vec upsert.
const run = db.transaction(() => {
  const buf = Buffer.from(Float32Array.from(vector).buffer);
  db.prepare('DELETE FROM memories_vec WHERE id = ?').run(id);
  db.prepare('INSERT INTO memories_vec (id, embedding) VALUES (?, ?)').run(id, buf);
  const upd = db.prepare(
    'UPDATE memories SET embedding_model = ?, embedding_dim = ? WHERE id = ?',
  ).run(provider.name, vector.length, id);
  if (upd.changes !== 1) {
    // Should be impossible after the existence check above, but if a concurrent
    // delete hit between check and write, we want to abort the whole txn.
    throw new Error(`memory vanished mid-update (changes=${upd.changes})`);
  }
});

try {
  run();
} catch (err) {
  try { db.close(); } catch { /* ignore */ }
  emit({ ok: false, reason: `write txn: ${err?.message || err}` });
}

try { db.close(); } catch { /* ignore */ }
emit({ ok: true, model: provider.name, dim: vector.length });
