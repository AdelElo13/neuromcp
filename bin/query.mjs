#!/usr/bin/env node
/**
 * neuromcp-query — hybrid memory search CLI
 *
 * Takes a text query, embeds it via the configured provider (Ollama → OpenAI
 * → ONNX fallback), runs FTS5 BM25 + vector cosine search, fuses results via
 * Reciprocal Rank Fusion (RRF), and prints the top-K matches as JSON.
 *
 * Designed for use from the UserPromptSubmit hook where cold-start latency
 * matters but quality beats FTS-only for synonym queries.
 *
 * Usage (stdin JSON preferred for hook pipes):
 *   echo '{"text":"…","limit":3,"bm25_max":-1.0}' | neuromcp-query
 * or:
 *   neuromcp-query --text "…" --limit 3
 *
 * Output schema:
 *   { "results": [{id, content, category, date, source, bm25, cosine, rrf}] }
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

const args = process.argv.slice(2);
function argVal(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : fallback;
}

// Accept either stdin JSON (preferred for hooks) or CLI flags.
let input = {};
if (!process.stdin.isTTY) {
  try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { input = {}; }
}

function parseIntBounded(value, { min, max, name, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    fail({ reason: `invalid ${name}: expected integer in [${min}, ${max}], got ${JSON.stringify(value)}`, _exit: 2 });
  }
  return n;
}
function parseFloatBounded(value, { min, max, name, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    fail({ reason: `invalid ${name}: expected finite number in [${min}, ${max}], got ${JSON.stringify(value)}`, _exit: 2 });
  }
  return n;
}

const text = typeof (input.text ?? argVal('--text', '')) === 'string'
  ? (input.text ?? argVal('--text', ''))
  : '';
const LIMIT = parseIntBounded(input.limit ?? argVal('--limit', undefined),
  { min: 1, max: 50, name: 'limit', fallback: 3 });
const POOL = parseIntBounded(input.pool ?? argVal('--pool', undefined),
  { min: 1, max: 200, name: 'pool', fallback: 15 });
const BM25_MAX = parseFloatBounded(input.bm25_max ?? argVal('--bm25-max', undefined),
  { min: -1000, max: 0, name: 'bm25_max', fallback: -1.0 });
const RRF_K = 60;  // canonical RRF constant; tame top-rank dominance

function fail(obj) {
  const { _exit = 0, ...payload } = obj;
  try { process.stdout.write(JSON.stringify({ results: [], ...payload })); } catch { /* broken pipe */ }
  process.exit(_exit);
}

if (!text || text.length < 3) fail({ reason: 'empty text', _exit: 2 });
if (!existsSync(DB_PATH)) fail({ reason: 'db not found', _exit: 2 });

// ─── embedding: reuse neuromcp's provider factory ──────────────────────
// Imported lazily so the bin still prints a sensible error if dist/ is missing.
async function embed(query) {
  const distPath = join(__dirname, '..', 'dist', 'embeddings', 'factory.js');
  if (!existsSync(distPath)) return null;
  try {
    const [{ createEmbeddingProvider }, { loadConfig }, { createLogger }] = await Promise.all([
      import(distPath),
      import(join(__dirname, '..', 'dist', 'config.js')),
      import(join(__dirname, '..', 'dist', 'observability', 'logger.js')),
    ]);
    const config = loadConfig();
    const logger = createLogger(config);
    const provider = await createEmbeddingProvider(config, logger);
    const vec = await provider.embed(query);
    return { vector: vec, dims: provider.dimensions };
  } catch (err) {
    // Quiet fail — retrieval falls back to FTS-only. stderr for debug.
    process.stderr.write(`[query] embed skipped: ${err?.message || err}\n`);
    return null;
  }
}

// ─── DB setup ──────────────────────────────────────────────────────────
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('journal_mode = WAL');

// sqlite-vec is a loadable extension. Load it so `memories_vec MATCH ?` works.
let vecLoaded = false;
try {
  sqliteVec.load(db);
  vecLoaded = true;
} catch (err) {
  process.stderr.write(`[query] sqlite-vec load failed: ${err?.message || err}\n`);
}

// ─── FTS5 branch ───────────────────────────────────────────────────────
const STOPWORDS = new Set([
  'the','a','an','and','or','but','of','in','on','at','to','for','with','from',
  'this','that','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','i','you','he','she','it','we','they','me','him','her','us',
  'them','my','your','his','its','our','their','what','how','when','where','why',
  'who','can','could','would','should','will','not','no','yes','also','just',
  'de','het','een','en','of','als','dan','was','waren','zijn','hebben','heeft',
  'had','ik','jij','hij','wij','zij','mij','hem','haar','ons','hen','hun','mijn',
  'jouw','wat','hoe','wanneer','waar','wie','niet','geen','ja','ook','maar','dus',
  'toch','nog','even','heel','om','voor','met','op','aan','naar','te','er','wel',
  'daar','dit','deze','die','dat',
]);

