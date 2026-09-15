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
import { isMainModule } from './is-main.mjs';
import { homedir, platform } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const DEFAULT_DAEMON_PORT = 3200;
const PROBE_TIMEOUT_MS = 2_000;
const LAUNCHD_LABEL = 'com.neuromcp.daemon';
const MODEL_FILENAME = 'bge-small-en-v1.5.onnx';
// Where scripts/download-model.mjs writes the offline fallback model.
const ONNX_MODEL_PATH = resolve(REPO_ROOT, 'models', MODEL_FILENAME);
// v0.29.3: the lazy first-run download writes here instead (user-writable
// even when the package lives in a root-owned global prefix).
const ONNX_USER_MODEL_PATH = resolve(homedir(), '.neuromcp', 'models', MODEL_FILENAME);

/**
 * @typedef {{ name: string, status: 'ok'|'warn'|'fail'|'skip', info: string }} CheckResult
 */

/**
 * Minimal better-sqlite3 surface the checks use. Declared once so the db
 * checks and the embedding-index check agree on the handle shape.
 *
 * @typedef {new (path: string, opts?: object) => {
 *   pragma: (s: string) => unknown,
 *   prepare: (sql: string) => { get: (...a: unknown[]) => unknown, all: (...a: unknown[]) => unknown[] },
 *   close: () => void,
 * }} SqliteCtor
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
 * @returns {Promise<{ result: CheckResult, probe: { model: string, dimensions: number | null } | null }>}
 */
