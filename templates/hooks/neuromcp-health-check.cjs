#!/usr/bin/env node
/**
 * neuromcp-health-check — runtime health surface
 *
 * Runs at SessionStart (hook). Probes 5 dimensions of neuromcp pipeline
 * health and outputs a structured report. The point: never let a user
 * (or Claude) silently trust a degraded neuromcp install.
 *
 * Checks:
 *  1. DB present + readable
 *  2. Wiki index freshness (warn >2d, fail >14d)
 *  3. Consolidation backlog (warn if >100 queued)
 *  4. Last consolidation result (fail if Done: 0/N)
 *  5. `claude -p` subprocess auth (fail on 401 / "Not logged in")
 *
 * Output:
 *   - Healthy: single one-liner so SessionStart context stays clean.
 *   - Warnings: header + per-check lines.
 *   - Failures: full report + remediation hints. Loud on purpose.
 *
 * Exit codes:
 *   0 = healthy
 *   1 = degraded (warnings — recall may thin)
 *   2 = broken   (failures — auto-capture / consolidation cannot run)
 *
 * Designed as the loud counterpart to `neuromcp-doctor` (install-time only).
 * After v0.26 a `neuromcp-doctor --runtime` flag should call into this.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { homedir } = require('node:os');
const HOME = homedir();

// ─── claude -p auth probe: background mode + recursion guard ─────────
// The probe used to run `claude -p` synchronously on every SessionStart:
// a cold CLI needs more than the old 5 s timeout (false warning + delay on
// most session starts), the empty `--tools ''` it passed is rejected by
// current CLIs, and the nested CLI ran the user's hooks again — including
// this one. Now it runs isolated, in the background, at most every 6 h, and
// SessionStart only reports the cached result.
const PROBE_CACHE = process.env.NEUROMCP_HEALTH_PROBE_CACHE || path.join(HOME, '.neuromcp', 'health-probe.json');
const PROBE_MAX_AGE_MS = 6 * 3_600_000;
const PROBE_PENDING_MS = 120_000;
const PROBE_TIMEOUT_MS = 60_000;
const CHILD_ENV = 'NEUROMCP_HEALTH_CHECK_CHILD';

function writeProbeCache(record) {
    try {
        fs.mkdirSync(path.dirname(PROBE_CACHE), { recursive: true });
        const tmp = `${PROBE_CACHE}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(record));
        fs.renameSync(tmp, PROBE_CACHE);
    } catch (_err) { /* best effort — the next session simply probes again */ }
}

function readProbeCache() {
    try {
        const record = JSON.parse(fs.readFileSync(PROBE_CACHE, 'utf-8'));
        const age = Date.now() - Date.parse(record.checkedAt);
        return Number.isFinite(age) ? { ...record, age } : null;
    } catch (_err) {
        return null;
    }
}

if (process.argv.includes('--probe')) {
    const probe = spawnSync('claude', [
        '-p', '--no-session-persistence',
        // User settings stay (auth/endpoint config); hooks, CLAUDE.md,
        // skills and MCP servers are off — a bare text completion.
        '--setting-sources', 'user',
        '--settings', JSON.stringify({ disableAllHooks: true }),
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--model', 'haiku', 'Reply with: ok',
    ], {
        encoding: 'utf-8',
        timeout: PROBE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, [CHILD_ENV]: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
    });
    const combined = `${probe.stdout || ''}\n${probe.stderr || ''}`.trim();
    let status = 'ok';
    if (/401|Failed to auth|Not logged in|Invalid auth/i.test(combined)) status = 'auth-broken';
    else if (probe.error && probe.error.code === 'ETIMEDOUT') status = 'timeout';
    else if (probe.status !== 0) status = 'error';
    writeProbeCache({
        status,
        checkedAt: new Date().toISOString(),
        detail: status === 'ok' ? '' : combined.split('\n')[0].slice(0, 200),
    });
    process.exit(0);
}

// Never run inside our own probe (or any nested claude -p we started).
if (process.env[CHILD_ENV]) process.exit(0);
const DB           = process.env.NEUROMCP_DB           || path.join(HOME, '.neuromcp', 'memory.db');
const WIKI_INDEX   = process.env.NEUROMCP_WIKI_INDEX   || path.join(HOME, '.neuromcp', 'wiki', 'index.md');
const LOG          = process.env.NEUROMCP_LOG          || path.join(HOME, '.neuromcp', 'consolidation.log');
const SESSIONS_DIR = process.env.NEUROMCP_SESSIONS_DIR || path.join(HOME, '.neuromcp', 'raw', 'sessions');
const LEDGER       = process.env.NEUROMCP_LEDGER       || path.join(HOME, '.neuromcp', 'consolidation-ledger.json');

const NOW_MS = Date.now();
const DAY_MS = 86_400_000;

const lines = [];
let fails = 0;
let warns = 0;

function ok(msg)   { lines.push(`✓  ${msg}`); }
function warn(msg) { lines.push(`⚠️  ${msg}`); warns += 1; }
function fail(msg) { lines.push(`❌ ${msg}`); fails += 1; }
function note(msg) { lines.push(`    └─ ${msg}`); }

// Cached for the healthy one-liner
let dbSizeMb = 0;
let wikiAgeDays = 0;
let pendingSessions = 0;

// ─── 1. DB present + readable ──────────────────────────────────────────
try {
    const st = fs.statSync(DB);
    dbSizeMb = Math.floor(st.size / 1_048_576);
    ok(`DB intact (${dbSizeMb} MB)`);
} catch (_err) {
    fail(`DB missing at ${DB}`);
}

