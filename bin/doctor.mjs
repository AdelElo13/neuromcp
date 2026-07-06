#!/usr/bin/env node
/**
 * neuromcp-doctor — diagnostic CLI that triages the install: proves the
 * runtime is healthy, probes the real failure modes (daemon down, Ollama
 * missing, no embedding route, unreadable db), AND that no surprise
 * outbound network calls happen during normal operation.
 *
 * Subcommands (use `--help` for the list):
 *   check            env + dep + daemon + embeddings + db triage (default)
 *   audit-network    Wraps the neuromcp server in an outgoing-call snitch
 *                    for 30 seconds and reports any non-loopback connections.
 *
 * Exit codes for `check` (CI-friendly):
 *   0  everything healthy
 *   1  warnings only (e.g. no Ollama but the ONNX fallback is present)
 *   2  broken (db unreadable, no embedding route at all, dist missing, …)
 *
 * All checks are pure, dependency-injected helpers (fetch/fs/module-loader
 * injectable) exported for tests — same pattern as bin/neuromcp-connect.mjs.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, platform } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const DEFAULT_DAEMON_PORT = 3200;
const PROBE_TIMEOUT_MS = 2_000;
const LAUNCHD_LABEL = 'com.neuromcp.daemon';
// Where scripts/download-model.mjs writes the offline fallback model.
const ONNX_MODEL_PATH = resolve(REPO_ROOT, 'models', 'bge-small-en-v1.5.onnx');

/**
 * @typedef {{ name: string, status: 'ok'|'warn'|'fail'|'skip', info: string }} CheckResult
 */

/**
 * @param {Record<string, string | undefined>} env
 * @returns {number} daemon port from NEUROMCP_DAEMON_PORT, default 3200
 */
export function resolveDaemonPort(env) {
  const raw = env.NEUROMCP_DAEMON_PORT;
  if (raw === undefined) return DEFAULT_DAEMON_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_DAEMON_PORT;
  return n;
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
function defaultFetch(url, init) {
  return fetch(url, init);
}

/**
 * Probe the shared daemon's /health endpoint.
 *
 * @param {{
 *   fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
 *   env?: Record<string, string | undefined>,
 *   osPlatform?: string,
 * }} [deps]
 * @returns {Promise<CheckResult>}
 */
export async function checkDaemon(deps = {}) {
  const {
    fetchImpl = defaultFetch,
    env = process.env,
    osPlatform = platform(),
  } = deps;
  const name = 'daemon health';
  const port = resolveDaemonPort(env);
  const url = `http://127.0.0.1:${port}/health`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res.ok) {
      let version = 'unknown';
      try {
        const body = /** @type {{ version?: unknown }} */ (await res.json());
        if (body && typeof body === 'object' && typeof body.version === 'string') {
          version = body.version;
        }
      } catch {
        // Non-JSON /health body — still healthy, just no version to show.
      }
      return { name, status: 'ok', info: `v${version} responding at ${url}` };
    }
    return daemonDownResult(name, url, `HTTP ${res.status}`, osPlatform);
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError'
      ? `timeout after ${PROBE_TIMEOUT_MS}ms`
      : err instanceof Error ? err.message : String(err);
    return daemonDownResult(name, url, reason, osPlatform);
  }
}

/**
 * @param {string} name
 * @param {string} url
 * @param {string} reason
 * @param {string} osPlatform
 * @returns {CheckResult}
 */
function daemonDownResult(name, url, reason, osPlatform) {
  const hint = osPlatform === 'darwin'
    ? ` — inspect with \`launchctl print gui/$(id -u)/${LAUNCHD_LABEL}\``
    : '';
  return {
    name,
    status: 'warn',
    info: `not reachable at ${url} (${reason}). Daemon mode is optional; ` +
      `stdio mode works without it${hint}`,
  };
}

/**
 * Probe Ollama and confirm the nomic-embed-text embedding model is pulled.
 *
 * @param {{
 *   fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
 *   env?: Record<string, string | undefined>,
 * }} [deps]
 * @returns {Promise<CheckResult>}
 */
