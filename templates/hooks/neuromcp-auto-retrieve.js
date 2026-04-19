#!/usr/bin/env node
'use strict';

/**
 * neuromcp-auto-retrieve.js — UserPromptSubmit hook
 *
 * For each user prompt, extracts keywords, runs an FTS5 BM25 search against
 * the local neuromcp memories table, and injects the top-3 matches as
 * additionalContext. Safe-fails on any error.
 *
 * Zero runtime deps beyond Node's builtins + the `sqlite3` CLI (on PATH).
 *
 * Install: copied to ~/.claude/scripts/hooks/ by `neuromcp-init-wiki` and
 * registered under UserPromptSubmit in ~/.claude/settings.json.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = os.homedir();
const DB_PATH = process.env.NEUROMCP_DB || path.join(HOME, '.neuromcp', 'memory.db');
const SQLITE_BIN = process.env.NEUROMCP_SQLITE || 'sqlite3';

const MIN_PROMPT_LEN = 20;          // skip very short prompts ("thanks", "ok")
const MAX_KEYWORDS = 8;             // cap FTS query size
const MAX_RESULTS = 3;              // top-k memories to inject
const MAX_CONTENT_CHARS = 400;      // truncate each memory preview
const SQLITE_TIMEOUT_MS = 500;      // hard budget for the whole query

// English + Dutch stopwords — tiny on purpose, we want rare-terms to survive.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'from', 'this', 'that', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'i', 'you', 'he', 'she',
  'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his',
  'its', 'our', 'their', 'what', 'how', 'when', 'where', 'why', 'who', 'can',
  'could', 'would', 'should', 'will', 'not', 'no', 'yes', 'also', 'just',
  'only', 'then', 'than', 'so', 'as', 'if', 'up', 'out', 'about', 'over',
  'de', 'het', 'een', 'en', 'of', 'als', 'dan', 'is', 'was', 'waren', 'zijn',
  'hebben', 'heeft', 'had', 'doe', 'doet', 'deed', 'ik', 'jij', 'hij', 'we',
  'wij', 'zij', 'mij', 'hem', 'haar', 'ons', 'hen', 'hun', 'mijn', 'jouw',
  'wat', 'hoe', 'wanneer', 'waar', 'wie', 'niet', 'geen', 'ja', 'ook', 'maar',
  'dus', 'toch', 'nog', 'even', 'heel', 'om', 'voor', 'met', 'op', 'aan',
  'naar', 'te', 'er', 'wel', 'daar', 'dit', 'deze', 'die', 'dat',
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
  // Split on non-word, lowercase, dedupe, filter stopwords + short tokens.
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

function buildFtsMatch(keywords) {
  // FTS5 match string. Wrap each term in "" to treat as a phrase/prefix-safe,
  // join with OR. Filter anything that could break FTS parser.
  const safe = keywords
    .filter(k => /^[a-z0-9_\-]+$/.test(k))
    .map(k => `"${k}"`);
  if (!safe.length) return null;
  return safe.join(' OR ');
}

function runSqlite(match) {
  // Use SQLite's .param set so the MATCH value never touches the shell.
  // JSON output → easy to parse, robust against odd content chars.
  const sqlScript = `
.timeout ${SQLITE_TIMEOUT_MS}
.mode json
.param set :q '${match.replace(/'/g, "''")}'
SELECT
  substr(m.content, 1, ${MAX_CONTENT_CHARS}) AS content,
  m.category AS category,
  m.created_at AS created_at,
  m.source AS source
FROM memories_fts
JOIN memories m ON memories_fts.rowid = m.rowid
WHERE memories_fts MATCH :q
  AND m.is_deleted = 0
  AND m.superseded_by_id IS NULL
ORDER BY bm25(memories_fts)
LIMIT ${MAX_RESULTS};
`;
  const r = spawnSync(SQLITE_BIN, ['-readonly', DB_PATH], {
    input: sqlScript,
    encoding: 'utf8',
    timeout: SQLITE_TIMEOUT_MS * 2, // process-level wall clock
  });
  if (r.status !== 0 || !r.stdout) return [];
  try {
    const rows = JSON.parse(r.stdout.trim() || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

function formatMemories(rows) {
  if (!rows.length) return '';
  const tags = rows
    .map(r => {
      const category = (r.category || 'memory').replace(/[<>"]/g, '');
      const date = (r.created_at || '').slice(0, 10);
      const content = (r.content || '').trim();
      if (!content) return null;
      return `<memory category="${category}" date="${date}">\n${content}\n</memory>`;
    })
    .filter(Boolean);
  if (!tags.length) return '';
  return `<neuromcp-recall>\n${tags.join('\n')}\n</neuromcp-recall>`;
}

// ─── main ───────────────────────────────────────────────────────────────
(function main() {
  let payload;
  try { payload = JSON.parse(readStdin() || '{}'); } catch { payload = {}; }

  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';

  // Skip noise: short prompts, slash commands, tool-system messages.
  if (prompt.length < MIN_PROMPT_LEN) { process.stdout.write(emptyOutput()); return; }
  if (/^\s*\//.test(prompt)) { process.stdout.write(emptyOutput()); return; }
  if (/^<(command-|local-command|system-)/.test(prompt)) {
    process.stdout.write(emptyOutput()); return;
  }
  if (!fs.existsSync(DB_PATH)) { process.stdout.write(emptyOutput()); return; }

  const keywords = extractKeywords(prompt);
  const match = buildFtsMatch(keywords);
  if (!match) { process.stdout.write(emptyOutput()); return; }

  const rows = runSqlite(match);
  const block = formatMemories(rows);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: block,
    },
  }));
})();
