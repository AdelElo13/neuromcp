#!/usr/bin/env node
'use strict';

/**
 * neuromcp-critic.cjs — Stop hook that closes the attribution loop.
 *
 * v0.18.0: two-tier critic.
 *
 * TIER 1 (default when Ollama is running): semantic judge. For each
 * uncritiqued retrieval event, call the local Ollama chat model with
 * (query, retrieved memories, session assistant replies) and let it
 * emit a strict JSON verdict per memory. This captures paraphrase and
 * concept reuse that pattern-matching misses.
 *
 * TIER 2 (fallback when Ollama is unavailable): lexical substring
 * match. Scan sliding 120-char windows of each memory for >= 60-char
 * overlap with the session's assistant replies after the event.
 *
 * In both tiers:
 *   - Events are scoped per session (session_id filter) + per event
 *     (turnsAfter(event.created_at))
 *   - Only cited memories are labelled; unlabelled memories are left
 *     alone (absence of evidence != evidence against)
 *   - All writes happen in a single BEGIN/COMMIT
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const HOME = os.homedir();
const DB_PATH = process.env.NEUROMCP_DB || path.join(HOME, '.neuromcp', 'memory.db');
const LOG_PATH = path.join(HOME, '.neuromcp', 'critic.log');
const SQLITE_BIN = process.env.NEUROMCP_SQLITE || 'sqlite3';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.NEUROMCP_OLLAMA_CHAT_MODEL || 'llama3.2:3b';
const CRITIC_MODE = (process.env.NEUROMCP_CRITIC_MODE || 'auto').toLowerCase();
const CRITIC_TIMEOUT_MS = parseInt(process.env.NEUROMCP_CRITIC_TIMEOUT_MS || '20000', 10);

// Lexical fallback thresholds
const MIN_HIT_CHARS = 60;
const MIN_SNIPPET_LEN = 80;
const SNIPPET_WINDOW = 120;
const SNIPPET_STEP = 60;
const MEMORY_CONTENT_CAP = 8000;

function log(line) {
  try { fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`); } catch {}
}

function sql(query, args = []) {
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
  try { return JSON.parse(result.stdout || '[]'); } catch { return null; }
}

function sqlExec(query) {
  const r = spawnSync(SQLITE_BIN, [DB_PATH], {
    input: query, encoding: 'utf8', timeout: 10000,
  });
  return r.status === 0;
}

// ─── Ollama semantic judge ─────────────────────────────────────────

function ollamaAvailable() {
  return new Promise((resolve) => {
    const req = http.get(`${OLLAMA_HOST}/api/tags`, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const models = (parsed.models || []).map((m) => m.name);
          resolve(models.some((n) => n.startsWith(OLLAMA_MODEL.split(':')[0])));
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function ollamaJudge(query, memories, responseText) {
  return new Promise((resolve) => {
    const memoryList = memories.map((m, i) => `[${i}] ${m.content.slice(0, 600)}`).join('\n\n');
    const prompt = `You are a strict judge of whether retrieved memories actually helped produce a response.

Given a USER QUERY, a list of RETRIEVED MEMORIES (indexed), and the ASSISTANT RESPONSE, decide for each memory: did it contribute useful information to the response?

RULES:
- Only mark a memory "helpful" if its specific content (facts, names, decisions, code) appears or is clearly paraphrased in the response.
- Mark "harmful" if the response contradicts the memory OR if including it would have misled the user.
- Mark "neutral" if the memory was retrieved but not used.
- Output ONLY a JSON object, nothing else.

USER QUERY:
${query.slice(0, 500)}

RETRIEVED MEMORIES:
${memoryList}

ASSISTANT RESPONSE:
${responseText.slice(0, 4000)}

Output JSON schema:
{"verdicts":[{"index":0,"label":"helpful|neutral|harmful","reason":"one sentence"}]}`;

    const body = JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature: 0.1, num_predict: 400 },
    });

    const url = new URL('/api/generate', OLLAMA_HOST);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: CRITIC_TIMEOUT_MS,
    }, (res) => {
      let respBody = '';
      res.on('data', (c) => respBody += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(respBody);
          const raw = parsed.response || '';
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (!jsonMatch) return resolve(null);
          const verdicts = JSON.parse(jsonMatch[0]);
          resolve(verdicts);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── Lexical fallback ──────────────────────────────────────────────

function memoryCitedInText(memoryContent, responseText) {
  if (!memoryContent || memoryContent.length < MIN_SNIPPET_LEN) return false;
  for (let start = 0; start + SNIPPET_WINDOW <= memoryContent.length; start += SNIPPET_STEP) {
    const window = memoryContent.slice(start, start + SNIPPET_WINDOW);
    for (let i = 0; i + MIN_HIT_CHARS <= window.length; i += 10) {
      const needle = window.slice(i, i + MIN_HIT_CHARS);
      if (responseText.includes(needle)) return true;
    }
  }
  if (memoryContent.length >= 80) {
    const head = memoryContent.slice(0, 80);
    if (responseText.includes(head)) return true;
  }
  return false;
}

// ─── Transcript helpers ────────────────────────────────────────────

function extractAssistantTurns(transcriptRaw) {
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
    } catch {}
  }
  return turns;
}

function turnsAfter(turns, sinceIso) {
  if (!sinceIso) return turns;
  return turns.filter((t) => !t.timestamp || t.timestamp >= sinceIso);
}

function readTranscript(path) {
  try { return fs.readFileSync(path, 'utf8'); } catch { return null; }
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch {}
  process.stdout.write(raw);

  if (!fs.existsSync(DB_PATH)) return;

  let transcriptPath = null;
  let hookEvent = process.env.CLAUDE_HOOK_EVENT || '';
  try {
    const parsed = JSON.parse(raw);
    transcriptPath = parsed.transcript_path || null;
    hookEvent = hookEvent || parsed.hook_event_name || parsed.hookEventName || '';
  } catch {}

  const isStop = hookEvent === 'Stop' || hookEvent === 'SessionEnd' || (!hookEvent && transcriptPath);
  if (!isStop || !transcriptPath || !fs.existsSync(transcriptPath)) return;

  const transcriptRaw = readTranscript(transcriptPath);
  if (!transcriptRaw) return;
  const turns = extractAssistantTurns(transcriptRaw);
  if (turns.length === 0) return;

  const sessionId = crypto.createHash('sha256').update(transcriptPath).digest('hex').slice(0, 16);
  const windowSince = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  const events = sql(
    `SELECT id, namespace, retrieved_ids, created_at, session_id FROM retrieval_events
      WHERE outcome IS NULL AND created_at >= ?
        AND (session_id = ? OR session_id IS NULL)
      ORDER BY created_at DESC
      LIMIT 200`,
    [windowSince, sessionId],
  );
  if (!events || events.length === 0) return;

  // Decide mode: auto/semantic/lexical
  let useSemantic = false;
  if (CRITIC_MODE === 'semantic') useSemantic = true;
  else if (CRITIC_MODE === 'lexical') useSemantic = false;
  else useSemantic = await ollamaAvailable();

  log(`scanning ${events.length} events in ${useSemantic ? 'SEMANTIC' : 'LEXICAL'} mode`);

  let eventsCritiqued = 0;
  let totalCited = 0;
  let totalHarmful = 0;

  for (const ev of events) {
    let ids;
    try { ids = JSON.parse(ev.retrieved_ids); } catch { continue; }
    if (!Array.isArray(ids) || ids.length === 0) continue;

    const scopedTurns = turnsAfter(turns, ev.created_at);
    if (scopedTurns.length === 0) continue;
    const scopedText = scopedTurns.map((t) => t.text).join('\n');

    const placeholders = ids.map(() => '?').join(',');
    const memories = sql(
      `SELECT id, substr(content, 1, ${MEMORY_CONTENT_CAP}) AS content FROM memories WHERE id IN (${placeholders})`,
      ids,
    );
    if (!memories) continue;

    let verdicts = []; // [{id, label, reason}]
    if (useSemantic) {
      const queryRow = sql(`SELECT query FROM retrieval_events WHERE id = ?`, [ev.id]);
      const query = queryRow?.[0]?.query || '';
      const judge = await ollamaJudge(query, memories, scopedText);
      if (judge && Array.isArray(judge.verdicts)) {
        for (const v of judge.verdicts) {
          const mem = memories[v.index];
          if (mem && (v.label === 'helpful' || v.label === 'neutral' || v.label === 'harmful')) {
            verdicts.push({ id: mem.id, label: v.label, reason: (v.reason || '').slice(0, 240) });
          }
        }
      } else {
        // Ollama failed mid-batch — fall back for this event
        for (const m of memories) {
          if (memoryCitedInText(m.content, scopedText)) {
            verdicts.push({ id: m.id, label: 'helpful', reason: 'lexical-fallback' });
          }
        }
      }
    } else {
      for (const m of memories) {
        if (memoryCitedInText(m.content, scopedText)) {
          verdicts.push({ id: m.id, label: 'helpful', reason: 'pattern-match' });
        }
      }
    }

    // Group by label
    const helpful = verdicts.filter((v) => v.label === 'helpful').map((v) => v.id);
    const harmful = verdicts.filter((v) => v.label === 'harmful').map((v) => v.id);
    const cited = [...helpful, ...harmful];
    if (cited.length === 0) continue;

    // Compose a combined reason for the event (first verdict's reason is representative enough)
    const primaryReason = verdicts[0]?.reason || 'critic';
    const outcome = harmful.length > helpful.length ? 'harmful' : 'helpful';

    const citedJson = JSON.stringify(cited).replace(/'/g, "''");
    const now = new Date().toISOString();
    const updates = [];
    updates.push(
      `UPDATE retrieval_events SET cited_ids = '${citedJson}', outcome = '${outcome}', critic_reason = '${primaryReason.replace(/'/g, "''")}', model = '${useSemantic ? OLLAMA_MODEL : 'lexical'}', critiqued_at = '${now}' WHERE id = '${ev.id}';`
    );
    for (const v of verdicts) {
      const memId = v.id;
      if (v.label === 'neutral') {
        // v0.18.1 (architect round-16): record neutral signal so the
        // prior can learn 'retrieved and explicitly not helpful'. Skipping
        // neutrals entirely left no learning signal for observed-but-unused.
        updates.push(
          `INSERT INTO memory_usefulness (memory_id, namespace, helpful_count, neutral_count, harmful_count, total_observed, usefulness_score, last_updated, last_critiqued_at)
           VALUES ('${memId}', '${ev.namespace.replace(/'/g, "''")}', 0, 1, 0, 1, 0.5, '${now}', '${now}')
           ON CONFLICT(memory_id) DO UPDATE SET
             neutral_count = neutral_count + 1,
             total_observed = total_observed + 1,
             last_updated = '${now}',
             last_critiqued_at = '${now}';`
        );
        continue;
      }
      const helpfulDelta = v.label === 'helpful' ? 1 : 0;
      const harmfulDelta = v.label === 'harmful' ? 1 : 0;
      const initialScore = helpfulDelta === 1 ? 0.67 : 0.33;
      updates.push(
        `INSERT INTO memory_usefulness (memory_id, namespace, helpful_count, neutral_count, harmful_count, total_observed, usefulness_score, last_updated, last_critiqued_at)
         VALUES ('${memId}', '${ev.namespace.replace(/'/g, "''")}', ${helpfulDelta}, 0, ${harmfulDelta}, 1, ${initialScore}, '${now}', '${now}')
         ON CONFLICT(memory_id) DO UPDATE SET
           helpful_count = helpful_count + ${helpfulDelta},
           harmful_count = harmful_count + ${harmfulDelta},
           total_observed = total_observed + 1,
           usefulness_score = CAST(helpful_count + ${helpfulDelta} + 1 AS REAL) / CAST(helpful_count + ${helpfulDelta} + harmful_count + ${harmfulDelta} + 2 AS REAL),
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
      totalCited += helpful.length;
      totalHarmful += harmful.length;
    }
  }

  log(`${useSemantic ? 'semantic' : 'lexical'}: ${events.length} events → critiqued ${eventsCritiqued}, helpful ${totalCited}, harmful ${totalHarmful}`);
}

main().catch((err) => log(`error: ${err?.message || err}`));