export async function checkOllama(deps = {}) {
  const { fetchImpl = defaultFetch, env = process.env } = deps;
  const name = 'ollama embeddings';
  const host = env.OLLAMA_HOST ?? 'http://localhost:11434';
  const url = `${host.replace(/\/$/, '')}/api/tags`;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) {
      return ollamaDownResult(name, host, `HTTP ${res.status}`);
    }
    const body = /** @type {{ models?: Array<{ name?: unknown }> }} */ (await res.json());
    const models = Array.isArray(body?.models) ? body.models : [];
    const hasNomic = models.some(
      (m) => typeof m?.name === 'string' && m.name.split(':')[0] === 'nomic-embed-text',
    );
    if (hasNomic) {
      return { name, status: 'ok', info: `nomic-embed-text (768d) available at ${host}` };
    }
    return {
      name,
      status: 'warn',
      info: `Ollama runs at ${host} but nomic-embed-text is not pulled — ` +
        `retrieval falls back to ONNX 384d (lower quality). ` +
        `Fix: \`ollama pull nomic-embed-text\``,
    };
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError'
      ? `timeout after ${PROBE_TIMEOUT_MS}ms`
      : err instanceof Error ? err.message : String(err);
    return ollamaDownResult(name, host, reason);
  }
}

/**
 * @param {string} name
 * @param {string} host
 * @param {string} reason
 * @returns {CheckResult}
 */
function ollamaDownResult(name, host, reason) {
  return {
    name,
    status: 'warn',
    info: `not reachable at ${host} (${reason}) — retrieval falls back to ` +
      `ONNX 384d (lower quality). Install Ollama, then \`ollama pull nomic-embed-text\``,
  };
}

/**
 * Check the offline ONNX fallback model that scripts/download-model.mjs
 * installs into <repo>/models/.
 *
 * @param {{ exists?: (p: string) => boolean, modelPath?: string }} [deps]
 * @returns {CheckResult}
 */
export function checkOnnxModel(deps = {}) {
  const { exists = existsSync, modelPath = ONNX_MODEL_PATH } = deps;
  const name = 'onnx fallback model';
  if (exists(modelPath)) {
    return { name, status: 'ok', info: modelPath };
  }
  return {
    name,
    status: 'warn',
    info: `missing at ${modelPath} — no offline embedding fallback. ` +
      `Fix: \`node scripts/download-model.mjs\``,
  };
}

/**
 * Actually load better-sqlite3 (native binding included) instead of
 * guessing from a node_modules path — hoisted npm installs made the old
 * path check report false negatives.
 *
 * @param {{ loadModule?: () => Promise<{ default: unknown }> }} [deps]
 * @returns {Promise<{ result: CheckResult, Database: (new (path: string, opts?: object) => { pragma: (s: string) => unknown, close: () => void }) | null }>}
 */
export async function checkBetterSqlite(deps = {}) {
  const { loadModule = () => import(defaultResolveSqlite()) } = deps;
  const name = 'better-sqlite3 native';
  try {
    const mod = await loadModule();
    const Database = mod.default ?? mod;
    return {
      result: { name, status: 'ok', info: 'module + native binding load' },
      Database: /** @type {never} */ (Database),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      result: {
        name,
        status: 'fail',
        info: `cannot load (${msg.split('\n')[0]}) — run \`npm rebuild better-sqlite3\``,
      },
      Database: null,
    };
  }
}

function defaultResolveSqlite() {
  // Resolve relative to this file so global installs, hoisted deps, and the
  // repo checkout all work — import('better-sqlite3') from bin/ follows the
  // normal node_modules chain upward.
  const require = createRequire(import.meta.url);
  return pathToFileURL(require.resolve('better-sqlite3')).href;
}

/**
 * Open the memory db read-only and run a quick integrity check.
 * Skips with a clear message when better-sqlite3 itself did not load.
 *
 * @param {{
 *   Database: (new (path: string, opts?: object) => { pragma: (s: string) => unknown, close: () => void }) | null,
 *   env?: Record<string, string | undefined>,
 *   exists?: (p: string) => boolean,
 *   home?: string,
 * }} deps
 * @returns {CheckResult}
 */
