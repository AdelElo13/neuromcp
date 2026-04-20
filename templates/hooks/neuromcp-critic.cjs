#!/usr/bin/env node
'use strict';

/**
 * neuromcp-critic.cjs — Stop hook that closes the attribution loop.
 *
 * For every retrieval_event created during this session that has no
 * outcome yet, this hook:
 *   1. Reads the stored retrieved_ids + their content from the DB
 *   2. Scans the session transcript's assistant messages after the event
 *   3. For each retrieved memory, checks if any non-trivial substring
 *      of its content appears in an assistant reply
 *   4. Memories that appear → cited_ids + outcome=helpful
 *   5. Memories that don't appear → unchanged (not penalised — absence
 *      of mention is not evidence of harm, per v0.16.1 design)
 *
 * This is the difference between "we CAN learn" and "we DO learn."
 *
 * No LLM calls — pure substring matching. Future versions can call a
 * cheap local Haiku or Ollama judge for nuanced labels.
 *
 * Install: copied to ~/.claude/scripts/hooks/ by neuromcp-init-wiki.
 * Registered under Stop in ~/.claude/settings.json.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = os.homedir();
const DB_PATH = process.env.NEUROMCP_DB || path.join(HOME, '.neuromcp', 'memory.db');
const LOG_PATH = path.join(HOME, '.neuromcp', 'critic.log');
const SQLITE_BIN = process.env.NEUROMCP_SQLITE || 'sqlite3';

const MIN_SNIPPET_LEN = 80;  // raised from 40 per P0 review     // skip memory snippets shorter than this
const SNIPPET_WINDOW = 120;     // length of candidate substrings to test
const SNIPPET_STEP = 60;        // sliding-window step
const MIN_HIT_CHARS = 60;  // raised from 30 per P0 review — boilerplate like imports/greetings below this length       // required overlap for a match

function log(line) {
  try { fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`); } catch {}
}

function sql(query, args = []) {
  // sqlite3 CLI doesn't bind params — inline them with escaping. All
  // inputs here are internally-generated (IDs, ISO timestamps) so the
  // surface is small; still use a strict whitelist check.
  let interpolated = query;
  for (const arg of args) {
    const safe = String(arg).replace(/'/g, "''");
    interpolated = interpolated.replace('?', `'${safe}'`);
  }
  const result = spawnSync(
    SQLITE_BIN,
    [DB_PATH, '-json', interpolated],
    { encoding: 'utf8', timeout: 10000 },
  );
  if (result.status !== 0) {
    log(`sqlite error: ${result.stderr}`);
    return null;
  }
  try {
    return JSON.parse(result.stdout || '[]');
  } catch {
    return null;
  }
}

function sqlExec(query) {
  const r = spawnSync(SQLITE_BIN, [DB_PATH], {
    input: query,
    encoding: 'utf8',
    timeout: 10000,
  });
  return r.status === 0;
}

function readTranscript(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function extractAssistantTurns(transcriptRaw) {
  // Returns array of { timestamp, text } for each assistant turn so we can
  // scope-match per retrieval_event (codex P0 finding: one blob across all
  // events causes cross-event contamination).
  const turns = [];
  for (const line of transcriptRaw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant' && entry.message?.role !== 'assistant') continue;
      const msg = entry.message || entry;
      const content = msg.content;
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block?.text === 'string') text += (text ? '\n' : '') + block.text;
        }
      }
      const ts = entry.timestamp || entry.created_at || msg.created_at || '';
      if (text) turns.push({ timestamp: ts, text });
    } catch {
      // skip malformed lines
    }
  }
  return turns;
}

function turnsAfter(turns, sinceIso) {
  if (!sinceIso) return turns;
  return turns.filter((t) => !t.timestamp || t.timestamp >= sinceIso);
}

function memoryCitedInText(memoryContent, responseText) {
  if (!memoryContent || memoryContent.length < MIN_SNIPPET_LEN) return false;
  // Test sliding windows — robust to minor paraphrases of the middle of a sentence.
  for (let start = 0; start + SNIPPET_WINDOW <= memoryContent.length; start += SNIPPET_STEP) {
    const window = memoryContent.slice(start, start + SNIPPET_WINDOW);
    // Look for any SNIPPET length substring from window that appears in response.
    for (let i = 0; i + MIN_HIT_CHARS <= window.length; i += 10) {
      const needle = window.slice(i, i + MIN_HIT_CHARS);
      if (responseText.includes(needle)) return true;
    }
  }
  // Also try first 80 chars as a direct substring
  if (memoryContent.length >= 80) {
    const head = memoryContent.slice(0, 80);
    if (responseText.includes(head)) return true;
  }
  return false;
}

function main() {
  // Pass through stdin for the hook chain
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch {}
  process.stdout.write(raw);

  if (!fs.existsSync(DB_PATH)) {
    log('DB not found — skipping critic pass');
    return;
  }

  let transcriptPath = null;
  let hookEvent = process.env.CLAUDE_HOOK_EVENT || '';
  try {
    const parsed = JSON.parse(raw);
    transcriptPath = parsed.transcript_path || null;
    hookEvent = hookEvent || parsed.hook_event_name || parsed.hookEventName || '';
  } catch {}

  const isStop = hookEvent === 'Stop' || hookEvent === 'SessionEnd' || (!hookEvent && transcriptPath);
  if (!isStop) return;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    log('no transcript');
    return;
  }

  const transcriptRaw = readTranscript(transcriptPath);
  if (!transcriptRaw) {
    log('transcript unreadable');
    return;
  }
  const turns = extractAssistantTurns(transcriptRaw);
  if (turns.length === 0) {
    log('no assistant text in transcript');
    return;
  }

  // v0.17.4: filter events by session_id so cross-session credit stealing
  // is impossible. We derive a session key from the transcript path (which
  // is unique per Claude session). Events without a session_id are either
  // pre-v0.17.4 data or non-Claude callers — skip them here rather than
  // blanket-attribute across sessions.
  const crypto = require('node:crypto');
  const sessionId = crypto.createHash('sha256').update(transcriptPath).digest('hex').slice(0, 16);
  const windowSince = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  const events = sql(
    `SELECT id, namespace, retrieved_ids, created_at, session_id FROM retrieval_events
      WHERE outcome IS NULL AND created_at >= ? AND session_id = ?
      ORDER BY created_at DESC
      LIMIT 200`,
    [windowSince, sessionId],
  );
  if (!events || events.length === 0) {
    log('no uncritiqued events in window');
    return;
  }

  let eventsCritiqued = 0;
  let totalCited = 0;

  for (const ev of events) {
    let ids;
    try { ids = JSON.parse(ev.retrieved_ids); } catch { continue; }
    if (!Array.isArray(ids) || ids.length === 0) continue;

    // Load memory content for the retrieved ids
    const placeholders = ids.map(() => '?').join(',');
    const memories = sql(
      `SELECT id, substr(content, 1, 8000) AS content FROM memories WHERE id IN (${placeholders})`,
      ids,
    );
    if (!memories) continue;

    // Score each memory ONLY against assistant turns after this specific event.
    // Removes the cross-event contamination codex flagged.
    const scopedTurns = turnsAfter(turns, ev.created_at);
    if (scopedTurns.length === 0) continue;
    const scopedText = scopedTurns.map((t) => t.text).join('\n');
    const cited = [];
    for (const m of memories) {
      if (memoryCitedInText(m.content, scopedText)) cited.push(m.id);
    }

    if (cited.length === 0) {
      // No signal — leave event uncritiqued. Future passes or manual cite
      // can still label it. Do NOT write outcome=neutral, because absence
      // of citation is not evidence (v0.16.1 lesson).
      continue;
    }

    // Post the critic verdict via SQL directly. We use the same upsert
    // the TypeScript path uses so the usefulness score stays consistent.
    const escapedCited = cited.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
    const now = new Date().toISOString();
    const updates = [];
    updates.push(`UPDATE retrieval_events SET cited_ids = '${JSON.stringify(cited).replace(/'/g, "''")}', outcome = 'helpful', critic_reason = 'pattern-match', critiqued_at = '${now}' WHERE id = '${ev.id}';`);
    for (const memId of cited) {
      updates.push(
        `INSERT INTO memory_usefulness (memory_id, namespace, helpful_count, neutral_count, harmful_count, total_observed, usefulness_score, last_updated, last_critiqued_at)
         VALUES ('${memId}', '${ev.namespace.replace(/'/g, "''")}', 1, 0, 0, 1, 0.67, '${now}', '${now}')
         ON CONFLICT(memory_id) DO UPDATE SET
           helpful_count = helpful_count + 1,
           total_observed = total_observed + 1,
           usefulness_score = CAST(helpful_count + 1 + 1 AS REAL) / CAST(helpful_count + 1 + harmful_count + 2 AS REAL),
           last_updated = '${now}',
           last_critiqued_at = '${now}';`
      );
      updates.push(
        `UPDATE retrieval_event_memories SET was_cited = 1 WHERE event_id = '${ev.id}' AND memory_id = '${memId}';`
      );
    }
    const atomicBatch = `BEGIN;\n${updates.join('\n')}\nCOMMIT;`;
    if (sqlExec(atomicBatch)) {
      eventsCritiqued++;
      totalCited += cited.length;
    }
  }

  log(`scanned ${events.length} events → critiqued ${eventsCritiqued}, cited ${totalCited} memories`);
}

try { main(); } catch (err) {
  log(`error: ${err?.message || err}`);
}
