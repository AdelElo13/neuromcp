#!/usr/bin/env node
/**
 * neuromcp-auto-capture.js — Deterministic session fact extractor
 *
 * Stop hook that reads the session transcript and extracts high-signal items:
 * - CronCreate / ScheduleWakeup calls (intents that die with sessions)
 * - Explicit "remember this" / "onthoud dit" requests
 * - Domain/URL monitoring setups
 * - Key decisions and commitments
 *
 * Writes extracted items directly to neuromcp SQLite with source='hook'.
 * No LLM calls — pure pattern matching for cost efficiency.
 *
 * v0.9.0 — Part of neuromcp auto-capture initiative
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DB_PATH = process.env.NEUROMCP_DB_PATH || path.join(process.env.HOME || '/Users/a', '.neuromcp', 'memory.db');
const LOG_PATH = path.join(path.dirname(DB_PATH), 'auto-capture.log');

// ─── Pattern Extractors ────────────────────────────────────────────

/**
 * Each extractor returns an array of { content, category, tags, importance }
 * from parsed transcript entries.
 */
const extractors = {

  /**
   * Detect CronCreate tool calls — these are intents that die with sessions.
   * Captures the schedule and prompt so they can be recreated.
   */
  cronCreate(entries) {
    const results = [];
    for (const entry of entries) {
      const blocks = getToolUseBlocks(entry);
      for (const block of blocks) {
        if (block.name !== 'CronCreate') continue;
        const { schedule, prompt } = block.input || {};
        if (!schedule || !prompt) continue;
        results.push({
          content: `[intent:cron] Schedule: "${schedule}" | Prompt: "${prompt.slice(0, 500)}"`,
          category: 'intent',
          tags: ['cron', 'auto-captured', 'recurring'],
          importance: 0.85,
          metadata: { tool: 'CronCreate', schedule, prompt_preview: prompt.slice(0, 200) },
        });
      }
    }
    return results;
  },

  /**
   * Detect ScheduleWakeup calls — loop-mode intents.
   */
  scheduleWakeup(entries) {
    const results = [];
    for (const entry of entries) {
      const blocks = getToolUseBlocks(entry);
      for (const block of blocks) {
        if (block.name !== 'ScheduleWakeup') continue;
        const { delaySeconds, reason, prompt } = block.input || {};
        if (!reason) continue;
        results.push({
          content: `[intent:wakeup] Reason: "${reason}" | Delay: ${delaySeconds}s | Prompt: "${(prompt || '').slice(0, 300)}"`,
          category: 'intent',
          tags: ['wakeup', 'auto-captured', 'recurring'],
          importance: 0.8,
          metadata: { tool: 'ScheduleWakeup', delaySeconds, reason },
        });
      }
    }
    return results;
  },

  /**
   * Detect explicit "remember" / "onthoud" requests from the user.
   */
  explicitRemember(entries) {
    const results = [];
    const patterns = [
      /\b(?:remember|onthoud|vergeet niet|don'?t forget|save this|sla op)\b[:\s]+(.{10,300})/i,
      /\b(?:remember|onthoud)\s+(?:that|dat)\s+(.{10,300})/i,
    ];

    for (const entry of entries) {
      const text = getUserText(entry);
      if (!text) continue;
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          results.push({
            content: `[user-request] ${match[1].trim()}`,
            category: 'decision',
            tags: ['explicit-remember', 'auto-captured', 'user-stated'],
            importance: 0.9,
            metadata: { trigger: 'explicit-remember', full_message: text.slice(0, 500) },
          });
          break; // one match per message
        }
      }
    }
    return results;
  },

  /**
   * Detect domain/URL monitoring setups (whois checks, availability monitors).
   */
  domainMonitoring(entries) {
    const results = [];
    const domainCheckPattern = /whois\s+(\S+\.\w{2,})|(?:check|monitor|watch)\s+(?:if\s+)?(\S+\.\w{2,})\s+(?:is\s+)?(?:available|free|vrij)/i;

    for (const entry of entries) {
      // Check in Bash tool calls
      const blocks = getToolUseBlocks(entry);
      for (const block of blocks) {
        if (block.name !== 'Bash') continue;
        const cmd = block.input?.command || '';
        const match = cmd.match(domainCheckPattern);
        if (match) {
          const domain = match[1] || match[2];
          results.push({
            content: `[intent:domain-watch] Monitoring domain: ${domain} for availability`,
            category: 'intent',
            tags: ['domain', 'auto-captured', 'monitoring'],
            importance: 0.8,
            metadata: { domain, trigger: 'whois-command' },
          });
        }
      }

      // Check in user messages
      const text = getUserText(entry);
      if (!text) continue;
      const match = text.match(domainCheckPattern);
      if (match) {
        const domain = match[1] || match[2];
        results.push({
          content: `[intent:domain-watch] User wants to monitor domain: ${domain}`,
          category: 'intent',
          tags: ['domain', 'auto-captured', 'monitoring'],
          importance: 0.85,
          metadata: { domain, trigger: 'user-message' },
        });
      }
    }

    // Deduplicate by domain
    const seen = new Set();
    return results.filter(r => {
      const domain = r.metadata.domain;
      if (seen.has(domain)) return false;
      seen.add(domain);
      return true;
    });
  },

  /**
   * Detect key decisions and commitments in assistant responses.
   * Looks for strong decision language patterns.
   */
  decisions(entries) {
    const results = [];
    const patterns = [
      /(?:we decided|we agreed|het plan is|de aanpak is|consensus|we'll go with|we gaan voor)\s*(?:to\s+|dat\s+|:\s*)?(.{20,400})/i,
      /(?:definitieve keuze|final decision|chosen approach|gekozen aanpak)\s*(?:is|:)\s*(.{20,400})/i,
    ];

    for (const entry of entries) {
      const text = getAssistantText(entry);
      if (!text) continue;
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          results.push({
            content: `[decision] ${match[1].trim().slice(0, 400)}`,
            category: 'decision',
            tags: ['decision', 'auto-captured'],
            importance: 0.75,
            metadata: { trigger: 'decision-language' },
          });
          break;
        }
      }
    }
    return results;
  },

  /**
   * Detect deployment/publish events — important milestones.
   */
  deployments(entries) {
    const results = [];
    const patterns = [
      /(?:npm publish|npx publish|vercel deploy|deployed to|pushed to production|live at)\s+(\S+)/i,
      /(?:v\d+\.\d+\.\d+)\s+(?:published|released|deployed)/i,
    ];

    for (const entry of entries) {
      const blocks = getToolUseBlocks(entry);
      for (const block of blocks) {
        if (block.name !== 'Bash') continue;
        const cmd = block.input?.command || '';
        for (const pattern of patterns) {
          const match = cmd.match(pattern);
          if (match) {
            results.push({
              content: `[event:deploy] ${cmd.slice(0, 300)}`,
              category: 'event',
              tags: ['deployment', 'auto-captured'],
              importance: 0.7,
              metadata: { command: cmd.slice(0, 200) },
            });
            break;
          }
        }
      }
    }
    return results;
  },

  /**
   * Detect bug-fix narratives in assistant output: explicit root-cause +
   * resolution language. Captures the fix recipe so the same problem can
   * be recognized faster next time.
   *
   * Patterns are intentionally narrow (require clear causal markers) to
   * keep precision high. Recall is sacrificed — generic "i fixed it"
   * statements are skipped on purpose.
   */
  bugFixes(entries) {
    const results = [];
    const patterns = [
      /(?:root cause(?:\s+was|\s+is|:)?|de oorzaak (?:was|is|:)|het probleem (?:was|is|:)|the bug (?:was|is|:))\s+([^.\n]{20,400}?)(?:[.\n]|$)/i,
      /(?:fixed by|opgelost door|resolved by|gefikst met)\s+([^.\n]{15,400}?)(?:[.\n]|$)/i,
      /(?:smoking gun|gevonden:|found it:)\s+([^.\n]{20,400}?)(?:[.\n]|$)/i,
    ];

    const seen = new Set();
    for (const entry of entries) {
      const text = getAssistantText(entry);
      if (!text) continue;
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) continue;
        const captured = match[1].trim();
        const dedupKey = captured.slice(0, 80).toLowerCase();
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        results.push({
          content: `[fix] ${captured.slice(0, 400)}`,
          category: 'fix',
          tags: ['fix', 'auto-captured', 'root-cause'],
          importance: 0.85,
          metadata: { trigger: 'fix-narrative', context: text.slice(0, 200) },
        });
        break; // one fix per entry
      }
    }
    return results;
  },

  /**
   * Detect package/tool installs. Each install is a permanent change to
   * the user's environment — worth remembering so future sessions know
   * what's available.
   */
  toolInstalls(entries) {
    const results = [];
    const patterns = [
      /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\s+(?:-[a-zA-Z]+\s+)?(@?[a-zA-Z0-9][\w@/-]+)/,
      /\bpip3?\s+install\s+(?:-[a-zA-Z]+\s+)?([a-zA-Z][\w-]+)/,
      /\bbrew\s+install\s+([a-zA-Z][\w-]+)/,
      /\bcargo\s+install\s+([a-zA-Z][\w-]+)/,
      /\bgh\s+extension\s+install\s+(\S+)/,
      /\buv\s+(?:add|pip\s+install)\s+([a-zA-Z][\w-]+)/,
    ];

    const seen = new Set();
    for (const entry of entries) {
      const blocks = getToolUseBlocks(entry);
      for (const block of blocks) {
        if (block.name !== 'Bash') continue;
        const cmd = block.input?.command || '';
        for (const pattern of patterns) {
          const match = cmd.match(pattern);
          if (!match) continue;
          const pkg = match[1];
          if (pkg.length < 2 || /^[-_]/.test(pkg)) continue;
          const key = `${pkg}:${cmd.slice(0, 30)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const mgrMatch = cmd.match(/\b(npm|pnpm|yarn|bun|pip3?|brew|cargo|gh|uv)\b/);
          const manager = mgrMatch ? mgrMatch[1] : 'unknown';
          results.push({
            content: `[install] ${manager} install ${pkg}`,
            category: 'event',
            tags: ['install', 'auto-captured', manager],
            importance: 0.6,
            metadata: { manager, package: pkg, command: cmd.slice(0, 200) },
          });
          break;
        }
      }
    }
    return results;
  },

  /**
   * Detect edits to critical configuration files. We do NOT capture the
   * file contents (PII risk + size); we capture only the fact that the
   * file was modified, so future sessions know to re-read it.
   */
  criticalConfigEdits(entries) {
    const results = [];
    const criticalNames = new Set([
      'CLAUDE.md', 'hooks.json', 'settings.json', 'settings.local.json',
      '.env', '.env.local', '.env.production',
      'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod',
      'vercel.json', 'vercel.ts', 'tsconfig.json', 'next.config.js',
      'next.config.mjs', 'next.config.ts',
    ]);

    const seen = new Set();
    for (const entry of entries) {
      const blocks = getToolUseBlocks(entry);
      for (const block of blocks) {
        if (block.name !== 'Edit' && block.name !== 'Write') continue;
        const filePath = block.input?.file_path || block.input?.path || '';
        if (!filePath) continue;
        const basename = path.basename(filePath);
        if (!criticalNames.has(basename)) continue;
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        results.push({
          content: `[config-edit] ${block.name} on ${filePath}`,
          category: 'event',
          tags: ['config-edit', 'auto-captured', basename.toLowerCase().replace(/\./g, '-')],
          importance: 0.7,
          metadata: { tool: block.name, file: filePath, basename },
        });
      }
    }
    return results;
  },
};

// ─── Transcript Helpers ────────────────────────────────────────────

function getToolUseBlocks(entry) {
  const blocks = [];
  // Direct tool_use entry
  if (entry.type === 'tool_use' || entry.tool_name) {
    blocks.push({
      name: entry.tool_name || entry.name || '',
      input: entry.tool_input || entry.input || {},
    });
  }
  // Nested in assistant message content
  if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
    for (const block of entry.message.content) {
      if (block.type === 'tool_use') {
        blocks.push({ name: block.name || '', input: block.input || {} });
      }
    }
  }
  return blocks;
}

function getUserText(entry) {
  if (entry.type !== 'user' && entry.role !== 'user' && entry.message?.role !== 'user') return null;
  const raw = entry.message?.content ?? entry.content;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(c => c?.text || '').join(' ');
  return null;
}

function getAssistantText(entry) {
  if (entry.type !== 'assistant' && entry.message?.role !== 'assistant') return null;
  const raw = entry.message?.content ?? entry.content;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(c => c?.text || '').join(' ');
  return null;
}

// ─── Memory Writer (HTTP-first, raw SQL fallback) ──────────────────

const HTTP_URL = `http://127.0.0.1:${process.env.NEUROMCP_HTTP_PORT || 3200}/api/store`;

/**
 * Try HTTP first (goes through full store pipeline: dedup, contradiction,
 * embeddings, entity extraction, claims). Falls back to raw SQL if HTTP
 * is unavailable.
 */
function insertMemory(item) {
  // Try HTTP endpoint first (full pipeline)
  if (tryHttpStore(item)) return true;
  // Fallback: raw SQL (no embeddings, no contradiction detection)
  return tryRawSqlStore(item);
}

function tryHttpStore(item) {
  const http = require('http');
  const payload = JSON.stringify({
    content: item.content,
    category: item.category || 'general',
    tags: item.tags || [],
    importance: item.importance || 0.5,
    source: 'hook',
    metadata: item.metadata || {},
  });

  try {
    const result = execFileSync('node', ['-e', `
      const http = require('http');
      const payload = ${JSON.stringify(payload)};
      const req = http.request('${HTTP_URL}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 8000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode === 200) { console.log('OK:' + data); process.exit(0); }
          else { console.error('HTTP ' + res.statusCode); process.exit(1); }
        });
      });
      req.on('error', () => process.exit(1));
      req.on('timeout', () => { req.destroy(); process.exit(1); });
      req.write(payload);
      req.end();
    `], { encoding: 'utf8', timeout: 10000 });

    if (result.startsWith('OK:')) {
      logMsg('[HTTP] Stored via full pipeline');
      return true;
    }
  } catch {
    // HTTP not available, fall through to raw SQL
  }
  return false;
}

function tryRawSqlStore(item) {
  if (!fs.existsSync(DB_PATH)) {
    logMsg('DB not found at ' + DB_PATH);
    return false;
  }

  const id = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(item.content).digest('hex');
  const now = new Date().toISOString();
  const tagsJSON = JSON.stringify(item.tags || []);
  const metadataJSON = JSON.stringify(item.metadata || {});

  // Dedup check
  try {
    const count = execFileSync('sqlite3', [DB_PATH,
      `SELECT COUNT(*) FROM memories WHERE content_hash='${hash}' AND is_deleted=0`
    ], { encoding: 'utf8', timeout: 5000 }).trim();
    if (parseInt(count, 10) > 0) return false;
  } catch { /* proceed */ }

  const sql = `INSERT INTO memories (
    id, content_hash, content, namespace, source, source_trust,
    category, tags, importance, metadata, created_at, updated_at,
    schema_version, visibility, embedding_model, embedding_dim,
    access_count, is_deleted, surprise_score, ease_factor, review_count
  ) VALUES (
    '${id}', '${hash}',
    '${item.content.replace(/'/g, "''")}',
    'default', 'hook', 'medium',
    '${(item.category || 'general').replace(/'/g, "''")}',
    '${tagsJSON.replace(/'/g, "''")}',
    ${item.importance || 0.5},
    '${metadataJSON.replace(/'/g, "''")}',
    '${now}', '${now}',
    7, 'namespace', 'none', 0,
    0, 0, 0, 2.5, 0
  );
INSERT INTO memories_fts (rowid, content, summary, tags, category)
  SELECT rowid, content, '', tags, category FROM memories WHERE id='${id}';`;

  const tmpFile = path.join('/tmp', `neuromcp-capture-${id}.sql`);
  try {
    fs.writeFileSync(tmpFile, sql);
    execFileSync('sqlite3', [DB_PATH, `.read ${tmpFile}`], {
      encoding: 'utf8', timeout: 5000,
    });
    fs.unlinkSync(tmpFile);
    logMsg('[SQL-fallback] Stored without pipeline');
    return true;
  } catch (err) {
    logMsg('Insert failed: ' + err.message);
    try { fs.unlinkSync(tmpFile); } catch {}
    return false;
  }
}

// ─── Logging ───────────────────────────────────────────────────────

function logMsg(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
}

// ─── Main ──────────────────────────────────────────────────────────

function main() {
  // Pass through stdin for hook chain
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch {}
  process.stdout.write(raw);

  // Parse stdin to get transcript_path + hook_event_name.
  // Claude Code passes the event via stdin JSON (hook_event_name),
  // not via CLAUDE_HOOK_EVENT env var. We accept either to stay
  // compatible with older hook runtimes.
  let transcriptPath = null;
  let hookEvent = process.env.CLAUDE_HOOK_EVENT || '';
  try {
    const parsed = JSON.parse(raw);
    transcriptPath = parsed.transcript_path || null;
    hookEvent = hookEvent || parsed.hook_event_name || parsed.hookEventName || '';
  } catch {}

  // Only react to session-terminating events. If we cannot tell (no env,
  // no field), fall back to transcript presence as a proxy — the hook is
  // wired to Stop in settings.json, so this is safe.
  const isStopEvent = hookEvent === 'Stop' || hookEvent === 'SessionEnd' || (!hookEvent && !!transcriptPath);
  if (!isStopEvent) {
    return;
  }

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    logMsg('No transcript found');
    return;
  }

  // Read and parse transcript (JSONL)
  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    logMsg('Failed to read transcript: ' + err.message);
    return;
  }

  const entries = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }

  if (entries.length === 0) {
    logMsg('Empty transcript');
    return;
  }

  // Run all extractors
  const extracted = [];
  for (const [name, extractor] of Object.entries(extractors)) {
    try {
      const items = extractor(entries);
      for (const item of items) {
        extracted.push({ ...item, extractor: name });
      }
    } catch (err) {
      logMsg(`Extractor "${name}" failed: ${err.message}`);
    }
  }

  if (extracted.length === 0) {
    logMsg(`Session scanned: ${entries.length} entries, 0 items extracted`);
    return;
  }

  // Store extracted items
  let stored = 0;
  let skipped = 0;
  for (const item of extracted) {
    if (insertMemory(item)) {
      stored++;
      logMsg(`Stored [${item.category}] via ${item.extractor}: ${item.content.slice(0, 100)}`);
    } else {
      skipped++;
    }
  }

  logMsg(`Session complete: ${entries.length} entries scanned, ${extracted.length} extracted, ${stored} stored, ${skipped} skipped (dedup)`);
}

main();
