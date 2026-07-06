#!/usr/bin/env node
/**
 * neuromcp init — one-command setup that replaces the five manual steps:
 *
 *   1. Detect installed MCP clients (Claude Desktop, Claude Code, Cursor,
 *      Windsurf) — or target one explicitly via --client.
 *   2. Wire `"neuromcp": {"command":"npx","args":["-y","neuromcp"]}` into
 *      each client's MCP config. Merge-only: other servers and unrelated
 *      state are never touched, and the existing file is backed up to
 *      `<config>.bak-<date>` before every write.
 *   3. Initialize the wiki knowledge base (delegates to bin/init-wiki.mjs
 *      as a child process — least invasive reuse of the existing flow).
 *   4. Check Ollama + the nomic-embed-text embedding model and print
 *      advice when missing (ONNX fallback keeps working regardless).
 *   5. Print a summary + "restart your client(s)" instruction.
 *
 * Usage:
 *   npx neuromcp-init                          # auto-detect clients
 *   npx neuromcp-init --client cursor          # explicit client
 *   npx neuromcp-init --client all             # all known clients
 *   npx neuromcp-init --dry-run                # show what would be written
 *   npx neuromcp-init --yes                    # overwrite an existing neuromcp entry
 *
 * On problems: npx neuromcp-doctor
 */

import {
  existsSync as fsExistsSync,
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
  copyFileSync as fsCopyFileSync,
  mkdirSync as fsMkdirSync,
  renameSync as fsRenameSync,
  statSync as fsStatSync,
  chmodSync as fsChmodSync,
  lstatSync as fsLstatSync,
  unlinkSync as fsUnlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The stdio server entry written into every client config. */
export const NEUROMCP_SERVER_ENTRY = Object.freeze({
  command: 'npx',
  args: Object.freeze(['-y', 'neuromcp']),
});

export const KNOWN_CLIENTS = Object.freeze(['claude-desktop', 'claude-code', 'cursor', 'windsurf']);

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const OLLAMA_TIMEOUT_MS = 2_000;
const EMBED_MODEL = 'nomic-embed-text';

/**
 * @typedef {{ client: string | null, dryRun: boolean, yes: boolean }} InitArgs
 */

/**
 * Parse the CLI arguments for `neuromcp init`.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {InitArgs}
 */
export function parseInitArgs(argv) {
  let client = null;
  let dryRun = false;
  let yes = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--client') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--client requires a value: one of ${[...KNOWN_CLIENTS, 'all'].join(', ')}`);
      }
      if (!KNOWN_CLIENTS.includes(value) && value !== 'all') {
        throw new Error(`unknown --client "${value}" — expected one of ${[...KNOWN_CLIENTS, 'all'].join(', ')}`);
      }
      client = value;
      i++;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--help' || arg === '-h') {
      client = 'help';
    } else {
      throw new Error(`unknown flag: ${arg} (use --client, --dry-run, --yes)`);
    }
  }

  return { client, dryRun, yes };
}

/**
 * @typedef {{ home: string, plat: string, env: Record<string, string | undefined> }} HostContext
 */

/**
 * Resolve the MCP config path for a known client on a given platform.
 *
 * @param {string} clientId - one of KNOWN_CLIENTS
 * @param {HostContext} ctx
 * @returns {string} absolute config path
 */
export function getClientConfigPath(clientId, ctx) {
  const { home, plat, env } = ctx;
  switch (clientId) {
    case 'claude-desktop': {
      if (plat === 'darwin') {
        return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      }
      if (plat === 'win32') {
        const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
        return join(appData, 'Claude', 'claude_desktop_config.json');
      }
      return join(home, '.config', 'Claude', 'claude_desktop_config.json');
    }
    case 'claude-code':
      return join(home, '.claude.json');
    case 'cursor':
      return join(home, '.cursor', 'mcp.json');
    case 'windsurf':
      return join(home, '.codeium', 'windsurf', 'mcp_config.json');
    default:
      throw new Error(`unknown client: ${clientId}`);
  }
}

/**
 * Detect which client configs exist on this machine.
 *
 * @param {HostContext} ctx
 * @param {{ existsSync?: (p: string) => boolean }} [deps]
 * @returns {Array<{ id: string, configPath: string, exists: boolean }>}
 */
