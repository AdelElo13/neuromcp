#!/usr/bin/env node
/**
 * neuromcp enable-zombie-cleanup — install the Claude desktop-app
 * zombie-session reaper.
 *
 * What this does (macOS only):
 *  1. Copies templates/scripts/cleanup-claude-zombies.sh to
 *     ~/.neuromcp/scripts/.
 *  2. Renders the launchd plist template with real paths + PATH + HOME
 *     and registers it with launchctl. Fires every INTERVAL seconds
 *     (default 300 = 5 min).
 *  3. Reaps "zombie" sessions (local_*.json metadata files with
 *     lifetime <30s AND age >1h) by moving them to .trash-zombies-*
 *     siblings. .trash dirs older than 7 days are garbage-collected.
 *
 * Why this exists: the Claude desktop app persists a local_*.json the
 * moment a new session is opened, before any user message exists. If
 * the user closes the window without typing, the metadata sticks
 * forever in the Recents sidebar. Tracked upstream at
 * https://github.com/anthropics/claude-code/issues/59134 — this agent
 * is the local workaround until the upstream fix ships.
 *
 * Prereqs (verified at runtime):
 *  - jq on PATH (used by the cleanup script to parse local_*.json)
 *
 * Usage:
 *   npx neuromcp-enable-zombie-cleanup                  # default 300s interval
 *   npx neuromcp-enable-zombie-cleanup --interval 600   # custom seconds
 *   npx neuromcp-enable-zombie-cleanup --dry-run        # preview, no side effects
 *   npx neuromcp-enable-zombie-cleanup --uninstall      # remove launchd agent
 */

import { existsSync, mkdirSync, copyFileSync, chmodSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const NEUROMCP_DIR = join(HOME, '.neuromcp');
const SCRIPTS_DIR = join(NEUROMCP_DIR, 'scripts');
const REPO_ROOT = join(__dirname, '..');
const SCRIPT_SOURCE = join(REPO_ROOT, 'templates', 'scripts', 'cleanup-claude-zombies.sh');
const PLIST_TEMPLATE = join(REPO_ROOT, 'scripts', 'com.neuromcp.zombie-cleanup.plist.template');
const PLIST_TARGET = join(HOME, 'Library', 'LaunchAgents', 'com.neuromcp.zombie-cleanup.plist');

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const dryRun = args.includes('--dry-run');
const intervalIdx = args.indexOf('--interval');
const DEFAULT_INTERVAL = 300;   // 5 min
const MIN_INTERVAL = 60;        // 1 min
const MAX_INTERVAL = 3600;      // 1 h

function parseInterval(raw) {
  if (raw === undefined) return DEFAULT_INTERVAL;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_INTERVAL || n > MAX_INTERVAL) {
    console.error(`  ✗ --interval must be an integer in [${MIN_INTERVAL}, ${MAX_INTERVAL}] seconds (got: ${raw})`);
    process.exit(2);
  }
  return n;
}
const intervalSeconds = intervalIdx !== -1 ? parseInterval(args[intervalIdx + 1]) : DEFAULT_INTERVAL;

function ok(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function info(msg) { console.log(`  · ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); process.exit(1); }

function runSafe(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { encoding: 'utf8', ...opts });
}

function which(bin) {
  try { return runSafe('/usr/bin/env', ['which', bin]).trim(); }
  catch { return null; }
}

function getUid() { return runSafe('id', ['-u']).trim(); }

function launchctl(subcmd, ...rest) {
  return runSafe('launchctl', [subcmd, ...rest], { stdio: 'inherit' });
}

function launchctlQuiet(subcmd, ...rest) {
  try { runSafe('launchctl', [subcmd, ...rest], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function uninstallAgent() {
  if (platform() !== 'darwin') { info('launchd only applies on macOS; nothing to uninstall.'); return; }
  if (!existsSync(PLIST_TARGET)) { info('No launchd plist installed.'); return; }
  const loaded = launchctlQuiet('bootout', `gui/${getUid()}`, PLIST_TARGET);
  if (loaded) ok('launchd agent unloaded'); else warn('agent was not loaded (ok)');
  unlinkSync(PLIST_TARGET);
  ok(`removed ${PLIST_TARGET}`);
}

if (uninstall) { uninstallAgent(); process.exit(0); }

// --- preflight ---
console.log('neuromcp zombie-cleanup install\n');

if (platform() !== 'darwin') {
  warn(`platform ${platform()} not supported — the Claude desktop app's session storage`);
  warn(`only exists on macOS. Exiting without changes.`);
  process.exit(0);
}

const jq = which('jq');
if (!jq) fail('`jq` not found on PATH. Install with: brew install jq');
ok(`jq: ${jq}`);

if (!existsSync(SCRIPT_SOURCE)) {
  fail(`missing script template: ${SCRIPT_SOURCE} (broken neuromcp install)`);
}

// --- dry-run ---
if (dryRun) {
  info('[DRY RUN] would copy script + render plist + launchctl bootstrap — no changes made.');
  info(`        SCRIPTS_DIR  = ${SCRIPTS_DIR}`);
  info(`        PLIST_TARGET = ${PLIST_TARGET}`);
  info(`        interval     = ${intervalSeconds}s`);
  process.exit(0);
}

// --- copy script into $HOME/.neuromcp/scripts/ ---
mkdirSync(SCRIPTS_DIR, { recursive: true });
const scriptTarget = join(SCRIPTS_DIR, 'cleanup-claude-zombies.sh');
copyFileSync(SCRIPT_SOURCE, scriptTarget);
chmodSync(scriptTarget, 0o755);
ok(`installed ${scriptTarget}`);

// --- render + register the launchd plist ---
const template = readFileSync(PLIST_TEMPLATE, 'utf8');
const pathEnv = process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
const rendered = template
  .replaceAll('{{SCRIPT_PATH}}', scriptTarget)
  .replaceAll('{{INTERVAL_SECONDS}}', String(intervalSeconds))
  .replaceAll('{{PATH}}', pathEnv)
  .replaceAll('{{HOME}}', HOME);
mkdirSync(dirname(PLIST_TARGET), { recursive: true });
writeFileSync(PLIST_TARGET, rendered);
ok(`wrote ${PLIST_TARGET}`);

const uid = getUid();
// bootstrap is not idempotent — clear any prior registration first.
launchctlQuiet('bootout', `gui/${uid}`, PLIST_TARGET);
try {
  launchctl('bootstrap', `gui/${uid}`, PLIST_TARGET);
  ok(`launchd agent loaded (fires every ${intervalSeconds}s)`);
} catch {
  warn('launchctl bootstrap failed — load manually with:');
  console.log(`    launchctl bootstrap gui/$(id -u) ${PLIST_TARGET}`);
}

console.log('\nDone. To test immediately:');
console.log(`  ${scriptTarget}`);
console.log(`Or kick launchd now:\n  launchctl kickstart gui/$(id -u)/com.neuromcp.zombie-cleanup`);
console.log(`\nLogs:\n  ~/.claude/logs/claude-zombie-cleanup.log`);
console.log(`  ~/.neuromcp/zombie-cleanup.{out,err}.log`);
console.log(`\nTo uninstall:\n  npx neuromcp-enable-zombie-cleanup --uninstall`);