function ftsKeywords(s) {
  const seen = new Set();
  const out = [];
  for (const raw of s.toLowerCase().split(/[^a-z0-9_\-]+/)) {
    const t = raw.trim();
    if (t.length < 3 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(`"${t}"`);
    if (out.length >= 8) break;
  }
  return out.join(' OR ');
}

function ftsBranch(query) {
  const match = ftsKeywords(query);
  if (!match) return [];
  try {
    const rows = db.prepare(`
      SELECT m.id AS id, m.content AS content, m.category AS category,
             m.created_at AS created_at, m.source AS source,
             bm25(memories_fts) AS bm25
      FROM memories_fts
      JOIN memories m ON memories_fts.rowid = m.rowid
      WHERE memories_fts MATCH ?
        AND m.is_deleted = 0
        AND m.superseded_by_id IS NULL
        AND bm25(memories_fts) < ?
      ORDER BY bm25(memories_fts)
      LIMIT ?
    `).all(match, BM25_MAX, POOL);
    return rows;
  } catch (err) {
    process.stderr.write(`[query] fts branch failed: ${err?.message || err}\n`);
    return [];
  }
}

// ─── Vector branch ─────────────────────────────────────────────────────
// Detect the dim of the existing memories_vec column. If the current query
// embedder returns a different dim, the vec0 query will throw. Better to
// detect and skip cleanly than to spam stderr on every call.
let detectedVecDim = null;
function detectVecDim() {
  if (!vecLoaded) return null;
  try {
    const row = db.prepare(`SELECT embedding FROM memories_vec LIMIT 1`).get();
    if (row && row.embedding) return row.embedding.length / 4;   // float32
  } catch { /* table missing or empty */ }
  return null;
}
detectedVecDim = detectVecDim();

function vecBranch(vector) {
  if (!vecLoaded || !vector) return [];
  if (detectedVecDim !== null && detectedVecDim !== vector.length) {
    process.stderr.write(
      `[query] skipping vec branch: stored dim=${detectedVecDim} but embedder returns ${vector.length} ` +
      `(run: neuromcp-backfill-embeddings --rebuild-vec)\n`,
    );
    return [];
  }
  try {
    const buf = Buffer.from(Float32Array.from(vector).buffer);
    const hits = db.prepare(`
      SELECT id, distance FROM memories_vec
      WHERE embedding MATCH ?
      ORDER BY distance LIMIT ?
    `).all(buf, POOL);
    if (!hits.length) return [];
    const placeholders = hits.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, content, category, created_at, source
      FROM memories
      WHERE id IN (${placeholders})
        AND is_deleted = 0
        AND superseded_by_id IS NULL
    `).all(...hits.map(h => h.id));
    // Preserve sqlite-vec's distance ranking by re-indexing.
    const order = new Map(hits.map((h, i) => [h.id, { dist: h.distance, rank: i }]));
    return rows
      .map(r => ({ ...r, distance: order.get(r.id)?.dist ?? 999, _rank: order.get(r.id)?.rank ?? 999 }))
      .sort((a, b) => a._rank - b._rank)
      .map(({ _rank, ...r }) => r);
  } catch (err) {
    process.stderr.write(`[query] vec branch failed: ${err?.message || err}\n`);
    return [];
  }
}

// ─── Reciprocal Rank Fusion ────────────────────────────────────────────
function rrfFuse(ftsRows, vecRows) {
  const scores = new Map();   // id -> {row, score}
  ftsRows.forEach((row, i) => {
    const s = scores.get(row.id) || { row, score: 0 };
    s.score += 1 / (RRF_K + i);
    s.row = { ...s.row, bm25: row.bm25 };
    scores.set(row.id, s);
  });
  vecRows.forEach((row, i) => {
    const s = scores.get(row.id) || { row, score: 0 };
    s.score += 1 / (RRF_K + i);
    // L2 → cosine for L2-normalised vectors (nomic/bge output): cos = 1 - d²/2
    const cosine = row.distance !== undefined ? 1 - (row.distance * row.distance) / 2 : undefined;
    s.row = { ...s.row, cosine };
    scores.set(row.id, s);
  });
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT)
    .map(({ row, score }) => ({
      id: row.id,
      content: row.content,
      category: row.category,
      date: (row.created_at || '').slice(0, 10),
      source: row.source,
      bm25: row.bm25,
      cosine: row.cosine,
      rrf: Number(score.toFixed(4)),
    }));
}

// ─── main ──────────────────────────────────────────────────────────────
const ftsRows = ftsBranch(text);
const embedding = await embed(text);
const vecRows = vecBranch(embedding?.vector);

const fused = rrfFuse(ftsRows, vecRows);
process.stdout.write(JSON.stringify({
  results: fused,
  meta: {
    fts_hits: ftsRows.length,
    vec_hits: vecRows.length,
    embedded: Boolean(embedding),
    dims: embedding?.dims,
  },
}));
db.close();