export function detectClients(ctx, deps = {}) {
  const { existsSync = fsExistsSync } = deps;
  return KNOWN_CLIENTS.map((id) => {
    const configPath = getClientConfigPath(id, ctx);
    return { id, configPath, exists: existsSync(configPath) };
  });
}

/**
 * Turn the --client flag (or null for auto-detect) into the list of
 * configuration targets.
 *
 * Auto-detect only touches clients whose config file already exists;
 * an explicit --client (or "all") creates a missing config from scratch.
 *
 * @param {string | null} clientFlag
 * @param {HostContext} ctx
 * @param {{ existsSync?: (p: string) => boolean }} [deps]
 * @returns {Array<{ id: string, configPath: string, createIfMissing: boolean }>}
 */
export function resolveTargets(clientFlag, ctx, deps = {}) {
  const detected = detectClients(ctx, deps);
  if (clientFlag === null) {
    return detected
      .filter((c) => c.exists)
      .map(({ id, configPath }) => ({ id, configPath, createIfMissing: false }));
  }
  const wanted = clientFlag === 'all' ? [...KNOWN_CLIENTS] : [clientFlag];
  return detected
    .filter((c) => wanted.includes(c.id))
    .map(({ id, configPath }) => ({ id, configPath, createIfMissing: true }));
}

/**
 * Format a config-file backup path: `<config>.bak-<ISO date>`.
 *
 * @param {string} configPath
 * @param {() => Date} [now]
 * @returns {string}
 */
export function buildBackupPath(configPath, now = () => new Date()) {
  return `${configPath}.bak-${now().toISOString().slice(0, 10)}`;
}

/**
 * Deep-clone-free structural equality for plain JSON values.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Merge the neuromcp server entry into an existing config document
 * without mutating anything else. Pure: takes text, returns the next
 * document; never touches the filesystem.
 *
 * @param {string} rawText - the current config file content
 * @param {{ command: string, args: readonly string[] }} entry
 * @param {{ yes: boolean }} opts - overwrite an existing (different) entry?
 * @returns {{ changed: boolean, reason: 'added' | 'updated' | 'already-configured', next: Record<string, unknown> }}
 * @throws {Error} on invalid JSON or a non-object root — the caller must
 *   surface this WITHOUT writing, so a corrupt file is never destroyed.
 */
export function mergeNeuromcpEntry(rawText, entry, opts) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config root is not a JSON object — refusing to rewrite it');
  }

  const servers = parsed.mcpServers;
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    throw new Error('config "mcpServers" is not a JSON object — refusing to rewrite it');
  }

  const plainEntry = JSON.parse(JSON.stringify(entry));
  const existing = servers ? servers.neuromcp : undefined;

  if (existing !== undefined) {
    if (!opts.yes || jsonEqual(existing, plainEntry)) {
      return { changed: false, reason: 'already-configured', next: parsed };
    }
    const next = { ...parsed, mcpServers: { ...servers, neuromcp: plainEntry } };
    return { changed: true, reason: 'updated', next };
  }

  const next = { ...parsed, mcpServers: { ...(servers ?? {}), neuromcp: plainEntry } };
  return { changed: true, reason: 'added', next };
}

/** Owner-only permissions for configs we create — they may end up holding secrets. */
const NEW_CONFIG_MODE = 0o600;

/**
 * Is there a symlink at `path`? Uses lstat (never follows the link), and
 * treats "nothing there at all" as not-a-symlink. existsSync is NOT
 * enough here: it follows links, so a dangling symlink looks like a
 * missing file while a write through it would land at the link target.
 *
 * @param {string} path
 * @param {(p: string) => { isSymbolicLink: () => boolean }} lstatSync
 * @returns {boolean}
 */