export async function checkOllama(deps = {}) {
  const { fetchImpl = defaultFetch, env = process.env } = deps;
  const name = 'ollama embeddings';
  const host = env.OLLAMA_HOST ?? 'http://localhost:11434';
  const base = host.replace(/\/$/, '');
  // Probe the model the runtime will actually use — presenting a nomic
  // probe as evidence for a custom NEUROMCP_EMBEDDING_MODEL diagnosed the
  // wrong thing entirely (Codex round 3).
  const model =
    env.NEUROMCP_EMBEDDING_MODEL !== undefined && env.NEUROMCP_EMBEDDING_MODEL !== 'auto'
      ? env.NEUROMCP_EMBEDDING_MODEL
      : 'nomic-embed-text';
  // Ollama tag semantics: an untagged name means the ':latest' tag, and a
  // configured value may itself carry a tag. Comparing bases only can never
  // match a tagged configuration (Codex round 4).
  /** @param {string} listed @param {string} wanted @returns {boolean} */
  const modelMatches = (listed, wanted) => {
    // Normalize BOTH sides to an explicit tag: `ollama run all-minilm`
    // resolves to :latest specifically, so a listed :v2 must not satisfy
    // an untagged configuration (the runtime's embed call would fail).
    const [listedBase, listedTag = 'latest'] = listed.split(':');
    const [wantedBase, wantedTag = 'latest'] = wanted.split(':');
    return listedBase === wantedBase && listedTag === wantedTag;
  };
  // The embed probe uses the RUNTIME's budget (a cold model load easily
  // exceeds the 2s reachability budget; concluding "broken" while the
  // runtime would match is a misdiagnosis).
  const embedBudgetRaw = Number(env.NEUROMCP_EMBED_TIMEOUT_MS);
  const embedBudgetMs =
    Number.isFinite(embedBudgetRaw) && embedBudgetRaw > 0 ? Math.floor(embedBudgetRaw) : 30_000;
  try {
    const res = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) {
      return { result: ollamaDownResult(name, host, `HTTP ${res.status}`), probe: null };
    }
    const body = /** @type {{ models?: Array<{ name?: unknown }> }} */ (await res.json());
    const models = Array.isArray(body?.models) ? body.models : [];
    const hasModel = models.some(
      (m) => typeof m?.name === 'string' && modelMatches(m.name, model),
    );
    if (!hasModel) {
      return {
        result: {
          name,
          status: 'warn',
          info: `Ollama runs at ${host} but ${model} is not pulled — ` +
            `retrieval falls back to ONNX 384d (lower quality). ` +
            `Fix: \`ollama pull ${model}\``,
        },
        probe: null,
      };
    }
    // Measure the model's real width instead of assuming one — a custom
    // model can be any dimension, and the embedding-index check needs the
    // truth to apply the runtime's compatibility rule.
    let dims = null;
    try {
      const probeRes = await fetchImpl(`${base}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: 'dimension probe' }),
        signal: AbortSignal.timeout(embedBudgetMs),
      });
      const probeBody = probeRes.ok
        ? /** @type {{ embeddings?: number[][] }} */ (await probeRes.json())
        : null;
      const candidate = probeBody?.embeddings?.[0]?.length;
      if (typeof candidate === 'number' && candidate > 0) dims = candidate;
    } catch {
      // listed-but-unmeasurable is UNVERIFIED, not absent — fall through
    }
    if (dims === null) {
      return {
        result: {
          name,
          status: 'warn',
          info: `${model} is listed at ${host} but the embed probe failed or timed out — ` +
            `its dimension is UNVERIFIED (the runtime, with NEUROMCP_EMBED_TIMEOUT_MS=${embedBudgetMs}, may still work)`,
        },
        probe: { model, dimensions: null },
      };
    }
    return {
      result: { name, status: 'ok', info: `${model} (${dims}d, measured) available at ${host}` },
      probe: { model, dimensions: dims },
    };
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError'
      ? `timeout after ${PROBE_TIMEOUT_MS}ms`
      : err instanceof Error ? err.message : String(err);
    return { result: ollamaDownResult(name, host, reason), probe: null };
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
 * @param {{ exists?: (p: string) => boolean, modelPath?: string, userModelPath?: string, env?: Record<string, string | undefined> }} [deps]
 * @returns {CheckResult}
 */
export function checkOnnxModel(deps = {}) {
  const {
    exists = existsSync,
    modelPath = ONNX_MODEL_PATH,
    userModelPath = ONNX_USER_MODEL_PATH,
    env = process.env,
  } = deps;
  const name = 'onnx fallback model';
  // NEUROMCP_MODEL_DIR is where the runtime resolves the model FIRST
  // (embeddings/model-cache.ts) — a doctor that never looks there calls a
  // working custom-dir install route-less.
  const customDir = env.NEUROMCP_MODEL_DIR;
  const candidates =
    customDir !== undefined && customDir !== ''
      ? [resolve(customDir, MODEL_FILENAME), userModelPath, modelPath]
      : [userModelPath, modelPath];
  for (const candidate of candidates) {
    if (exists(candidate)) {
      return { name, status: 'ok', info: candidate };
    }
  }
  return {
    name,
    status: 'warn',
    info: `missing at ${userModelPath} and ${modelPath} — no offline embedding fallback yet. ` +
      `It is downloaded automatically on first use; to fetch it now run \`npx neuromcp-download-model\` ` +
      `(or \`node scripts/download-model.mjs\` in a checkout).`,
  };
}

/**
 * Actually load better-sqlite3 (native binding included) instead of
 * guessing from a node_modules path — hoisted npm installs made the old
 * path check report false negatives.
 *
 * @param {{ loadModule?: () => Promise<{ default: unknown }> }} [deps]
 * @returns {Promise<{ result: CheckResult, Database: SqliteCtor | null }>}
 */
export async function checkBetterSqlite(deps = {}) {
  const { loadModule = () => import(defaultResolveSqlite()) } = deps;
  const name = 'better-sqlite3 native';
  try {
    const mod = await loadModule();
    const Database = /** @type {SqliteCtor} */ (mod.default ?? mod);
    // Importing the module is NOT enough: an `--ignore-scripts` install
    // imports fine and only fails when a Database is constructed (the
    // native binding loads lazily). Construct one, or exactly the failure
    // mode this check documents gets diagnosed as healthy.
    const probe = new Database(':memory:');
    probe.close();
    return {
      result: { name, status: 'ok', info: 'module + native binding load (:memory: smoke test)' },
      Database,
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
 *   Database: SqliteCtor | null,
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
 * Name the 0.29.2 killer explicitly: the vector index in the database has a
 * fixed width, and the provider that is actually reachable may no longer
 * produce that width (installed Ollama after the ONNX fallback built a
 * 384-dim index, or Ollama is down on a 768-dim index). 0.29.3 no longer
 * crashes on this — it starts DEGRADED — so the doctor has to say out loud
 * which state the machine is in and how to leave it.
 *
 * @param {{
 *   Database: SqliteCtor | null,
 *   ollamaProbe: { model: string, dimensions: number | null } | null,
 *   onnxResult: Pick<CheckResult, 'status'>,
 *   env?: Record<string, string | undefined>,
 *   exists?: (p: string) => boolean,
 *   home?: string,
 * }} deps
 * @returns {CheckResult}
 */
export function checkEmbeddingIndex(deps) {
  const {
    Database,
    ollamaProbe,
    onnxResult,
    env = process.env,
    exists = existsSync,
    home = homedir(),
  } = deps;
  const name = 'embedding index';
  const dbPath = env.NEUROMCP_DB_PATH ?? resolve(home, '.neuromcp', 'memory.db');

  if (Database === null) {
    return { name, status: 'skip', info: 'skipped — better-sqlite3 did not load' };
  }
  if (!exists(dbPath)) {
    return { name, status: 'ok', info: 'no database yet — the first provider to run defines the index width' };
  }

  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = /** @type {{ sql?: string } | undefined} */ (
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_vec'").get()
    );
    if (row === undefined || typeof row.sql !== 'string') {
      return { name, status: 'ok', info: 'no vector index yet — nothing to mismatch' };
    }
    const match = row.sql.match(/float\[(\d+)\]/);
    const indexDim = match ? Number(match[1]) : null;
    if (indexDim === null) {
      return { name, status: 'warn', info: 'memories_vec exists but its width could not be parsed' };
    }

    // Which providers can this machine actually use right now — under the
    // SAME rules the runtime applies: the explicit provider setting narrows
    // the cascade, and a same-width provider of another MODEL is not a
    // match (its vectors are unrelated). Without this the doctor declared
    // "matched by onnx" while the runtime was degrading (Codex round 2).
    const requested = env.NEUROMCP_EMBEDDING_PROVIDER ?? 'auto';
    const available = [];
    /** @type {Array<{ provider: string, model: string }>} */
    const unverified = [];
    // The doctor never probes OpenAI (no free probe exists). When the
    // configuration makes OpenAI selectable, the honest verdict on a
    // non-matching index is "unverifiable", never "proven mismatch".
    if (requested === 'openai' || (requested === 'auto' && typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY !== '')) {
      const openaiModel =
        env.NEUROMCP_EMBEDDING_MODEL !== undefined && env.NEUROMCP_EMBEDDING_MODEL.startsWith('text-embedding')
          ? env.NEUROMCP_EMBEDDING_MODEL
          : 'text-embedding-3-small';
      unverified.push({ provider: `openai ${openaiModel} (doctor cannot probe OpenAI)`, model: openaiModel });
    }
    if ((requested === 'auto' || requested === 'ollama') && ollamaProbe !== null) {
      // The probe carries the MEASURED width of the CONFIGURED model — a
      // nomic assumption here misdiagnosed every custom-model setup. A
      // listed model whose width could not be measured is UNVERIFIED: it
      // must not count as a match, but it is no proof of a mismatch either.
      if (ollamaProbe.dimensions === null) {
        unverified.push({ provider: `ollama ${ollamaProbe.model}`, model: ollamaProbe.model });
      } else {
        available.push({
          provider: `ollama ${ollamaProbe.model}`,
          model: ollamaProbe.model,
          dim: ollamaProbe.dimensions,
        });
      }
    }
    if ((requested === 'auto' || requested === 'onnx') && onnxResult.status === 'ok') {
      available.push({ provider: 'onnx bge-small-en-v1.5', model: 'bge-small-en-v1.5', dim: 384 });
    }

    // What model produced the embeddings that are already stored?
    /** @type {Array<{ embedding_model: string, n: number }>} */
    let storedModels = [];
    try {
      storedModels = /** @type {Array<{ embedding_model: string, n: number }>} */ (
        db
          .prepare(
            `SELECT embedding_model, COUNT(*) AS n FROM memories
              WHERE is_deleted = 0
                AND embedding_model IS NOT NULL
                AND embedding_model NOT IN ('none', '')
              GROUP BY embedding_model`,
          )
          .all()
      );
    } catch {
      /* pre-schema database — width-only check below */
    }

    // Runtime parity: a candidate matches only when EVERY stored model is
    // its own (one foreign model already degrades the runtime), unless the
    // documented mix-override is active.
    const mixAllowed = env.NEUROMCP_ALLOW_EMBEDDING_MODEL_MIX === '1';
    const widthMatches = available.filter((a) => a.dim === indexDim);
    const matching = widthMatches.find(
      (a) => mixAllowed || storedModels.every((m) => m.embedding_model === a.model),
    );
    if (matching !== undefined) {
      return {
        name,
        status: 'ok',
        info: `${indexDim}-dim index in ${dbPath}, matched by ${matching.provider}`,
      };
    }
    if (unverified.length > 0) {
      // Uncertainty outranks the hard verdicts below: an unverified
      // candidate may be exactly the matching provider, so neither a
      // measured same-width model mismatch nor a width mismatch is PROOF
      // of a broken install while it is in play.
      const mismatchNote = widthMatches.length > 0
        ? ` (${widthMatches.map((a) => a.provider).join(' / ')} matches the width but not the stored model)`
        : '';
      return {
        name,
        status: 'warn',
        info:
          `${indexDim}-dim index in ${dbPath}; ${unverified.map((u) => u.provider).join(' / ')} could not be ` +
          `verified (dimension UNVERIFIED)${mismatchNote} — the runtime may still match. ` +
          `Retry, raise NEUROMCP_EMBED_TIMEOUT_MS, or check the daemon log for the live verdict.`,
      };
    }
    if (widthMatches.length > 0) {
      const stored = storedModels.map((m) => `"${m.embedding_model}" (${m.n})`).join(', ');
      return {
        name,
        status: 'fail',
        info:
          `MODEL MISMATCH: ${dbPath} holds a ${indexDim}-dim index with embeddings by ${stored}, ` +
          `but the reachable ${indexDim}d provider is ${widthMatches.map((a) => a.provider).join(' / ')} — ` +
          `same width, different model: the runtime starts DEGRADED rather than mixing vector spaces. ` +
          `Recovery: restore the original model, or rebuild with \`npx neuromcp-reembed\` (dry run) then ` +
          `\`npx neuromcp-reembed --apply\`.`,
      };
    }
    const scope = requested === 'auto' ? '' : ` under NEUROMCP_EMBEDDING_PROVIDER=${requested}`;
    const offer = available.length === 0
      ? `no eligible provider is reachable${scope}` +
        (requested === 'openai' ? ' (the doctor cannot verify OpenAI widths — check the daemon log)' : '')
      : `only ${available.map((a) => `${a.provider} (${a.dim}d)`).join(' and ')} eligible${scope}`;
    return {
      name,
      status: 'fail',
      info:
        `DIMENSION MISMATCH: ${dbPath} holds a ${indexDim}-dim vector index but ${offer}. ` +
        `neuromcp 0.29.3+ starts in DEGRADED mode here (full-text search works, vector search off, ` +
        `new memories queued for backfill) — it does not crash. Recovery, pick one: ` +
        `(a) restore the ${indexDim}-dim provider — for 768 start Ollama and \`ollama pull nomic-embed-text\`, ` +
        `for 384 keep the ONNX fallback (\`npx neuromcp-download-model\`) and set NEUROMCP_EMBEDDING_PROVIDER=onnx; ` +
        `or (b) rebuild the index for the provider you want: \`npx neuromcp-reembed\` (dry run on a COPY) then ` +
        `\`npx neuromcp-reembed --apply\` (swaps it in, keeps a timestamped backup).`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: 'warn', info: `could not inspect ${dbPath}: ${msg}` };
  } finally {
    try {
      db?.close();
    } catch {
      // read-only handle
    }
  }
}

/**
 * At least one embedding route (Ollama 768d or ONNX 384d fallback) must
 * exist, otherwise store/search are dead — that is broken, not a warning.
 *
 * @param {Pick<CheckResult, 'status'>} ollamaResult
 * @param {Pick<CheckResult, 'status'>} onnxResult
 * @param {{ model: string, dimensions: number | null } | null} [ollamaProbe]
 * @returns {CheckResult}
 */
export function deriveEmbeddingRoute(ollamaResult, onnxResult, ollamaProbe = null) {
  const name = 'embedding route';
  if (ollamaResult.status === 'ok') {
    const fallback = onnxResult.status === 'ok' ? ' (+ ONNX offline fallback)' : '';
    // Report the MEASURED model and width when the probe has them — the
    // route summary claimed nomic/768 even for a measured 384d custom model.
    const route =
      ollamaProbe !== null && ollamaProbe.dimensions !== null
        ? `ollama ${ollamaProbe.model} ${ollamaProbe.dimensions}d`
        : 'ollama nomic-embed-text 768d';
    return { name, status: 'ok', info: `${route}${fallback}` };
  }
  if (onnxResult.status === 'ok') {
    return { name, status: 'ok', info: 'ONNX 384d fallback only — see warnings above for the Ollama upgrade path' };
  }
  if (ollamaProbe !== null && ollamaProbe.dimensions === null) {
    // A listed model whose width could not be measured is an UNVERIFIED
    // route, not a missing one — "no embedding route, exit 2" here dragged
    // the aggregate verdict to broken while the runtime may work fine.
    return {
      name,
      status: 'warn',
      info: `ollama ${ollamaProbe.model} is listed but its dimension is UNVERIFIED ` +
        '(embed probe failed or timed out) — the runtime may still work; ' +
        'retry or raise NEUROMCP_EMBED_TIMEOUT_MS',
    };
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
  neuromcp-doctor check [--json]      env + dep + daemon + embeddings + db triage
  neuromcp-doctor audit-network       proves zero-egress for 30s
  neuromcp-doctor --help              this message

Options:
  --json   machine-readable report on stdout: { version, exit_code, checks[] }

Exit codes (check): 0 = healthy, 1 = warnings only, 2 = broken

`);
}

const STATUS_GLYPH = { ok: '✓', warn: '!', fail: '✗', skip: '-' };

/**
 * Render a finished check list. Pure + injectable so the "doctor must print
 * something" guarantee is testable without spawning a process.
 *
 * @param {CheckResult[]} checks
 * @param {{ json?: boolean, version?: string }} [opts]
 * @returns {string} the exact text written to stdout
 */
export function renderChecks(checks, opts = {}) {
  const { json = false, version = 'unknown' } = opts;
  const code = aggregateExitCode(checks);
  if (json) {
    return JSON.stringify({ version, exit_code: code, checks }, null, 2) + '\n';
  }
  if (checks.length === 0) {
    return 'no checks ran — this is a bug, please report it\n';
  }
  const w = Math.max(...checks.map((c) => c.name.length)) + 2;
  let out = '';
  for (const c of checks) {
    out += `${STATUS_GLYPH[c.status]} ${c.name.padEnd(w)} ${c.info}\n`;
  }
  if (code === 1) {
    out += '\nwarnings present — degraded but functional (exit 1)\n';
  } else if (code === 2) {
    out += '\nbroken — see ✗ lines above (exit 2)\n';
  } else {
    out += '\nall checks passed (exit 0)\n';
  }
  return out;
}

/**
 * Collect every check. Separated from rendering so `--json` and the text
 * report cannot drift apart.
 *
 * @returns {Promise<CheckResult[]>}
 */
export async function collectChecks() {
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
  const [daemonResult, ollamaOutcome] = await Promise.all([checkDaemon(), checkOllama()]);
  const ollamaResult = ollamaOutcome.result;
  const onnxResult = checkOnnxModel();
  checks.push(daemonResult, ollamaResult, onnxResult);
  checks.push(deriveEmbeddingRoute(ollamaResult, onnxResult, ollamaOutcome.probe));

  // 11. Vector-index width vs what this machine can actually embed.
  checks.push(checkEmbeddingIndex({ Database, ollamaProbe: ollamaOutcome.probe, onnxResult }));

  return checks;
}

/**
 * @param {{ json?: boolean }} [opts]
 * @returns {Promise<0|1|2>}
 */
async function runCheck(opts = {}) {
  /** @type {CheckResult[]} */
  let checks;
  try {
    checks = await collectChecks();
  } catch (err) {
    // A doctor that dies silently is the worst possible doctor (that was
    // literally bug #2 in 0.29.2). Always emit something readable.
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    checks = [/** @type {CheckResult} */ ({ name: 'doctor', status: 'fail', info: `diagnostics crashed: ${msg}` })];
  }
  let version = 'unknown';
  try {
    version = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    // reported as 'unknown'
  }
  process.stdout.write(renderChecks(checks, { json: opts.json === true, version }));
  return aggregateExitCode(checks);
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
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const cmd = argv.find((a) => !a.startsWith('-')) ?? 'check';

  if (argv.includes('--help') || argv.includes('-h') || cmd === 'help') {
    printHelp();
    process.exit(0);
  }

  if (cmd === 'check') {
    // process.exit can truncate a pending write on a pipe; flush first.
    const code = await runCheck({ json });
    await flushStdout();
    process.exit(code);
  } else if (cmd === 'audit-network') {
    const code = await runAuditNetwork();
    await flushStdout();
    process.exit(code);
  } else {
    process.stderr.write(`Unknown subcommand: ${cmd}\n`);
    printHelp();
    await flushStdout();
    process.exit(2);
  }
}

/**
 * Wait until stdout has drained. When stdout is a pipe (CI, `| tee`, a GUI
 * client capturing output) writes are asynchronous, and process.exit() right
 * after a write can drop the report entirely.
 *
 * @returns {Promise<void>}
 */
function flushStdout() {
  return new Promise((resolveDone) => {
    if (process.stdout.writableLength === 0) {
      resolveDone();
      return;
    }
    process.stdout.write('', () => resolveDone());
  });
}

// Direct-invocation guard: run main() only when this file is the
// entrypoint, so tests can import the pure helpers without side effects.
if (isMainModule(import.meta.url)) {
  void main();
}
