#!/usr/bin/env node
/**
 * neuromcp enable-daemon — install (or uninstall) the launchd agent that
 * runs `neuromcp-daemon` as a long-lived background process.
 *
 * Goal: a single neuromcp daemon serves ALL MCP-capable clients on this
 * Mac via HTTP Streamable transport on http://127.0.0.1:<PORT>/mcp.
 * No more "each client spawns its own stdio neuromcp instance" — no more
 * port conflicts, one shared DB, one embedding pipeline.
 *
 * Usage:
 *   npx neuromcp-enable-daemon                # install on default port 3200
 *   npx neuromcp-enable-daemon --port 33200   # custom port
 *   npx neuromcp-enable-daemon --dry-run      # preview, no side effects
 *   npx neuromcp-enable-daemon --uninstall    # remove launchd agent
 *
 * After install, point every MCP client at the daemon:
 *
 *   Claude Code (~/.claude.json mcpServers.neuromcp):
 *     { "type": "http", "url": "http://127.0.0.1:<PORT>/mcp" }
 *
 *   Claude Desktop (~/Library/Application Support/Claude/claude_desktop_config.json):
 *     stdio-only client — bridge via neuromcp-connect (waits for the daemon
 *     on cold boot, then hands off to mcp-remote):
 *     { "command": "npx", "args": ["-y", "--package=neuromcp", "neuromcp-connect", "http://127.0.0.1:<PORT>/mcp"] }
 *     (Desktop's MCP runtime does not yet accept the native "type":"http" shape.
 *      A bare mcp-remote bridge works too, but exits fatally on ECONNREFUSED
 *      when Desktop starts before the daemon has bound its port — see
 *      bin/neuromcp-connect.mjs for the boot-race details.)
 *
 * The script does NOT mutate any client configs — those are for the user
 * to update intentionally. It only installs the daemon plist + loads it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveStableNodeBin } from './resolve-node-bin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const NEUROMCP_DIR = join(HOME, '.neuromcp');
const REPO_ROOT = join(__dirname, '..');
const PLIST_TEMPLATE = join(REPO_ROOT, 'scripts', 'com.neuromcp.daemon.plist.template');
const PLIST_TARGET = join(HOME, 'Library', 'LaunchAgents', 'com.neuromcp.daemon.plist');
const DAEMON_ENTRY = join(REPO_ROOT, 'bin', 'neuromcp-daemon.mjs');
const SOURCE_DIST_DIR = join(REPO_ROOT, 'dist');
const SOURCE_NODE_MODULES = join(REPO_ROOT, 'node_modules');

// Patterns that indicate REPO_ROOT lives in a transient location whose
// contents can vanish without warning (npm cache eviction, OS cleanup
// of /tmp on reboot, etc.). The daemon's runtime depends on node_modules
// (native bindings, MCP SDK, etc.), so we cannot trivially copy the
// runtime to a stable path — we'd have to copy node_modules too, and
// some native modules (better-sqlite3, onnxruntime-node) are large and
// must match the runtime Node ABI. Safer: refuse and tell the user to
// install neuromcp at a stable location.
const TRANSIENT_INSTALL_MARKERS = [
  '/_npx/',          // npx package cache
  '/_cacache/',      // npm cache extraction
  '/npm-cache/',
  '/private/tmp/',   // macOS tmp
  '/var/folders/',   // macOS user tmp
  '/tmp/',
];

function isTransientInstall(rootPath) {
  for (const marker of TRANSIENT_INSTALL_MARKERS) {
    if (rootPath.includes(marker)) return marker;
  }
  return null;
}

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const dryRun = args.includes('--dry-run');
const portIdx = args.indexOf('--port');
const hostIdx = args.indexOf('--host');
const logLevelIdx = args.indexOf('--log-level');

const DEFAULT_PORT = 3200;
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_LOG_LEVEL = 'info';
const VALID_LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug']);

// Read the value immediately after a flag. Rejects if missing or if the
// "value" is actually another flag (e.g. `--port --dry-run` would
// previously silently fall through to the default port).
function readFlagValue(flag, idx) {
  const next = args[idx + 1];
  if (next === undefined || next.startsWith('--')) {
    console.error(`  x ${flag} requires a value (got: ${next ?? 'nothing'})`);
    process.exit(2);
  }
  return next;
}

function parsePort(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) {
    console.error(`  x --port must be an integer in [${MIN_PORT}, ${MAX_PORT}] (got: ${raw})`);
    process.exit(2);
  }
  return n;
}

// Mirror src/daemon.ts validateHost — the daemon refuses to start on
// non-loopback unless NEUROMCP_DAEMON_INSECURE_NON_LOOPBACK=1, so the
// installer must enforce the same contract or it will write a plist
// that launchd immediately fails and restart-loops.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
function parseHost(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    console.error(`  x --host must be a non-empty string`);
    process.exit(2);
  }
  const lower = raw.toLowerCase();
  if (!LOOPBACK_HOSTS.has(lower) && process.env.NEUROMCP_DAEMON_INSECURE_NON_LOOPBACK !== '1') {
    console.error(`  x --host "${raw}" is not a loopback address.`);
    console.error(`    The daemon is unauthenticated and trusts the loopback boundary.`);
    console.error(`    If you intentionally want a non-loopback bind (behind a reverse`);
    console.error(`    proxy with auth), set NEUROMCP_DAEMON_INSECURE_NON_LOOPBACK=1 and re-run.`);
    process.exit(2);
  }
  return raw;
}

function parseLogLevel(raw) {
  if (!VALID_LOG_LEVELS.has(raw)) {
    console.error(`  x --log-level must be one of: ${[...VALID_LOG_LEVELS].join(', ')} (got: ${raw})`);
    process.exit(2);
  }
  return raw;
}

const port = portIdx !== -1 ? parsePort(readFlagValue('--port', portIdx)) : DEFAULT_PORT;
const host = hostIdx !== -1 ? parseHost(readFlagValue('--host', hostIdx)) : DEFAULT_HOST;
const logLevel = logLevelIdx !== -1 ? parseLogLevel(readFlagValue('--log-level', logLevelIdx)) : DEFAULT_LOG_LEVEL;

// Collect extra env vars to forward into the launchd dict. Two sources:
//   1. Anything matching the user's shell env that the daemon cares about
//      (NEUROMCP_*, OLLAMA_HOST, OPENAI_API_KEY, ANTHROPIC_API_KEY) —
//      auto-detected so users do not silently lose their config.
//   2. Explicit `--env KEY=VALUE` flags (repeatable) for whatever else.
const AUTO_FORWARD_PREFIXES = ['NEUROMCP_'];
const AUTO_FORWARD_EXACT = new Set([
  'OLLAMA_HOST',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
]);
// Already explicitly set above; do not double-emit.
const SUPPRESS_KEYS = new Set([
  'NEUROMCP_DAEMON_PORT',
  'NEUROMCP_DAEMON_HOST',
  'NEUROMCP_LOG_LEVEL',
  // Test-only seam (stretches daemon init for boot-race tests). Forwarding
  // it would bake a permanent startup delay into every daemon boot.
  'NEUROMCP_TEST_INIT_DELAY_MS',
]);

const extraEnv = {};
for (const [k, v] of Object.entries(process.env)) {
  if (typeof v !== 'string' || v.length === 0) continue;
  if (SUPPRESS_KEYS.has(k)) continue;
  const matchesPrefix = AUTO_FORWARD_PREFIXES.some((p) => k.startsWith(p));
  if (matchesPrefix || AUTO_FORWARD_EXACT.has(k)) {
    extraEnv[k] = v;
  }
}

for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--env') continue;
  const raw = readFlagValue('--env', i);
  const eq = raw.indexOf('=');
  if (eq <= 0) {
    console.error(`  x --env expects KEY=VALUE (got: ${raw})`);
    process.exit(2);
  }
  const key = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  extraEnv[key] = value;
  i++;
}

function ok(msg) { console.log(`  ok ${msg}`); }
function warn(msg) { console.log(`  ! ${msg}`); }
function info(msg) { console.log(`  - ${msg}`); }
function fail(msg) { console.error(`  x ${msg}`); process.exit(1); }

function runSafe(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { encoding: 'utf8', ...opts });
}

function launchctlQuiet(subcmd, ...rest) {
  try {
    runSafe('launchctl', [subcmd, ...rest], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function getUid() { return runSafe('id', ['-u']).trim(); }

if (platform() !== 'darwin') {
  fail('enable-daemon currently only supports macOS launchd. On Linux use systemd manually.');
}

if (uninstall) {
  console.log('\nneuromcp enable-daemon (uninstall)\n');
  if (existsSync(PLIST_TARGET)) {
    if (dryRun) {
      info(`would bootout + remove ${PLIST_TARGET}`);
    } else {
      launchctlQuiet('bootout', `gui/${getUid()}/com.neuromcp.daemon`);
      unlinkSync(PLIST_TARGET);
      ok(`removed ${PLIST_TARGET}`);
    }
  } else {
    info('no plist installed; nothing to remove');
  }
  console.log('\ndone.\n');
  process.exit(0);
}

console.log('\nneuromcp enable-daemon (install)\n');

if (!existsSync(PLIST_TEMPLATE)) {
  fail(`plist template missing: ${PLIST_TEMPLATE}`);
}
if (!existsSync(DAEMON_ENTRY)) {
  fail(`daemon entry missing: ${DAEMON_ENTRY}`);
}
// Check the *specific* build artifacts the daemon entry imports, not
// just the dist/ dir. A stale checkout can have an old dist/ from
// before the daemon-mode entry was added; that would pass a naive
// existsSync(dist) but fail at runtime with module-not-found.
const REQUIRED_DIST_FILES = [
  join(SOURCE_DIST_DIR, 'daemon.js'),
  join(SOURCE_DIST_DIR, 'daemon-bootstrap.js'),
  join(SOURCE_DIST_DIR, 'daemon-core.js'),
  join(SOURCE_DIST_DIR, 'daemon-early-bind.js'),
  join(SOURCE_DIST_DIR, 'transport', 'mcp-http-daemon.js'),
];
for (const required of REQUIRED_DIST_FILES) {
  if (!existsSync(required)) {
    fail(`daemon build artifact missing: ${required} — run \`npm run build\` in this checkout, or install via \`npm i -g neuromcp@latest\` (built during postinstall).`);
  }
}
if (!existsSync(SOURCE_NODE_MODULES)) {
  fail(`daemon node_modules missing: ${SOURCE_NODE_MODULES} — the daemon needs runtime dependencies (MCP SDK, better-sqlite3 native binding, etc.). Run \`npm install\` in this checkout, or install neuromcp globally with \`npm i -g neuromcp\`.`);
}

// Refuse to register a launchd plist that points at a transient install
// root. The daemon's runtime depends on node_modules (including native
// bindings like better-sqlite3 and onnxruntime-node) which we cannot
// faithfully relocate without re-running npm install for the target
// Node ABI. Pointing launchd at a path that can vanish silently breaks
// the autostart contract.
const transientMarker = isTransientInstall(REPO_ROOT);
if (transientMarker !== null) {
  console.error('');
  console.error(`  x install root looks transient: contains "${transientMarker}"`);
  console.error(`    full path: ${REPO_ROOT}`);
  console.error('');
  console.error('    launchd needs a stable file path. A plist that points into an npx');
  console.error('    cache, /tmp, or /var/folders will break on cache eviction or reboot.');
  console.error('');
  console.error('    Fix: install neuromcp at a permanent location, then re-run this command.');
  console.error('      npm i -g neuromcp@latest');
  console.error('      neuromcp-enable-daemon          # now invokes the global install');
  console.error('');
  console.error('    To skip this check (you know what you are doing — paths must outlive');
  console.error('    this process), re-run with NEUROMCP_ALLOW_TRANSIENT_INSTALL=1.');
  if (process.env.NEUROMCP_ALLOW_TRANSIENT_INSTALL !== '1') {
    process.exit(1);
  }
  warn('NEUROMCP_ALLOW_TRANSIENT_INSTALL=1 — proceeding despite transient install root');
}

// process.execPath realpath-resolves to Homebrew's version-pinned Cellar
// path; bake the version-independent opt symlink instead so a
// `brew upgrade node@22` patch bump does not orphan the plist (see
// resolve-node-bin.mjs). Falls back to the original path off-Homebrew.
const nodeBin = resolveStableNodeBin(process.execPath);
const userPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';

// Minimal XML-escape for values that land inside <string>...</string>.
// launchctl will refuse the plist if any of these chars leak through raw,
// and developer machines occasionally have & or < in PATH (nvm/asdf shims
// in unusual layouts). Cheap insurance.
function xmlEscape(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// Secret-looking key names that should be redacted in any human-visible
// output (e.g. dry-run print). The plist itself still receives the real
// value so the daemon can actually use the key — only the printed copy
// is masked. Prevents accidental leaks via terminal scrollback / shared
// logs / pasted dry-run output.
function isSecretKey(key) {
  return /(_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|_API_KEY)$/i.test(key) || /API_KEY|TOKEN|SECRET|PASSWORD/i.test(key);
}

function maskValue(value) {
  if (typeof value !== 'string') return value;
  return `[REDACTED-${value.length}-chars]`;
}

// Render extra env block. Each key becomes a <key>...</key><string>...</string>
// pair inserted into the EnvironmentVariables <dict>. Empty when no extras.
let extraEnvBlock = '';
let extraEnvBlockDisplay = '';
for (const [k, v] of Object.entries(extraEnv)) {
  const realLine = `        <key>${xmlEscape(k)}</key>\n        <string>${xmlEscape(v)}</string>\n`;
  extraEnvBlock += realLine;
  const displayValue = isSecretKey(k) ? maskValue(v) : v;
  extraEnvBlockDisplay += `        <key>${xmlEscape(k)}</key>\n        <string>${xmlEscape(displayValue)}</string>\n`;
}

const template = readFileSync(PLIST_TEMPLATE, 'utf8');
function renderPlist(envBlock) {
  return template
    .replaceAll('{{NODE_BIN}}', xmlEscape(nodeBin))
    .replaceAll('{{DAEMON_ENTRY}}', xmlEscape(DAEMON_ENTRY))
    .replaceAll('{{PATH}}', xmlEscape(userPath))
    .replaceAll('{{HOME}}', xmlEscape(HOME))
    .replaceAll('{{PORT}}', xmlEscape(String(port)))
    .replaceAll('{{HOST}}', xmlEscape(host))
    .replaceAll('{{LOG_LEVEL}}', xmlEscape(logLevel))
    .replaceAll('{{EXTRA_ENV}}', envBlock);
}
const rendered = renderPlist(extraEnvBlock);
const renderedForDisplay = renderPlist(extraEnvBlockDisplay);

info(`node: ${nodeBin}`);
info(`daemon: ${DAEMON_ENTRY}`);
info(`port: ${port}`);
info(`host: ${host}`);
info(`log level: ${logLevel}`);
info(`plist target: ${PLIST_TARGET}`);
const extraEnvKeys = Object.keys(extraEnv);
if (extraEnvKeys.length > 0) {
  info(`extra env forwarded (${extraEnvKeys.length}): ${extraEnvKeys.join(', ')}`);
}

if (dryRun) {
  console.log('\n--- rendered plist (dry-run, secrets redacted) ---\n');
  console.log(renderedForDisplay);
  console.log('\n--- end ---\n');
  console.log('dry-run: no files written, launchctl not invoked.');
  console.log('note: secret-looking values (KEY/TOKEN/SECRET/PASSWORD) are masked in this output.');
  console.log('      the real plist (written when you re-run without --dry-run) contains the real values.\n');
  process.exit(0);
}

if (!existsSync(NEUROMCP_DIR)) {
  mkdirSync(NEUROMCP_DIR, { recursive: true });
  ok(`created ${NEUROMCP_DIR}`);
}

const launchAgentsDir = join(HOME, 'Library', 'LaunchAgents');
if (!existsSync(launchAgentsDir)) {
  mkdirSync(launchAgentsDir, { recursive: true });
  ok(`created ${launchAgentsDir}`);
}

// If a previous version is loaded, bootout first so the new plist replaces it.
launchctlQuiet('bootout', `gui/${getUid()}/com.neuromcp.daemon`);

// Owner-only permissions. The plist may carry secrets (OPENAI_API_KEY,
// ANTHROPIC_API_KEY, anything forwarded via --env) so leaving it
// world-readable would expose them to any local process. launchd is
// happy to load 0o600-owned plists from ~/Library/LaunchAgents.
//
// `writeFileSync({ mode })` only sets the mode at file creation. If the
// plist already exists with looser permissions (e.g. from an older
// install that used 0o644), `writeFileSync` overwrites the content but
// preserves the old mode bits. Explicit `chmodSync` after the write
// closes that hole.
writeFileSync(PLIST_TARGET, rendered, { mode: 0o600 });
chmodSync(PLIST_TARGET, 0o600);
ok(`wrote ${PLIST_TARGET} (chmod 0600)`);

try {
  runSafe('launchctl', ['bootstrap', `gui/${getUid()}`, PLIST_TARGET]);
  ok('launchctl bootstrap (loaded)');
} catch (err) {
  fail(`launchctl bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
}

try {
  runSafe('launchctl', ['kickstart', '-k', `gui/${getUid()}/com.neuromcp.daemon`]);
  ok('launchctl kickstart (started)');
} catch (err) {
  warn(`kickstart returned non-zero (daemon may still be coming up): ${err instanceof Error ? err.message : String(err)}`);
}

console.log('\nnext steps');
console.log(`  1. Verify: curl -s http://${host}:${port}/health`);
console.log(`  2. Update each MCP client to use http transport at http://${host}:${port}/mcp`);
console.log(`     - Claude Code (~/.claude.json):`);
console.log(`         "neuromcp": { "type": "http", "url": "http://${host}:${port}/mcp" }`);
console.log(`     - Claude Desktop (~/Library/Application Support/Claude/claude_desktop_config.json):`);
console.log(`         "neuromcp": { "command": "npx", "args": ["-y", "--package=neuromcp", "neuromcp-connect", "http://${host}:${port}/mcp"] }`);
console.log(`         (Desktop is stdio-only; neuromcp-connect waits for the daemon on cold`);
console.log(`          boot — plain mcp-remote exits fatally if Desktop starts first — then`);
console.log(`          bridges to the daemon over HTTP via mcp-remote.)`);
console.log(`  3. Restart each client.\n`);
