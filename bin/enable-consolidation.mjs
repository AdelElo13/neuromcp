#!/usr/bin/env node
/**
 * neuromcp enable-consolidation — install the auto-consolidation pipeline.
 *
 * What this does:
 *  1. Copies scripts/consolidate-sessions.py + run-consolidation.sh to ~/.neuromcp/scripts/
 *  2. (macOS) Renders the launchd plist template with real paths + PATH + HOME
 *     and registers it with launchctl so it fires every 4h by default.
 *  3. (Linux) Prints a cron snippet the user can add manually.
 *
 * Prereqs (verified at runtime):
 *  - python3 on PATH
 *  - `claude` CLI on PATH (Claude Code)
 *
 * Usage:
 *   npx neuromcp-enable-consolidation                     # default 4h interval
 *   npx neuromcp-enable-consolidation --interval 14400    # custom seconds
 *   npx neuromcp-enable-consolidation --uninstall         # remove launchd agent
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
const REPO_SCRIPTS = join(__dirname, '..', 'scripts');
const PLIST_TEMPLATE = join(REPO_SCRIPTS, 'com.neuromcp.consolidate.plist.template');
const PLIST_TARGET = join(HOME, 'Library', 'LaunchAgents', 'com.neuromcp.consolidate.plist');

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const intervalIdx = args.indexOf('--interval');
const DEFAULT_INTERVAL = 14400;   // 4h
const MIN_INTERVAL = 300;         // 5 min — below this the audit cost stops being sensible
const MAX_INTERVAL = 86400;       // 24h

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
  // execFileSync with a fixed argv list — no shell, no injection.
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
console.log('neuromcp consolidation install\n');
const python = which('python3');
if (!python) fail('python3 not found on PATH. Install Python 3.8+ first.');
ok(`python3: ${python}`);

const claude = which('claude');
if (!claude) fail('`claude` CLI not found. Install Claude Code: https://claude.com/claude-code');
ok(`claude CLI: ${claude}`);

// --- copy scripts into $HOME/.neuromcp/scripts/ ---
// index-wiki.mjs is NOT copied here — it needs its sibling node_modules
// (better-sqlite3, sqlite-vec) which only exist inside the neuromcp package.
// The consolidator triggers it via `npx neuromcp-index-wiki` instead.
mkdirSync(SCRIPTS_DIR, { recursive: true });
for (const name of ['consolidate-sessions.py', 'run-consolidation.sh']) {
  const src = join(REPO_SCRIPTS, name);
  const dst = join(SCRIPTS_DIR, name);
  if (!existsSync(src)) fail(`missing source: ${src}`);
  copyFileSync(src, dst);
  chmodSync(dst, 0o755);
  ok(`installed ${dst}`);
}

// --- platform-specific scheduling ---
if (platform() === 'darwin') {
  const template = readFileSync(PLIST_TEMPLATE, 'utf8');
  // Inherit the caller's PATH so `claude` and `python3` resolve under launchd.
  const pathEnv = process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
  const rendered = template
    .replaceAll('{{SCRIPT_PATH}}', join(SCRIPTS_DIR, 'run-consolidation.sh'))
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
    ok(`launchd agent loaded (fires every ${intervalSeconds}s, ~${Math.round(intervalSeconds / 3600)}h)`);
  } catch {
    warn('launchctl bootstrap failed — load manually with:');
    console.log(`    launchctl bootstrap gui/$(id -u) ${PLIST_TARGET}`);
  }
} else if (platform() === 'linux') {
  const hours = Math.max(1, Math.floor(intervalSeconds / 3600));
  const script = join(SCRIPTS_DIR, 'run-consolidation.sh');
  // cron runs with a bare environment; bake in PATH + HOME so python3,
  // node, claude, and npx resolve the same way they do in the user's shell.
  const pathEnv = process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
  info('Linux detected — no launchd. Add this to your crontab (env vars + script):');
  console.log(`    PATH=${pathEnv}`);
  console.log(`    HOME=${HOME}`);
  console.log(`    0 */${hours} * * * ${script}`);
} else {
  warn(`platform ${platform()} not supported for auto-scheduling; run the script manually.`);
}

console.log('\nDone. To test immediately:');
console.log(`  ${join(SCRIPTS_DIR, 'run-consolidation.sh')}`);
if (platform() === 'darwin') {
  console.log(`Or kick launchd now:\n  launchctl kickstart gui/$(id -u)/com.neuromcp.consolidate`);
}
