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
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const HOME = homedir();
const DB_PATH = process.env.NEUROMCP_DB || join(HOME, '.neuromcp', 'memory.db');
const WIKI_DIR = process.env.NEUROMCP_WIKI || join(HOME, '.neuromcp', 'wiki');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const REBUILD = args.includes('--rebuild');

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

if (REBUILD && !DRY_RUN) {
  // Delete (hard) all wiki-source rows to start clean.
  const before = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE source = 'wiki'`).get().n;
  db.prepare(`DELETE FROM memories_fts WHERE rowid IN (SELECT rowid FROM memories WHERE source = 'wiki')`).run();
  db.prepare(`DELETE FROM memories WHERE source = 'wiki'`).run();
  ok(`rebuild: wiped ${before} previous wiki memories`);
}

const files = walk(WIKI_DIR).sort();
info(`found ${files.length} wiki files`);

const existingHashes = new Set(
  db.prepare(`SELECT content_hash FROM memories WHERE source = 'wiki' AND is_deleted = 0`)
    .all()
    .map(r => r.content_hash),
);

const insertMem = db.prepare(`
  INSERT INTO memories (
    id, content_hash, content, namespace, category, source, source_trust,
    project_id, tags, importance, metadata
  ) VALUES (?, ?, ?, 'default', 'wiki', 'wiki', 'high', ?, '[]', 0.6, ?)
`);
const insertFts = db.prepare(`
  INSERT INTO memories_fts (rowid, content, summary, tags, category)
  VALUES (?, ?, NULL, ?, ?)
`);
const getRowid = db.prepare(`SELECT rowid FROM memories WHERE id = ?`);

const txn = db.transaction((rows) => {
  let added = 0, skipped = 0;
  for (const r of rows) {
    if (existingHashes.has(r.hash)) { skipped++; continue; }
    insertMem.run(r.id, r.hash, r.content, r.project, r.metadata);
    const { rowid } = getRowid.get(r.id);
    insertFts.run(rowid, r.content, '[]', 'wiki');
    existingHashes.add(r.hash);
    added++;
  }
  return { added, skipped };
});

let totalChunks = 0;
const toInsert = [];
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
    toInsert.push({
      id: generateId(),
      hash: contentHash(content),
      content,
      project: projectId,
      metadata: JSON.stringify({ wiki_path: relPath, heading, page_title: pageTitle }),
    });
  }
}

info(`${totalChunks} chunks across ${files.length} files`);

if (DRY_RUN) {
  const newCount = toInsert.filter(r => !existingHashes.has(r.hash)).length;
  info(`[DRY RUN] would insert ${newCount}, skip ${toInsert.length - newCount} (dedup)`);
  process.exit(0);
}

const { added, skipped } = txn(toInsert);
ok(`inserted ${added} new chunks, skipped ${skipped} unchanged`);
db.close();
