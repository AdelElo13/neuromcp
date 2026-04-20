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
const MAX_CONTENT_CHARS = 1500;     // per-memory cap — trimmed at structural boundary
const TRIM_SEARCH_WINDOW = 0.4;     // look back up to 40% of cap for a clean break
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
  // Over-fetch 2x the char cap so smartTrim() has room to find a clean break
  // without another round-trip. JSON output → robust against odd content chars.
  const fetchChars = MAX_CONTENT_CHARS * 2;
  const sqlScript = `
.timeout ${SQLITE_TIMEOUT_MS}
.mode json
.param set :q '${match.replace(/'/g, "''")}'
SELECT
  substr(m.content, 1, ${fetchChars}) AS content,
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

/**
 * Trim long content at a structural boundary instead of a hard char cut.
 * Priority: complete bullet (`\n- `) > sentence end > newline > word boundary.
 * Never mid-word. Looks back up to TRIM_SEARCH_WINDOW into the text so we
 * always land within [cap * (1 - window), cap] chars.
 *
 * Rationale: wiki sections often encode the conclusion ("Beslissing: X")
 * in the last bullet. A hard char cut drops the tail = drops the point.
 * Research (Bennani & Moslonka 2026, Stanford 2025) converges on
 * structure-aware chunking boundaries beating fixed-size cuts.
 */
function smartTrim(text, cap) {
  if (text.length <= cap) return text;
  const window = text.slice(0, cap);
  const minBoundary = Math.floor(cap * (1 - TRIM_SEARCH_WINDOW));

  // 1. End of a bullet: look for the newline that terminates a `- ` item.
  //    Find the last `\n- ` in window, then the newline that ends that bullet.
  const lastBulletStart = window.lastIndexOf('\n- ');
  if (lastBulletStart >= minBoundary) {
    const bulletEnd = text.indexOf('\n', lastBulletStart + 3);
    if (bulletEnd !== -1 && bulletEnd <= cap * 1.15) {
      return text.slice(0, bulletEnd) + '\n…';
    }
    // Bullet runs past our stretch budget — drop from its start.
    return text.slice(0, lastBulletStart) + '\n…';
  }

  // 2. End of a sentence (period/!/? followed by space or newline).
  const sentenceMatch = window.match(/[.!?](\s)(?=[^\s.!?]|$)(?!.*[.!?](\s))/s);
  if (sentenceMatch && sentenceMatch.index >= minBoundary) {
    return window.slice(0, sentenceMatch.index + 1) + ' …';
  }

  // 3. Newline (for table rows, plain lines).
  const lastNl = window.lastIndexOf('\n');
  if (lastNl >= minBoundary) return window.slice(0, lastNl) + '\n…';

  // 4. Word boundary fallback — never mid-word.
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace >= minBoundary) return window.slice(0, lastSpace) + ' …';

  // 5. Give up gracefully with the full window.
  return window + '…';
}

function formatMemories(rows) {
  if (!rows.length) return '';
  const tags = rows
    .map(r => {
      const category = (r.category || 'memory').replace(/[<>"]/g, '');
      const date = (r.created_at || '').slice(0, 10);
      const raw = (r.content || '').trim();
      if (!raw) return null;
      const content = smartTrim(raw, MAX_CONTENT_CHARS);
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