function isSymlinkAt(path, lstatSync) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Write a config file atomically with an explicit mode. The content goes
 * to a same-directory temp file first (same filesystem → atomic rename),
 * then replaces the target in a single renameSync — a kill mid-write can
 * never leave a truncated config behind. The temp file is created
 * exclusively ('wx') and chmod'ed to `mode` before the rename, so a
 * restrictive mode (e.g. 0o600 on a config holding other MCP servers'
 * secrets) survives the rewrite instead of falling back to 0o644.
 *
 * @param {string} configPath
 * @param {string} data
 * @param {number} mode
 * @param {{
 *   writeFileSync: (p: string, data: string, opts?: { mode?: number, flag?: string }) => void,
 *   renameSync: (from: string, to: string) => void,
 *   chmodSync: (p: string, mode: number) => void,
 *   unlinkSync: (p: string) => void,
 * }} fsOps
 */
function writeConfigAtomic(configPath, data, mode, fsOps) {
  const tmpPath = `${configPath}.tmp-${process.pid}`;
  fsOps.writeFileSync(tmpPath, data, { mode, flag: 'wx' });
  try {
    fsOps.chmodSync(tmpPath, mode);
    fsOps.renameSync(tmpPath, configPath);
  } catch (err) {
    try {
      fsOps.unlinkSync(tmpPath);
    } catch {
      // best effort — the rename/chmod error below is the real story
    }
    throw err;
  }
}

/**
 * @typedef {Object} ConfigureResult
 * @property {string} id
 * @property {string} configPath
 * @property {'added' | 'updated' | 'created' | 'already-configured' | 'skipped-missing' | 'invalid-json'
 *   | 'refused-symlink' | 'would-add' | 'would-update' | 'would-create'} status
 * @property {string} [backupPath] - set when a backup was (or would be) written
 * @property {string} [message] - human-readable detail (errors)
 * @property {string} [nextContent] - the exact content that was / would be written
 */

/**
 * Configure a single client's MCP config file. All fs boundaries are
 * injectable so tests never touch the real home configs.
 *
 * @param {{ id: string, configPath: string, yes: boolean, dryRun: boolean, createIfMissing: boolean }} options
 * @param {{
 *   existsSync?: (p: string) => boolean,
 *   readFileSync?: (p: string, enc: 'utf8') => string,
 *   writeFileSync?: (p: string, data: string, opts?: { mode?: number, flag?: string }) => void,
 *   copyFileSync?: (src: string, dest: string) => void,
 *   mkdirSync?: (p: string, opts: { recursive: boolean }) => void,
 *   renameSync?: (from: string, to: string) => void,
 *   statSync?: (p: string) => { mode: number },
 *   chmodSync?: (p: string, mode: number) => void,
 *   lstatSync?: (p: string) => { isSymbolicLink: () => boolean },
 *   unlinkSync?: (p: string) => void,
 *   now?: () => Date,
 * }} [deps]
 * @returns {ConfigureResult}
 */
