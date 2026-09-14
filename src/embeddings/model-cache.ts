/**
 * model-cache.ts — where the offline ONNX fallback model lives, and how it
 * gets there without an install script.
 *
 * Why this exists (v0.29.3): the model used to arrive ONLY via the
 * `postinstall` hook (`node scripts/download-model.mjs`). Two real installs
 * break that assumption:
 *
 *   1. Install scripts disabled (`npm install --ignore-scripts`, a hardened
 *      `.npmrc`, CI policy, pnpm's build allowlist). Verified on npm 11:
 *      the package installs fine, `models/` is simply never created — and
 *      the server then reports "no embedding route at all".
 *   2. A root-owned global install (`/usr/local/lib/node_modules/neuromcp`)
 *      where the package directory is not writable by the user running the
 *      server, so even a manual re-run of the download fails.
 *
 * Fix: resolve the model from a per-user cache dir FIRST (default
 * `~/.neuromcp/models`, override with NEUROMCP_MODEL_DIR), fall back to the
 * package-local `models/` dir that the postinstall still fills, and — when
 * neither has it — download it lazily at first use with a clear stderr
 * message. Set NEUROMCP_DISABLE_MODEL_DOWNLOAD=1 to forbid the lazy fetch
 * (air-gapped installs, zero-egress audits).
 */
import { existsSync, mkdirSync, renameSync, createWriteStream, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MODEL_FILENAME = 'bge-small-en-v1.5.onnx';
export const MODEL_URL =
  'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx';

/** The per-user cache directory the lazy download writes to. */
export function userModelDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env['NEUROMCP_MODEL_DIR'];
  if (override !== undefined && override !== '') return override;
  return resolve(home, '.neuromcp', 'models');
}

/**
 * Every place the model may already be, most-specific first. The package
 * directory is included because the postinstall still writes there when it
 * is allowed to run.
 */
export function modelSearchPaths(
  moduleDir: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  cwd: string = process.cwd(),
): string[] {
  const candidates = [
    resolve(userModelDir(env, home), MODEL_FILENAME),
    // From dist/ (bundled) → ../models/ (package root)
    resolve(moduleDir, '..', 'models', MODEL_FILENAME),
    // From src/embeddings/ (dev) → ../../models/
    resolve(moduleDir, '..', '..', 'models', MODEL_FILENAME),
    // Relative to cwd
    resolve(cwd, 'models', MODEL_FILENAME),
    // node_modules/neuromcp/models/
    resolve(moduleDir, 'models', MODEL_FILENAME),
  ];
  return [...new Set(candidates)];
}

/** First existing model path, or null. */
export function findModel(
  moduleDir: string,
  deps: {
    exists?: (p: string) => boolean;
    env?: NodeJS.ProcessEnv;
    home?: string;
    cwd?: string;
  } = {},
): string | null {
  const { exists = existsSync, env = process.env, home = homedir(), cwd = process.cwd() } = deps;
  for (const candidate of modelSearchPaths(moduleDir, env, home, cwd)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function downloadsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['NEUROMCP_DISABLE_MODEL_DOWNLOAD'] === '1';
}

/**
 * Download the model into `targetDir` (atomically: temp file + rename, so a
 * killed download never leaves a truncated model behind).
 */
export async function downloadModel(
  targetDir: string,
  deps: {
    fetchImpl?: typeof fetch;
    url?: string;
    stderr?: { write: (s: string) => unknown };
  } = {},
): Promise<string> {
  const { fetchImpl = fetch, url = MODEL_URL, stderr = process.stderr } = deps;
  const target = resolve(targetDir, MODEL_FILENAME);
  mkdirSync(targetDir, { recursive: true });

  stderr.write(
    `[neuromcp] ONNX fallback model missing — downloading bge-small-en-v1.5 (~33MB) to ${target}.\n` +
      `[neuromcp] This happens once. Set NEUROMCP_DISABLE_MODEL_DOWNLOAD=1 to forbid it.\n`,
  );

  const response = await fetchImpl(url);
  if (!response.ok || response.body === null) {
    throw new Error(`model download failed: HTTP ${response.status}`);
  }

  const tmp = `${target}.part-${process.pid}`;
  try {
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(tmp));
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
  stderr.write(`[neuromcp] Model ready: ${target}\n`);
  return target;
}

/**
 * Resolve the model path, downloading it on first use when it is absent.
 * Returns null when the model is unavailable and cannot be fetched — the
 * caller (OnnxEmbeddingProvider.isAvailable) turns that into "this provider
 * is not usable" rather than a crash.
 */
export async function ensureModel(
  moduleDir: string,
  deps: {
    exists?: (p: string) => boolean;
    env?: NodeJS.ProcessEnv;
    home?: string;
    cwd?: string;
    fetchImpl?: typeof fetch;
    stderr?: { write: (s: string) => unknown };
  } = {},
): Promise<string | null> {
  const { env = process.env, home = homedir(), stderr = process.stderr } = deps;
  const found = findModel(moduleDir, deps);
  if (found !== null) return found;
  if (downloadsDisabled(env)) {
    stderr.write(
      '[neuromcp] ONNX model missing and NEUROMCP_DISABLE_MODEL_DOWNLOAD=1 — ' +
        'run `npx neuromcp-download-model` on a machine with network access.\n',
    );
    return null;
  }
  try {
    return await downloadModel(userModelDir(env, home), { ...deps, stderr });
  } catch (err) {
    stderr.write(
      `[neuromcp] ONNX model download failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'Retry with `npx neuromcp-download-model`.\n',
    );
    return null;
  }
}

/** Directory of this module — exported so callers need not repeat the dance. */
export function thisModuleDir(metaUrl: string): string {
  return dirname(fileURLToPath(metaUrl));
}