export function checkDatabase(deps) {
  const {
    Database,
    env = process.env,
    exists = existsSync,
    home = homedir(),
  } = deps;
  const name = 'memory db';
  const dbPath = env.NEUROMCP_DB_PATH ?? resolve(home, '.neuromcp', 'memory.db');

  if (Database === null) {
    return { name, status: 'skip', info: `skipped — better-sqlite3 did not load, cannot open ${dbPath}` };
  }
  if (!exists(dbPath)) {
    return { name, status: 'ok', info: `${dbPath} not created yet — will be created on first run` };
  }

  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.pragma('quick_check');
    const verdict = Array.isArray(rows) && rows.length > 0
      ? Object.values(rows[0])[0]
      : rows;
    if (verdict !== 'ok') {
      return { name, status: 'fail', info: `${dbPath} failed quick_check: ${String(verdict)}` };
    }
    return { name, status: 'ok', info: `${dbPath} opens read-only, quick_check ok` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: 'fail', info: `${dbPath} cannot be opened: ${msg}` };
  } finally {
    try {
      db?.close();
    } catch {
      // Read-only handle; close failure changes nothing about the verdict.
    }
  }
}

/**
 * At least one embedding route (Ollama 768d or ONNX 384d fallback) must
 * exist, otherwise store/search are dead — that is broken, not a warning.
 *
 * @param {Pick<CheckResult, 'status'>} ollamaResult
 * @param {Pick<CheckResult, 'status'>} onnxResult
 * @returns {CheckResult}
 */
export function deriveEmbeddingRoute(ollamaResult, onnxResult) {
  const name = 'embedding route';
  if (ollamaResult.status === 'ok') {
    const fallback = onnxResult.status === 'ok' ? ' (+ ONNX offline fallback)' : '';
    return { name, status: 'ok', info: `ollama nomic-embed-text 768d${fallback}` };
  }
  if (onnxResult.status === 'ok') {
    return { name, status: 'ok', info: 'ONNX 384d fallback only — see warnings above for the Ollama upgrade path' };
  }
  return {
    name,
    status: 'fail',
    info: 'no embedding route at all — store/search will not work. ' +
      'Install Ollama + `ollama pull nomic-embed-text`, or `node scripts/download-model.mjs`',
  };
}

/**
 * @param {Array<Pick<CheckResult, 'status'>>} checks
 * @returns {0|1|2} 0 = healthy, 1 = warnings only, 2 = broken
 */
export function aggregateExitCode(checks) {
  if (checks.some((c) => c.status === 'fail')) return 2;
  if (checks.some((c) => c.status === 'warn')) return 1;
  return 0;
}

function printHelp() {
  process.stdout.write(`
neuromcp-doctor — install + privacy diagnostics

Usage:
  neuromcp-doctor check               env + dep + daemon + embeddings + db triage
  neuromcp-doctor audit-network       proves zero-egress for 30s
  neuromcp-doctor --help              this message

Exit codes (check): 0 = healthy, 1 = warnings only, 2 = broken

`);
}

const STATUS_GLYPH = { ok: '✓', warn: '!', fail: '✗', skip: '-' };

