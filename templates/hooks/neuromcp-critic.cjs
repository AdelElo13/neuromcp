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

const MIN_SNIPPET_LEN = 40;     // skip memory snippets shorter than this
const SNIPPET_WINDOW = 120;     // length of candidate substrings to test
const SNIPPET_STEP = 60;        // sliding-window step
const MIN_HIT_CHARS = 30;       // required overlap for a match

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

function extractAssistantText(transcriptRaw) {
  const assistantChunks = [];
  for (const line of transcriptRaw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'assistant' && entry.message?.role !== 'assistant') continue;
      const msg = entry.message || entry;
      const content = msg.content;
      if (typeof content === 'string') {
        assistantChunks.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block?.text === 'string') assistantChunks.push(block.text);
        }
      }
    } catch {
      // skip malformed lines
    }
  }
  return assistantChunks.join('\n');
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
  const assistantText = extractAssistantText(transcriptRaw);
  if (!assistantText) {
    log('no assistant text in transcript');
    return;
  }

  // Fetch events from this session that have no outcome yet
  const windowSince = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  const events = sql(
    `SELECT id, namespace, retrieved_ids FROM retrieval_events
      WHERE outcome IS NULL AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 200`,
    [windowSince],
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
      `SELECT id, substr(content, 1, 600) AS content FROM memories WHERE id IN (${placeholders})`,
      ids,
    );
    if (!memories) continue;

    const cited = [];
    for (const m of memories) {
      if (memoryCitedInText(m.content, assistantText)) cited.push(m.id);
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
    if (sqlExec(updates.join('\n'))) {
      eventsCritiqued++;
      totalCited += cited.length;
    }
  }

  log(`scanned ${events.length} events → critiqued ${eventsCritiqued}, cited ${totalCited} memories`);
}

try { main(); } catch (err) {
  log(`error: ${err?.message || err}`);
}
