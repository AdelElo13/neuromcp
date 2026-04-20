#!/usr/bin/env node
'use strict';

/**
 * neuromcp-auto-retrieve.js — UserPromptSubmit hook
 *
 * For each user prompt, calls the `neuromcp-query` bin (hybrid FTS5 + vector
 * search via Reciprocal Rank Fusion) and injects the top-3 matches as
 * additionalContext. Falls back to an inline FTS-only query if the bin is
 * not installed — the hook must keep working for users who have the
 * templates copied but not the full neuromcp package on PATH.
 *
 * Install: copied to ~/.claude/scripts/hooks/ by `neuromcp-init-wiki` and
 * registered under UserPromptSubmit in ~/.claude/settings.json.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const HOME = os.homedir();
const DB_PATH = process.env.NEUROMCP_DB || path.join(HOME, '.neuromcp', 'memory.db');
const SQLITE_BIN = process.env.NEUROMCP_SQLITE || 'sqlite3';

const MIN_PROMPT_LEN = 20;
const MIN_KEYWORDS = 2;
const MAX_KEYWORDS = 8;
const MAX_RESULTS = 3;
const MAX_CONTENT_CHARS = 1500;
const TRIM_SEARCH_WINDOW = 0.4;
const SQLITE_TIMEOUT_MS = 500;
const QUERY_BIN_TIMEOUT_MS = 1500;  // hybrid path: embed + FTS + vec + fuse
const BM25_THRESHOLD = parseFloat(process.env.NEUROMCP_BM25_THRESHOLD || '-1.0');

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'from', 'this', 'that', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'i', 'you', 'he', 'she',
  'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his',
  'its', 'our', 'their', 'what', 'how', 'when', 'where', 'why', 'who', 'can',
  'could', 'would', 'should', 'will', 'not', 'no', 'yes', 'also', 'just',
  'only', 'then', 'than', 'so', 'as', 'if', 'up', 'out', 'about', 'over',
  'some', 'any', 'all', 'one', 'two', 'here', 'there', 'really', 'actually',
  'kind', 'sort', 'way', 'thing', 'stuff', 'got', 'get', 'make', 'made',
  'de', 'het', 'een', 'en', 'of', 'als', 'dan', 'was', 'waren', 'zijn',
  'hebben', 'heeft', 'had', 'doe', 'doet', 'deed', 'ik', 'jij', 'hij',
  'wij', 'zij', 'mij', 'hem', 'haar', 'ons', 'hen', 'hun', 'mijn', 'jouw',
  'wat', 'hoe', 'wanneer', 'waar', 'wie', 'niet', 'geen', 'ja', 'ook', 'maar',
  'dus', 'toch', 'nog', 'even', 'heel', 'om', 'voor', 'met', 'op', 'aan',
  'naar', 'te', 'er', 'wel', 'daar', 'dit', 'deze', 'die', 'dat',
  'oke', 'okee', 'zelf', 'tussendoor', 'korte', 'vraag', 'eens',
  'goed', 'zien', 'zal', 'zou', 'mag', 'kan', 'moet', 'gaat', 'gaan', 'doen',
  'nou', 'werk', 'werken', 'maken', 'gemaakt', 'iets',
  'sluit', 'resume', 'gesprek', 'checken', 'bericht', 'berichten',
]);

function emptyOutput() {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: '',
    },
  });
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function extractKeywords(prompt) {
  const seen = new Set();
  const out = [];
  for (const raw of prompt.toLowerCase().split(/[^a-z0-9_\-]+/)) {
    const t = raw.trim();
    if (t.length < 3 || t.length > 40) continue;
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

// ─── Resolve the neuromcp-query bin, if installed ───────────────────────
function resolveQueryBin() {
  // 1. Explicit override
  if (process.env.NEUROMCP_QUERY_BIN && fs.existsSync(process.env.NEUROMCP_QUERY_BIN)) {
    return process.env.NEUROMCP_QUERY_BIN;
  }
  // 2. Package install — global bin on PATH
  try {
    const p = execFileSync('/usr/bin/env', ['which', 'neuromcp-query'], { encoding: 'utf8' }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* fall through */ }
  // 3. Common install locations
  const candidates = [
    path.join(HOME, '.neuromcp', 'scripts', 'query.mjs'),
    '/usr/local/lib/node_modules/neuromcp/bin/query.mjs',
    '/opt/homebrew/lib/node_modules/neuromcp/bin/query.mjs',
    path.join(HOME, 'projects', 'neuromcp', 'bin', 'query.mjs'),  // dev
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

// ─── Hybrid path: call query bin ───────────────────────────────────────
function hybridQuery(text) {
  const bin = resolveQueryBin();
  if (!bin) return null;
  try {
    const r = spawnSync('node', [bin], {
      input: JSON.stringify({ text, limit: MAX_RESULTS, bm25_max: BM25_THRESHOLD }),
      encoding: 'utf8',
      timeout: QUERY_BIN_TIMEOUT_MS,
    });
    if (r.status !== 0 || !r.stdout) return null;
    const parsed = JSON.parse(r.stdout);
    return Array.isArray(parsed.results) ? parsed.results : null;
  } catch {
    return null;
  }
}

// ─── FTS-only fallback for users without the full package ──────────────
function ftsBuild(keywords) {
  const safe = keywords.filter(k => /^[a-z0-9_\-]+$/.test(k)).map(k => `"${k}"`);
  return safe.length ? safe.join(' OR ') : null;
}

function ftsFallback(keywords) {
  const match = ftsBuild(keywords);
  if (!match) return null;
  const fetchChars = MAX_CONTENT_CHARS * 2;
  const sqlScript = `
.timeout ${SQLITE_TIMEOUT_MS}
.mode json
.param set :q '${match.replace(/'/g, "''")}'
SELECT
  substr(m.content, 1, ${fetchChars}) AS content,
  m.category AS category,
  m.created_at AS created_at,
  m.source AS source,
  bm25(memories_fts) AS bm25
FROM memories_fts
JOIN memories m ON memories_fts.rowid = m.rowid
WHERE memories_fts MATCH :q
  AND m.is_deleted = 0
  AND m.superseded_by_id IS NULL
  AND bm25(memories_fts) < ${BM25_THRESHOLD}
ORDER BY bm25(memories_fts)
LIMIT ${MAX_RESULTS};
`;
  try {
    const r = spawnSync(SQLITE_BIN, ['-readonly', DB_PATH], {
      input: sqlScript,
      encoding: 'utf8',
      timeout: SQLITE_TIMEOUT_MS * 2,
    });
    if (r.status !== 0 || !r.stdout) return [];
    const rows = JSON.parse(r.stdout.trim() || '[]');
    return Array.isArray(rows)
      ? rows.map(r => ({ ...r, date: (r.created_at || '').slice(0, 10) }))
      : [];
  } catch { return []; }
}

// ─── smart truncation (unchanged from previous) ────────────────────────
function smartTrim(text, cap) {
  if (text.length <= cap) return text;
  const window = text.slice(0, cap);
  const minBoundary = Math.floor(cap * (1 - TRIM_SEARCH_WINDOW));

  const lastBulletStart = window.lastIndexOf('\n- ');
  if (lastBulletStart >= minBoundary) {
    const bulletEnd = text.indexOf('\n', lastBulletStart + 3);
    if (bulletEnd !== -1 && bulletEnd <= cap * 1.15) {
      return text.slice(0, bulletEnd) + '\n…';
    }
    return text.slice(0, lastBulletStart) + '\n…';
  }
  const sentenceMatch = window.match(/[.!?](\s)(?=[^\s.!?]|$)(?!.*[.!?](\s))/s);
  if (sentenceMatch && sentenceMatch.index >= minBoundary) {
    return window.slice(0, sentenceMatch.index + 1) + ' …';
  }
  const lastNl = window.lastIndexOf('\n');
  if (lastNl >= minBoundary) return window.slice(0, lastNl) + '\n…';
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace >= minBoundary) return window.slice(0, lastSpace) + ' …';
  return window + '…';
}