// ─── 2. Wiki freshness ────────────────────────────────────────────────
try {
    const st = fs.statSync(WIKI_INDEX);
    wikiAgeDays = Math.floor((NOW_MS - st.mtimeMs) / DAY_MS);
    if (wikiAgeDays > 14) {
        fail(`Wiki index ${wikiAgeDays}d stale — consolidation pipeline likely broken`);
    } else if (wikiAgeDays > 7) {
        warn(`Wiki index ${wikiAgeDays}d stale — recall will be thin in new sessions`);
    } else if (wikiAgeDays > 2) {
        warn(`Wiki index ${wikiAgeDays}d old`);
    } else {
        ok(`Wiki fresh (${wikiAgeDays}d)`);
    }
} catch (_err) {
    fail(`Wiki index missing at ${WIKI_INDEX}`);
}

// ─── 3. Consolidation backlog ─────────────────────────────────────────
try {
    const all = fs.readdirSync(SESSIONS_DIR)
        .filter(f => f.endsWith('.md') && !f.includes('checkpoint'));
    const total = all.length;
    let done = 0;
    try {
        const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf-8'));
        done = Array.isArray(ledger.processed) ? ledger.processed.length : 0;
    } catch (_e) { /* ledger may not exist yet */ }
    pendingSessions = Math.max(0, total - done);
    if (pendingSessions > 100) {
        warn(`${pendingSessions} sessions queued for consolidation (large backlog)`);
    } else if (pendingSessions > 0) {
        ok(`${pendingSessions} sessions queued`);
    }
} catch (_err) { /* sessions dir may not exist on a fresh install */ }

// ─── 4. Latest consolidation result ───────────────────────────────────
try {
    const log = fs.readFileSync(LOG, 'utf-8');
    const doneLines = log.split('\n').filter(l => /^Done: \d+\/\d+/.test(l));
    if (doneLines.length > 0) {
        const last = doneLines[doneLines.length - 1];
        const match = last.match(/^Done: (\d+)\/(\d+)/);
        if (match) {
            const [, processed, total] = match;
            if (processed === '0' && total !== '0') {
                fail(`Last consolidation: ${last} — wiki not being updated`);
                // Surface the underlying error from the last WARN/ERROR line.
                const errorLines = log.split('\n').filter(l => /WARN:|❌|ERROR/.test(l));
                if (errorLines.length > 0) {
                    const lastErr = errorLines[errorLines.length - 1].trim().slice(0, 200);
                    note(`Last error: ${lastErr}`);
                }
            } else {
                ok(`Last consolidation: ${last}`);
            }
        }
    }
} catch (_err) { /* no log yet on a fresh install */ }

// ─── 5. claude -p subprocess auth probe (cached, refreshed in background) ──
// Skip if `claude` is not on PATH (downstream user may not have Claude Code).
const claudePath = (() => {
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf-8' });
    return which.status === 0 ? which.stdout.trim().split('\n')[0] : null;
})();
if (claudePath) {
    const cached = readProbeCache();
    if (cached && cached.status === 'auth-broken') {
        fail(`claude -p subprocess auth broken — consolidation cannot run`);
        if (cached.detail) note(cached.detail);
        note('Fix: run `claude login`, or check ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / apiKeyHelper');
    } else if (cached && cached.status === 'timeout') {
        warn(`claude -p subprocess did not answer within ${PROBE_TIMEOUT_MS / 1000}s at the last check (network? rate limit?)`);
    } else if (cached && cached.status === 'error') {
        warn(`claude -p subprocess failed at the last check${cached.detail ? `: ${cached.detail}` : ''}`);
    }
    const stale = !cached
        || (cached.status === 'probing' ? cached.age > PROBE_PENDING_MS : cached.age > PROBE_MAX_AGE_MS);
    if (stale) {
        writeProbeCache({ status: 'probing', checkedAt: new Date().toISOString() });
        try {
            const env = { ...process.env };
            delete env[CHILD_ENV];
            const child = spawn(process.execPath, [__filename, '--probe'], { detached: true, stdio: 'ignore', env });
            child.unref();
        } catch (_err) { /* probing is best effort */ }
    }
}

// ─── Output ───────────────────────────────────────────────────────────
//
// IMPORTANT: Claude Code SessionStart hooks (v2 format) require JSON output
// wrapped in { hookSpecificOutput: { hookEventName: "SessionStart",
// additionalContext: "..." } } — plain text is silently discarded. We emit
// the same human-readable report two ways:
//   - JSON to stdout → Claude sees it as additionalContext
//   - identical text to stderr → visible if a human tails the hook
//
// This dual-channel pattern means broken consolidation reaches BOTH the
// agent and any human watching the logs — the entire point of P1.

const ts = new Date().toISOString();
const plural = (n) => (n === 1 ? '' : 's');

function emit(body, exitCode) {
    // Human-readable copy to stderr (for `tail -f` debugging by users).
    process.stderr.write(`${body}\n`);
    // JSON envelope to stdout (Claude Code consumes this as additionalContext).
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: body,
        },
    }));
    process.exit(exitCode);
}

if (fails > 0) {
    let body = `[neuromcp-health ${ts}] ❌ DEGRADED\n`;
    for (const l of lines) body += `${l}\n`;
    body += `\n⚠️  neuromcp DEGRADED (${fails} failure${plural(fails)}, ${warns} warning${plural(warns)}) — ` +
            `recall + auto-capture incomplete until fixed.`;
    emit(body, 2);
}

if (warns > 0) {
    let body = `[neuromcp-health ${ts}] ⚠️  ${warns} warning${plural(warns)}\n`;
    for (const l of lines) body += `${l}\n`;
    emit(body.trimEnd(), 1);
}

const healthyBody = `[neuromcp-health ${ts}] ✅ healthy ` +
    `(DB ${dbSizeMb}MB, wiki ${wikiAgeDays}d, ${pendingSessions} queued)`;
emit(healthyBody, 0);
