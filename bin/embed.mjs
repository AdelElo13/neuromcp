#!/usr/bin/env node
/**
 * neuromcp-embed — embed text via the configured provider and write the
 * resulting vector directly into memories_vec (by memory id).
 *
 * Designed as a thin RPC endpoint for non-Node tools (Python consolidator)
 * that need to store a memory and back it with an embedding without porting
 * the whole embedding stack.
 *
 * Reads stdin JSON:
 *   { "id": "<memory id>", "text": "<content to embed>" }
 * Writes stdout JSON on success:
 *   { "ok": true, "model": "<name>", "dim": <number> }
 * Or on failure:
 *   { "ok": false, "reason": "<short>" }
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
  process.stdout.write(JSON.stringify(obj));
  process.exit(obj.ok ? 0 : 1);
}

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { emit({ ok: false, reason: 'bad stdin json' }); }
const id = input.id;
const text = input.text;
if (!id || !text) emit({ ok: false, reason: 'missing id/text' });
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

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
try { sqliteVec.load(db); } catch (err) { emit({ ok: false, reason: `sqlite-vec: ${err.message}` }); }

try {
  const buf = Buffer.from(Float32Array.from(vector).buffer);
  db.prepare('DELETE FROM memories_vec WHERE id = ?').run(id);
  db.prepare('INSERT INTO memories_vec (id, embedding) VALUES (?, ?)').run(id, buf);
  db.prepare('UPDATE memories SET embedding_model = ?, embedding_dim = ? WHERE id = ?')
    .run(provider.name, vector.length, id);
} finally {
  db.close();
}

emit({ ok: true, model: provider.name, dim: vector.length });