async function runCheck() {
  /** @type {CheckResult[]} */
  const checks = [];

  // 1. Node version
  const nv = process.versions.node;
  const major = parseInt(nv.split('.')[0], 10);
  checks.push(major >= 20
    ? { name: 'node version', status: 'ok', info: `v${nv}` }
    : { name: 'node version', status: 'fail', info: `v${nv} — neuromcp requires Node 20+` });

  // 2. dist/ exists (run npm run build if not)
  const distPath = resolve(REPO_ROOT, 'dist', 'index.js');
  checks.push(existsSync(distPath)
    ? { name: 'dist/index.js', status: 'ok', info: distPath }
    : { name: 'dist/index.js', status: 'fail', info: 'missing — run `npm run build` first' });

  // 3. better-sqlite3 loads for real (import, not a node_modules path guess)
  const { result: sqliteResult, Database } = await checkBetterSqlite();
  checks.push(sqliteResult);

  // 4. package.json version
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    checks.push({ name: 'package version', status: 'ok', info: pkg.version });
  } catch (err) {
    checks.push({ name: 'package.json', status: 'fail', info: String(err) });
  }

  // 5. ~/.neuromcp directory (where wiki + db live)
  const userDir = resolve(homedir(), '.neuromcp');
  checks.push({
    name: 'user data dir',
    status: 'ok',
    info: existsSync(userDir) ? userDir : `(will be created on first run) ${userDir}`,
  });

  // 6. Platform note
  checks.push({ name: 'platform', status: 'ok', info: `${platform()} ${process.arch}` });

  // 7. Memory db opens read-only (skips when better-sqlite3 didn't load)
  checks.push(checkDatabase({ Database }));

  // 8-10. Daemon + embedding routes (network probes run concurrently)
  const [daemonResult, ollamaResult] = await Promise.all([checkDaemon(), checkOllama()]);
  const onnxResult = checkOnnxModel();
  checks.push(daemonResult, ollamaResult, onnxResult);
  checks.push(deriveEmbeddingRoute(ollamaResult, onnxResult));

  // Render
  const w = Math.max(...checks.map((c) => c.name.length)) + 2;
  for (const c of checks) {
    process.stdout.write(`${STATUS_GLYPH[c.status]} ${c.name.padEnd(w)} ${c.info}\n`);
  }
  const code = aggregateExitCode(checks);
  if (code === 1) {
    process.stdout.write('\nwarnings present — degraded but functional (exit 1)\n');
  } else if (code === 2) {
    process.stdout.write('\nbroken — see ✗ lines above (exit 2)\n');
  }
  process.exit(code);
}

/**
 * Stop the audited child server: SIGTERM first, escalate to SIGKILL when
 * it has not exited after graceMs. `child.killed` only means "a signal
 * was sent", so exit is detected via the 'exit' event — a child that
 * traps SIGTERM would otherwise leak as an orphan.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ graceMs?: number }} [opts]
 * @returns {Promise<boolean>} true when escalation to SIGKILL was needed
 */
export function terminateChild(child, opts = {}) {
  const { graceMs = 1_000 } = opts;
  return new Promise((resolveDone) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveDone(false);
      return;
    }
    const onExit = () => {
      clearTimeout(timer);
      resolveDone(false);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      child.kill('SIGKILL');
      resolveDone(true);
    }, graceMs);
    child.once('exit', onExit);
    child.kill('SIGTERM');
  });
}

/**
 * Spawn the neuromcp server as a child process with a custom Node
 * `--import` shim that monkey-patches `node:net`'s Socket.connect and
 * `node:dgram`. Any non-loopback target is logged. Run for the audit
 * window, then report.
 *
 * @param {{
 *   spawnImpl?: typeof spawn,
 *   exists?: (p: string) => boolean,
 *   auditMs?: number,
 *   graceMs?: number,
 *   stdout?: { write: (s: string) => unknown },
 *   stderr?: { write: (s: string) => unknown },
 * }} [deps]
 * @returns {Promise<0|1>} CLI exit code
 */