export function configureClient(options, deps = {}) {
  const { id, configPath, yes, dryRun, createIfMissing } = options;
  const {
    existsSync = fsExistsSync,
    readFileSync = fsReadFileSync,
    writeFileSync = fsWriteFileSync,
    copyFileSync = fsCopyFileSync,
    mkdirSync = fsMkdirSync,
    renameSync = fsRenameSync,
    statSync = fsStatSync,
    chmodSync = fsChmodSync,
    lstatSync = fsLstatSync,
    unlinkSync = fsUnlinkSync,
    now = () => new Date(),
  } = deps;
  const fsOps = { writeFileSync, renameSync, chmodSync, unlinkSync };

  // Refuse symlinked config paths outright (also in dry-run, so the
  // preview matches the real run): the atomic rename below would
  // silently replace the link with a regular file, and writing through
  // a (possibly dangling) link would modify whatever it points at.
  if (isSymlinkAt(configPath, lstatSync)) {
    return {
      id,
      configPath,
      status: 'refused-symlink',
      message: `${configPath} is a symlink — refusing to modify it. Edit the link target directly, or replace the link with a regular file and re-run.`,
    };
  }

  if (!existsSync(configPath)) {
    if (!createIfMissing) {
      return { id, configPath, status: 'skipped-missing' };
    }
    const fresh = { mcpServers: { neuromcp: JSON.parse(JSON.stringify(NEUROMCP_SERVER_ENTRY)) } };
    const nextContent = JSON.stringify(fresh, null, 2) + '\n';
    if (dryRun) {
      return { id, configPath, status: 'would-create', nextContent };
    }
    mkdirSync(dirname(configPath), { recursive: true });
    writeConfigAtomic(configPath, nextContent, NEW_CONFIG_MODE, fsOps);
    return { id, configPath, status: 'created', nextContent };
  }

  let merge;
  try {
    merge = mergeNeuromcpEntry(readFileSync(configPath, 'utf8'), NEUROMCP_SERVER_ENTRY, { yes });
  } catch (err) {
    return {
      id,
      configPath,
      status: 'invalid-json',
      message: `${configPath}: ${err instanceof Error ? err.message : String(err)} — file left untouched. Fix it manually, then re-run.`,
    };
  }

  if (!merge.changed) {
    return { id, configPath, status: 'already-configured' };
  }

  const nextContent = JSON.stringify(merge.next, null, 2) + '\n';
  const backupPath = buildBackupPath(configPath, now);

  if (dryRun) {
    const status = merge.reason === 'updated' ? 'would-update' : 'would-add';
    return { id, configPath, status, backupPath, nextContent };
  }

  // Preserve the existing file mode: ~/.claude.json and friends may be
  // 0o600 because other MCP servers keep secrets in them. Fall back to
  // owner-only if the mode cannot be read.
  let mode = NEW_CONFIG_MODE;
  try {
    mode = statSync(configPath).mode & 0o777;
  } catch {
    // keep the restrictive default
  }

  // Backup BEFORE the write. If a backup for today already exists, keep
  // it — it holds the oldest (safest) pre-init state of the day.
  if (!existsSync(backupPath)) {
    copyFileSync(configPath, backupPath);
  }
  writeConfigAtomic(configPath, nextContent, mode, fsOps);
  const status = merge.reason === 'updated' ? 'updated' : 'added';
  return { id, configPath, status, backupPath, nextContent };
}

/**
 * Probe the local Ollama instance and check for the embedding model.
 * Never throws and never blocks longer than the timeout — Ollama is
 * optional (ONNX fallback), so this is advisory only.
 *
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 * }} [deps]
 * @returns {Promise<{ reachable: boolean, hasModel: boolean }>}
 */
export async function checkOllama(deps = {}) {
  const { fetchImpl = fetch, baseUrl = OLLAMA_BASE_URL, timeoutMs = OLLAMA_TIMEOUT_MS } = deps;
  try {
    const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { reachable: false, hasModel: false };
    const data = await res.json();
    const models = Array.isArray(data?.models) ? data.models : [];
    const hasModel = models.some(
      (m) => typeof m?.name === 'string' && m.name.split(':')[0] === EMBED_MODEL,
    );
    return { reachable: true, hasModel };
  } catch {
    return { reachable: false, hasModel: false };
  }
}

/** Delegate wiki initialization to the existing flow (child process). */
function defaultRunWikiInit() {
  execFileSync(process.execPath, [join(__dirname, 'init-wiki.mjs')], { stdio: 'inherit' });
}

function printHelp() {
  process.stdout.write(`
neuromcp init — one-command setup for all MCP clients

Usage:
  neuromcp-init [--client <name>] [--dry-run] [--yes]

Options:
  --client <name>   ${[...KNOWN_CLIENTS, 'all'].join(' | ')}
                    (default: auto-detect existing configs)
  --dry-run         show exactly what would be written; write nothing
  --yes, -y         overwrite an existing neuromcp entry
  --help, -h        this message

On problems: npx neuromcp-doctor
`);
}

