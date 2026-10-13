#!/usr/bin/env node
/**
 * neuromcp index-wiki — index wiki markdown pages into the memories table
 *
 * Walks ~/.neuromcp/wiki/**\/*.md, splits each page into ## sections,
 * and inserts every section as a memory (with FTS5 row) so the
 * auto-retrieve hook can surface wiki content during prompts.
 *
 * FTS-only for MVP: no vector embeddings are computed here. Semantic
 * search over wiki chunks will be added in a later pass.
 *
 * Idempotent: content_hash dedup means re-running after small edits
 * only writes what changed.
 *
 * Usage:
 *   npx neuromcp-index-wiki              # index all, skip unchanged
 *   npx neuromcp-index-wiki --rebuild    # wipe all wiki memories first
 *   npx neuromcp-index-wiki --dry-run    # show what would be indexed
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOME = homedir();
const DB_PATH = process.env.NEUROMCP_DB || join(HOME, '.neuromcp', 'memory.db');
const WIKI_DIR = process.env.NEUROMCP_WIKI || join(HOME, '.neuromcp', 'wiki');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const REBUILD = args.includes('--rebuild');
const NO_EMBED = args.includes('--no-embed') || process.env.NEUROMCP_NO_EMBED === '1';

const MIN_CHUNK_CHARS = 40;     // skip trivial chunks
const MAX_CHUNK_CHARS = 4000;   // hard cap; FTS doesn't care but memories.content gets long

function ok(msg) { console.log(`  ✓ ${msg}`); }
function info(msg) { console.log(`  · ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'raw-sources' || name === 'node_modules') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile() && name.endsWith('.md')) out.push(full);
  }
  return out;
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return { meta: {}, body: text };
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return { meta: {}, body: text };
  const fmBlock = text.slice(4, end);
  const body = text.slice(end + 5);
  const meta = {};
  for (const line of fmBlock.split('\n')) {
    const m = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body };
}

function chunkBySections(body, pageTitle) {
  // Split on ^## headers; keep the header with its section. If no ##, single chunk.
  const parts = body.split(/(?=^## )/m).map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return [];
  if (parts.length === 1 && !parts[0].startsWith('## ')) {
    // No H2 sections — whole page as one chunk.
    return [{ heading: pageTitle, body: parts[0] }];
  }
  const chunks = [];
  for (const part of parts) {
    const firstNl = part.indexOf('\n');
    const heading = firstNl === -1 ? part.replace(/^##\s*/, '') : part.slice(0, firstNl).replace(/^##\s*/, '');
    const body = firstNl === -1 ? '' : part.slice(firstNl + 1).trim();
    if (body.length < MIN_CHUNK_CHARS) continue;
    chunks.push({ heading: heading.trim(), body });
  }
  return chunks;
}

function makeContent(pageTitle, heading, body) {
  const capped = body.length > MAX_CHUNK_CHARS ? body.slice(0, MAX_CHUNK_CHARS) + '\n…' : body;
  return `[wiki:${pageTitle}#${heading}]\n${capped}`;
}

function contentHash(s) {
  return createHash('sha256').update(s).digest('hex');
}

function generateId() {
  return createHash('sha256').update(Date.now() + '-' + Math.random()).digest('hex').slice(0, 32);
}