export async function runAuditNetwork(deps = {}) {
  const {
    spawnImpl = spawn,
    exists = existsSync,
    auditMs = 30_000,
    graceMs = 1_000,
    stdout = process.stdout,
    stderr = process.stderr,
  } = deps;

  const shimPath = resolve(HERE, 'audit-network-shim.mjs');
  if (!exists(shimPath)) {
    // Lazy-write the shim on first use to keep the bin/ dir clean.
    writeShim(shimPath);
  }

  const dist = resolve(REPO_ROOT, 'dist', 'index.js');
  if (!exists(dist)) {
    stderr.write('dist/index.js missing — run `npm run build` first\n');
    return 1;
  }

  /** @type {string[]} */
  const auditEvents = [];
  const child = spawnImpl(
    process.execPath,
    ['--import', shimPath, dist],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NEUROMCP_AUDIT_NETWORK: '1',
        NEUROMCP_HTTP_ENABLED: '1',
        NEUROMCP_HTTP_PORT: '0',
      },
    },
  );

  // A spawn failure (ENOENT, EACCES, …) is delivered as an 'error' event;
  // without a listener Node turns it into an uncaught exception mid-audit.
  const spawnFailure = new Promise((resolveErr) => {
    child.on('error', (err) => resolveErr(err));
  });

  child.stderr.on('data', (b) => {
    const s = b.toString();
    for (const line of s.split('\n')) {
      if (line.startsWith('[NET-AUDIT]')) auditEvents.push(line.slice(11).trim());
    }
  });

  stdout.write(`Auditing outbound connections for ${Math.round(auditMs / 1000)} seconds...\n`);
  const failure = await Promise.race([
    spawnFailure,
    new Promise((r) => setTimeout(() => r(null), auditMs)),
  ]);
  if (failure) {
    const msg = failure instanceof Error ? failure.message : String(failure);
    stderr.write(`✗ could not start the audited server: ${msg}\n`);
    return 1;
  }

  await terminateChild(child, { graceMs });

  if (auditEvents.length === 0) {
    stdout.write(
      '\n✓ zero TCP/UDP outbound connections observed in ' +
      `${Math.round(auditMs / 1000)}s\n` +
      '  (via net.Socket + dgram shim — does NOT cover undici/fetch,\n' +
      '   node:http2, or DNS prefetch. For completeness run\n' +
      '   `tcpdump -i any -n host not 127.0.0.1` alongside.)\n',
    );
    return 0;
  }
  stdout.write(`\n✗ ${auditEvents.length} outbound connections observed:\n`);
  for (const e of auditEvents) stdout.write(`  ${e}\n`);
  return 1;
}

/** @param {string} path */
function writeShim(path) {
  const src = `
// audit-network-shim.mjs — registered via --import. Wraps net.Socket.connect
// and dgram.createSocket().send to log non-loopback destinations to stderr
// with the [NET-AUDIT] prefix. The doctor CLI greps for that prefix.
import net from 'node:net';
import dgram from 'node:dgram';

const isLoopback = (host) => {
  if (!host) return true;
  const h = String(host);
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
};

const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  let opts = args[0];
  if (typeof opts === 'object' && opts !== null) {
    if (!isLoopback(opts.host)) {
      process.stderr.write(\`[NET-AUDIT] tcp connect host=\${opts.host} port=\${opts.port}\\n\`);
    }
  } else if (typeof args[1] === 'string') {
    if (!isLoopback(args[1])) {
      process.stderr.write(\`[NET-AUDIT] tcp connect host=\${args[1]} port=\${args[0]}\\n\`);
    }
  }
  return origConnect.apply(this, args);
};

const origCreate = dgram.createSocket;
dgram.createSocket = function patchedCreate(...args) {
  const sock = origCreate.apply(this, args);
  const origSend = sock.send.bind(sock);
  sock.send = function patchedSend(buf, off, len, port, address, cb) {
    const host = typeof off === 'string' ? off : address;
    if (!isLoopback(host)) {
      process.stderr.write(\`[NET-AUDIT] udp send host=\${host} port=\${typeof off === 'string' ? len : port}\\n\`);
    }
    return origSend(buf, off, len, port, address, cb);
  };
  return sock;
};
`;
  writeFileSync(path, src.trim() + '\n', { mode: 0o644 });
}

async function main() {
  const cmd = process.argv[2] ?? 'check';

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    process.exit(0);
  }

  if (cmd === 'check') {
    await runCheck();
  } else if (cmd === 'audit-network') {
    process.exit(await runAuditNetwork());
  } else {
    console.error(`Unknown subcommand: ${cmd}\n`);
    printHelp();
    process.exit(2);
  }
}

// Direct-invocation guard: run main() only when this file is the
// entrypoint, so tests can import the pure helpers without side effects.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
