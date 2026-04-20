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
    const [{ createEmbeddingProvider }, { loadConfig }, { createLogger }] = await Promise.all([
      import(join(distRoot, 'embeddings', 'factory.js')),
      import(join(distRoot, 'config.js')),
      import(join(distRoot, 'observability', 'logger.js')),
    ]);
    const config = loadConfig();
    const logger = createLogger(config);
    return await createEmbeddingProvider(config, logger);
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
function chunkKey(wikiPath, heading) {
  return `wiki::${wikiPath}::${heading}`;
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
const existingByKey = new Map();  // chunkKey → { id, rowid, content_hash }
for (const row of db.prepare(
  `SELECT id, rowid, content_hash, metadata FROM memories
   WHERE source = 'wiki' AND is_deleted = 0`,
).all()) {
  try {
    const meta = JSON.parse(row.metadata || '{}');
    const key = chunkKey(meta.wiki_path, meta.heading);
    existingByKey.set(key, { id: row.id, rowid: row.rowid, hash: row.content_hash });
  } catch { /* ignore malformed rows */ }
}

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
  for (const r of rows) {
    try {
      const vec = await embedder.embed(r.content);
      out.push({ ...r, vector: vec, dim: vec.length, model: embedder.name });
    } catch (err) {
      warn(`embed failed for ${r.project || 'home'}: ${err?.message || err}`);
      out.push({ ...r, vector: null, dim: 0, model: '' });
    }
  }
  return out;
}

function pruneRowInTxn(id, rowid) {
  if (vecEnabled) deleteVec.run(id);
  deleteFtsByRowid.run(rowid);
  deleteMemById.run(id);
}

const txn = db.transaction(({ rows, stale }) => {
  let added = 0, skipped = 0, removed = 0, replaced = 0;
  for (const prev of stale) {
    pruneRowInTxn(prev.id, prev.rowid);
    removed++;
  }
  for (const r of rows) {
    const prev = existingByKey.get(r.key);
    if (prev && prev.hash === r.hash) { skipped++; continue; }
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
  return { added, skipped, removed, replaced };
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
  for (const { heading, body: chunkBody } of chunks) {
    const content = makeContent(pageTitle, heading, chunkBody);
    const key = chunkKey(relPath, heading);
    currentKeys.add(key);
    toInsert.push({
      id: generateId(),
      key,
      hash: contentHash(content),
      content,
      project: projectId,
      metadata: JSON.stringify({ wiki_path: relPath, heading, page_title: pageTitle }),
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
  const fresh = toInsert.filter(r => {
    const prev = existingByKey.get(r.key);
    return !prev || prev.hash !== r.hash;
  });
  info(`[DRY RUN] ${fresh.length} to insert/replace, ${stale.length} to prune, ${toInsert.length - fresh.length} unchanged`);
  process.exit(0);
}

// Only embed rows that will actually be inserted or changed — dedup by key+hash.
const fresh = toInsert.filter(r => {
  const prev = existingByKey.get(r.key);
  return !prev || prev.hash !== r.hash;
});
const withVectors = await embedAll(fresh);
const unchanged = toInsert.filter(r => {
  const prev = existingByKey.get(r.key);
  return prev && prev.hash === r.hash;
});
const { added, skipped, removed, replaced } = txn({
  rows: [...withVectors, ...unchanged],
  stale,
});
const vectorised = withVectors.filter(r => r.vector).length;
ok(
  `inserted ${added} new chunks (${replaced} replaced, ${vectorised} with embeddings), ` +
  `pruned ${removed} stale, skipped ${skipped} unchanged`,
);
db.close();