function formatMemories(rows) {
  if (!rows || !rows.length) return '';
  const tags = rows.map(r => {
    const category = (r.category || 'memory').replace(/[<>"]/g, '');
    const date = r.date || (r.created_at || '').slice(0, 10);
    const raw = (r.content || '').trim();
    if (!raw) return null;
    const content = smartTrim(raw, MAX_CONTENT_CHARS);
    return `<memory category="${category}" date="${date}">\n${content}\n</memory>`;
  }).filter(Boolean);
  return tags.length ? `<neuromcp-recall>\n${tags.join('\n')}\n</neuromcp-recall>` : '';
}

// ─── main ───────────────────────────────────────────────────────────────
(function main() {
  let payload;
  try { payload = JSON.parse(readStdin() || '{}'); } catch { payload = {}; }
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';

  if (prompt.length < MIN_PROMPT_LEN) { process.stdout.write(emptyOutput()); return; }
  if (/^\s*\//.test(prompt)) { process.stdout.write(emptyOutput()); return; }
  if (/^<(command-|local-command|system-)/.test(prompt)) {
    process.stdout.write(emptyOutput()); return;
  }
  if (!fs.existsSync(DB_PATH)) { process.stdout.write(emptyOutput()); return; }

  const keywords = extractKeywords(prompt);
  if (keywords.length < MIN_KEYWORDS) { process.stdout.write(emptyOutput()); return; }

  // Prefer hybrid (FTS + vector via RRF). Fall back to FTS-only if bin missing.
  const rows = hybridQuery(prompt) ?? ftsFallback(keywords);
  const block = formatMemories(rows);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: block,
    },
  }));
})();