// ─── main ───────────────────────────────────────────────────────────────
if (!existsSync(DB_PATH)) {
  console.error(`  ✗ database not found: ${DB_PATH}`);
  console.error('    Run `npx neuromcp-init-wiki` first (creates DB) and start neuromcp once.');
  process.exit(1);
}
if (!existsSync(WIKI_DIR)) {
  console.error(`  ✗ wiki not found: ${WIKI_DIR}`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Optionally load the embedding provider. If unavailable, we still index
// (FTS-only), but we warn so the user knows vector retrieval won't cover
// what this run writes.
async function loadEmbedder() {
  if (NO_EMBED) return null;
  const distRoot = join(__dirname, '..', 'dist');
  if (!existsSync(distRoot)) {
    warn('dist/ not found — FTS-only indexing (vector search will miss new chunks)');
    return null;
  }
  try {
    const [{ createIndexAwareProvider }, { loadConfig }, { createLogger }] = await Promise.all([
      import(join(distRoot, 'embeddings', 'runtime.js')),
      import(join(distRoot, 'config.js')),
      import(join(distRoot, 'observability', 'logger.js')),
    ]);
    const config = loadConfig();
    const logger = createLogger(config);
    // Index-aware: wiki chunks live in the same memories_vec index, so they
    // must use the model that index was built with (e.g. bge-m3).
    return await createIndexAwareProvider(db, config, logger);
  } catch (err) {
    warn(`embedder init failed: ${err?.message || err}`);
    return null;
  }
}

// Always try to load sqlite-vec: even without an embedder we need vec
// access so --rebuild can clean orphan vector rows left by previous runs.
let vecEnabled = false;
try { sqliteVec.load(db); vecEnabled = true; }
catch (err) { warn(`sqlite-vec load failed — vec cleanup + indexing disabled: ${err.message}`); }

const embedder = await loadEmbedder();
if (embedder) {
  ok(`embedder ready: ${embedder.name} (dim=${embedder.dimensions})${vecEnabled ? '' : ' (vec disabled)'}`);
}

// Stable chunk identity = `<wiki_path>#<heading>` so re-indexing after a
// section edit or rename can diff current-on-disk against what is stored
// and remove anything that no longer exists. Without this, stale rows
// accumulate forever and retrieval serves outdated sections.
function chunkKey(wikiPath, heading, occurrence = 1) {
  const base = `wiki::${wikiPath}::${heading}`;
  return occurrence > 1 ? `${base}::#${occurrence}` : base;
}

if (REBUILD && !DRY_RUN) {
  const before = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE source = 'wiki'`).get().n;
  // Vec rows live in an independent vec0 virtual table — must clean them
  // FIRST, before the FK-less memories rows disappear and we lose the ids.
  if (vecEnabled) {
    db.prepare(`DELETE FROM memories_vec WHERE id IN (SELECT id FROM memories WHERE source = 'wiki')`).run();
  }
  db.prepare(`DELETE FROM memories_fts WHERE rowid IN (SELECT rowid FROM memories WHERE source = 'wiki')`).run();
  db.prepare(`DELETE FROM memories WHERE source = 'wiki'`).run();
  ok(`rebuild: wiped ${before} previous wiki memories + vectors`);
}

const files = walk(WIKI_DIR).sort();
info(`found ${files.length} wiki files`);

// We key on chunk identity (wiki_path + heading). Content_hash is a
// separate dedup — same identity + same content = no-op re-insert.
const existingByKey = new Map();  // chunkKey → { id, rowid, hash, vectorless }
for (const row of db.prepare(
  `SELECT id, rowid, content_hash, metadata, embedding_model FROM memories
   WHERE source = 'wiki' AND is_deleted = 0`,
).all()) {
  try {
    const meta = JSON.parse(row.metadata || '{}');
    const key = chunkKey(meta.wiki_path, meta.heading, meta.occurrence ?? 1);
    const vectorless = !row.embedding_model || row.embedding_model === 'none';
    existingByKey.set(key, { id: row.id, rowid: row.rowid, hash: row.content_hash, vectorless });
  } catch { /* ignore malformed rows */ }
}

/**
 * A chunk needs work when it is new, its content changed, or it was stored
 * WITHOUT a vector earlier (e.g. a transient Ollama failure) and an embedder
 * is available now. Without the last clause such a chunk was skipped as
 * "unchanged" forever and stayed invisible to vector search.
 */
function needsWork(r) {
  const prev = existingByKey.get(r.key);
  if (!prev || prev.hash !== r.hash) return true;
  return Boolean(embedder && vecEnabled && prev.vectorless);
}

/** Unchanged content, only the vector is missing → repair in place. */
function onlyVectorMissing(r) {
  const prev = existingByKey.get(r.key);
  return Boolean(prev && prev.hash === r.hash && prev.vectorless);
}

const EMBED_BREAKER_THRESHOLD = 3;

const insertMem = db.prepare(`
  INSERT INTO memories (
    id, content_hash, content, namespace, category, source, source_trust,
    project_id, tags, importance, metadata, embedding_model, embedding_dim
  ) VALUES (?, ?, ?, 'default', 'wiki', 'wiki', 'high', ?, '[]', 0.6, ?, ?, ?)
`);
const insertFts = db.prepare(`
  INSERT INTO memories_fts (rowid, content, summary, tags, category)
  VALUES (?, ?, NULL, ?, ?)
`);
const deleteMemById = db.prepare(`DELETE FROM memories WHERE id = ?`);
const deleteFtsByRowid = db.prepare(`DELETE FROM memories_fts WHERE rowid = ?`);
const deleteVec = vecEnabled
  ? db.prepare(`DELETE FROM memories_vec WHERE id = ?`)
  : null;
const insertVec = vecEnabled
  ? db.prepare(`INSERT INTO memories_vec (id, embedding) VALUES (?, ?)`)
  : null;
const getRowid = db.prepare(`SELECT rowid FROM memories WHERE id = ?`);

// Embedding happens BEFORE the transaction (provider calls are async + I/O).
// We then run the writes in a single sync transaction for durability.
async function embedAll(rows) {
  if (!embedder) return rows.map(r => ({ ...r, vector: null, dim: 0, model: '' }));
  const out = [];
  let consecutiveFailures = 0;
  let breakerTripped = false;
  for (const r of rows) {
    // Circuit breaker: after a few chunks in a row fail, the embedder is
    // down — stop paying two timeouts per remaining chunk. They are stored
    // without a vector and picked up again by the next run (needsWork).
    if (breakerTripped) {
      out.push({ ...r, vector: null, dim: 0, model: '' });
      continue;
    }
    // One retry: the first calls after a model switch or Ollama restart can
    // time out while the model loads.
    let vec = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 2 && vec === null; attempt++) {
      try {
        vec = await embedder.embed(r.content);
      } catch (err) {
        lastErr = err;
        if (attempt === 1) await new Promise((res) => setTimeout(res, 2000));
      }
    }
    if (vec !== null) {
      consecutiveFailures = 0;
      out.push({ ...r, vector: vec, dim: vec.length, model: embedder.name });
    } else {
      consecutiveFailures++;
      warn(`embed failed for ${r.project || 'home'} (will retry next run): ${lastErr?.message || lastErr}`);
      out.push({ ...r, vector: null, dim: 0, model: '' });
      if (consecutiveFailures >= EMBED_BREAKER_THRESHOLD) {
        breakerTripped = true;
        warn(`${consecutiveFailures} embeds failed in a row — embedder looks down; remaining chunks this run are stored without vectors`);
      }
    }
  }
  return out;
}

function pruneRowInTxn(id, rowid) {
  if (vecEnabled) deleteVec.run(id);
  deleteFtsByRowid.run(rowid);
  deleteMemById.run(id);
}

const setEmbeddingMeta = db.prepare(
  `UPDATE memories SET embedding_model = ?, embedding_dim = ? WHERE id = ?`,
);

const txn = db.transaction(({ rows, stale }) => {
  let added = 0, skipped = 0, removed = 0, replaced = 0, revectorised = 0;
  for (const prev of stale) {
    pruneRowInTxn(prev.id, prev.rowid);
    removed++;
  }
  for (const r of rows) {
    const prev = existingByKey.get(r.key);
    if (r.unchanged) { skipped++; continue; }
    // Content unchanged, only the vector was missing: attach it to the
    // EXISTING row so its id, access history and graph edges survive.
    if (onlyVectorMissing(r)) {
      if (vecEnabled && r.vector) {
        const buf = Buffer.from(Float32Array.from(r.vector).buffer);
        deleteVec.run(prev.id);
        insertVec.run(prev.id, buf);
        setEmbeddingMeta.run(r.model, r.dim, prev.id);
        existingByKey.set(r.key, { ...prev, vectorless: false });
        revectorised++;
      } else {
        skipped++;
      }
      continue;
    }
    if (prev) {
      pruneRowInTxn(prev.id, prev.rowid);
      replaced++;
    }
    insertMem.run(r.id, r.hash, r.content, r.project, r.metadata, r.model || '', r.dim || 0);
    const { rowid } = getRowid.get(r.id);
    insertFts.run(rowid, r.content, '[]', 'wiki');
    if (vecEnabled && r.vector) {
      const buf = Buffer.from(Float32Array.from(r.vector).buffer);
      deleteVec.run(r.id);
      insertVec.run(r.id, buf);
    }
    existingByKey.set(r.key, { id: r.id, rowid, hash: r.hash });
    added++;
  }
  return { added, skipped, removed, replaced, revectorised };
});

let totalChunks = 0;
const toInsert = [];
const currentKeys = new Set();
for (const file of files) {
  const relPath = file.slice(WIKI_DIR.length + 1);
  const text = readFileSync(file, 'utf8');
  const { meta, body } = parseFrontmatter(text);
  const pageTitle = meta.title || relPath.replace(/\.md$/, '').replace(/\//g, ':');
  const projectId = relPath.startsWith('projects/') ? relPath.replace(/^projects\//, '').replace(/\.md$/, '') : null;
  const chunks = chunkBySections(body, pageTitle);
  totalChunks += chunks.length;
  // Consolidation appends dated sections, so one page can repeat a heading.
  // The n-th repeat gets its own key; the first keeps the plain key so
  // existing unique chunks keep their identity.
  const seenHeadings = new Map();
  for (const { heading, body: chunkBody } of chunks) {
    const occurrence = (seenHeadings.get(heading) ?? 0) + 1;
    seenHeadings.set(heading, occurrence);
    const content = makeContent(pageTitle, heading, chunkBody);
    const key = chunkKey(relPath, heading, occurrence);
    currentKeys.add(key);
    const meta = { wiki_path: relPath, heading, page_title: pageTitle };
    if (occurrence > 1) meta.occurrence = occurrence;
    toInsert.push({
      id: generateId(),
      key,
      hash: contentHash(content),
      content,
      project: projectId,
      metadata: JSON.stringify(meta),
    });
  }
}

// Rows in the DB whose key no longer appears on disk → prune.
const stale = [];
for (const [key, prev] of existingByKey) {
  if (!currentKeys.has(key)) stale.push(prev);
}

info(`${totalChunks} chunks across ${files.length} files`);

if (DRY_RUN) {
  const fresh = toInsert.filter(needsWork);
  info(`[DRY RUN] ${fresh.length} to insert/replace, ${stale.length} to prune, ${toInsert.length - fresh.length} unchanged`);
  process.exit(0);
}

// Only embed rows that will actually be inserted, changed or are missing a vector.
const fresh = toInsert.filter(needsWork);
const withVectors = await embedAll(fresh);
const unchanged = toInsert.filter(r => !needsWork(r)).map(r => ({ ...r, unchanged: true }));
const { added, skipped, removed, replaced, revectorised } = txn({
  rows: [...withVectors, ...unchanged],
  stale,
});
const vectorised = withVectors.filter(r => r.vector).length;
ok(
  `inserted ${added} new chunks (${replaced} replaced, ${vectorised} with embeddings), ` +
  `pruned ${removed} stale, repaired ${revectorised} missing vectors in place, skipped ${skipped} unchanged`,
);
db.close();