async function main() {
  let parsed;
  try {
    parsed = parseInitArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`neuromcp init: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (parsed.client === 'help') {
    printHelp();
    process.exit(0);
  }
  const { client, dryRun, yes } = parsed;

  const HOME = homedir();
  const shorten = (p) => p.replace(HOME, '~');
  const ctx = { home: HOME, plat: platform(), env: process.env };

  console.log(`\n🧠 neuromcp init${dryRun ? ' (dry-run — nothing will be written)' : ''}\n`);

  // ── 1+2. Client detection + config wiring ───────────────────────────
  const targets = resolveTargets(client, ctx);
  if (targets.length === 0) {
    console.log('  ⚠ No MCP client configs detected (Claude Desktop, Claude Code, Cursor, Windsurf).');
    console.log('    Use --client <name|all> to create one explicitly.\n');
  }

  const entryJson = JSON.stringify(NEUROMCP_SERVER_ENTRY);
  let failures = 0;
  const results = [];
  for (const target of targets) {
    const res = configureClient({ ...target, yes, dryRun });
    results.push(res);
    switch (res.status) {
      case 'added':
      case 'updated':
        console.log(`  ✓ ${res.id}: ${res.status} neuromcp entry in ${shorten(res.configPath)}`);
        console.log(`      backup: ${shorten(res.backupPath)}`);
        break;
      case 'created':
        console.log(`  ✓ ${res.id}: created ${shorten(res.configPath)} with the neuromcp entry`);
        break;
      case 'already-configured':
        console.log(`  · ${res.id}: already configured in ${shorten(res.configPath)}${yes ? '' : ' (use --yes to overwrite)'}`);
        break;
      case 'skipped-missing':
        console.log(`  · ${res.id}: no config at ${shorten(res.configPath)} — skipped`);
        break;
      case 'invalid-json':
      case 'refused-symlink':
        failures++;
        console.error(`  ✗ ${res.id}: ${res.message}`);
        break;
      case 'would-add':
      case 'would-update':
        console.log(`  → ${res.id}: would write ${shorten(res.configPath)}`);
        console.log(`      would back up current file to ${shorten(res.backupPath)}`);
        console.log(`      would set mcpServers.neuromcp = ${entryJson}`);
        break;
      case 'would-create':
        console.log(`  → ${res.id}: would create ${shorten(res.configPath)} with content:`);
        console.log(res.nextContent.replace(/^/gm, '      '));
        break;
    }
  }

  // ── 3. Wiki init ─────────────────────────────────────────────────────
  console.log('');
  if (dryRun) {
    console.log(`  → would run: node ${shorten(join(__dirname, 'init-wiki.mjs'))} (wiki knowledge base setup)`);
  } else {
    try {
      defaultRunWikiInit();
    } catch (err) {
      failures++;
      console.error(`  ✗ wiki init failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error('    Run it manually later: npx neuromcp-init-wiki');
    }
  }

  // ── 4. Ollama advice ─────────────────────────────────────────────────
  const ollama = await checkOllama();
  console.log('');
  if (!ollama.reachable) {
    console.log('  ⚠ Ollama not reachable at http://127.0.0.1:11434.');
    console.log('    For best embedding quality install Ollama (https://ollama.com), then:');
    console.log(`      ollama pull ${EMBED_MODEL}`);
    console.log('    Without it, neuromcp falls back to the bundled ONNX embedding model — everything keeps working.');
  } else if (!ollama.hasModel) {
    console.log(`  ⚠ Ollama is running but the "${EMBED_MODEL}" embedding model is missing. Pull it with:`);
    console.log(`      ollama pull ${EMBED_MODEL}`);
    console.log('    Until then, neuromcp falls back to the bundled ONNX embedding model — everything keeps working.');
  } else {
    console.log(`  ✓ Ollama reachable with ${EMBED_MODEL} — embeddings ready.`);
  }

  // ── 5. Summary ───────────────────────────────────────────────────────
  const touched = results.filter((r) => ['added', 'updated', 'created'].includes(r.status));
  const would = results.filter((r) => r.status.startsWith('would-'));
  console.log('');
  if (dryRun) {
    console.log(`✅ Dry-run complete — ${would.length} config(s) would change, nothing was written.`);
  } else {
    console.log(`✅ neuromcp init complete — ${touched.length} config(s) updated.`);
    if (touched.length > 0 || results.some((r) => r.status === 'already-configured')) {
      console.log('   Restart your client(s) (Claude Desktop / Claude Code / Cursor / Windsurf) to pick up the config.');
    }
  }
  console.log('   Problems? Run: npx neuromcp-doctor\n');

  process.exit(failures > 0 ? 1 : 0);
}

// Direct-invocation guard: run main() only when this file is the
// entrypoint, so tests can import the pure helpers without side effects.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
