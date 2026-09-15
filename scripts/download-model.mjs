#!/usr/bin/env node
/**
 * download-model — fetch the offline ONNX fallback model.
 *
 * Runs in two situations:
 *   1. as the package `postinstall` (best effort, `|| true`), and
 *   2. as `npx neuromcp-download-model`, the documented manual fetch for
 *      installs where lifecycle scripts are disabled (`npm install
 *      --ignore-scripts`, a hardened .npmrc, pnpm's build allowlist).
 *
 * The server also downloads it lazily on first use — see
 * src/embeddings/model-cache.ts. All three write the SAME file name, and
 * the runtime looks in the user directory first.
 *
 * Target directory:
 *   - $NEUROMCP_MODEL_DIR when set,
 *   - else <package>/models when that is writable (keeps checkouts tidy),
 *   - else ~/.neuromcp/models (a root-owned global install is not writable
 *     by the user who later runs the server).
 */
import { mkdirSync, existsSync, createWriteStream, renameSync, unlinkSync, accessSync, constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_URL = 'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx';
const MODEL_FILENAME = 'bge-small-en-v1.5.onnx';
const PACKAGE_MODEL_DIR = resolve(__dirname, '..', 'models');
const USER_MODEL_DIR = resolve(homedir(), '.neuromcp', 'models');

/**
 * @param {string} dir
 * @returns {boolean}
 */
function isWritableDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function chooseTargetDir(env = process.env) {
  const override = env.NEUROMCP_MODEL_DIR;
  if (override !== undefined && override !== '') return override;
  if (isWritableDir(PACKAGE_MODEL_DIR)) return PACKAGE_MODEL_DIR;
  return USER_MODEL_DIR;
}

/**
 * Runtime-parity existence check: NEUROMCP_MODEL_DIR REPLACES the default
 * user cache (embeddings/model-cache.ts) — a model in the default cache is
 * invisible to a runtime configured with the override, so it must not make
 * this CLI report "already present" (Codex round 7).
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ userModelDir?: string, packageModelDir?: string }} [deps]
 * @returns {string | null}
 */
export function resolveExistingModel(env = process.env, deps = {}) {
  const { userModelDir = USER_MODEL_DIR, packageModelDir = PACKAGE_MODEL_DIR } = deps;
  const override = env.NEUROMCP_MODEL_DIR;
  const dirs =
    override !== undefined && override !== ''
      ? [override, packageModelDir]
      : [userModelDir, packageModelDir];
  for (const dir of dirs) {
    const candidate = resolve(dir, MODEL_FILENAME);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  const existing = resolveExistingModel();
  if (existing !== null) {
    process.stderr.write(`[neuromcp] Model already present at ${existing}, skipping download.\n`);
    return;
  }

  const targetDir = chooseTargetDir();
  const target = resolve(targetDir, MODEL_FILENAME);
  mkdirSync(targetDir, { recursive: true });
  process.stderr.write(`[neuromcp] Downloading bge-small-en-v1.5 ONNX model (~33MB) to ${target}...\n`);

  const response = await fetch(MODEL_URL);
  if (!response.ok || !response.body) {
    process.stderr.write(
      `[neuromcp] Download failed: ${response.status}. Retry with: npx neuromcp-download-model\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Temp file + rename: a killed download never leaves a truncated model.
  const tmp = `${target}.part-${process.pid}`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp));
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
  process.stderr.write(`[neuromcp] Model downloaded: ${target}\n`);
  process.stderr.write('[neuromcp] ★ If neuromcp is useful, star us: https://github.com/AdelElo13/neuromcp\n');
}

main().catch((err) => {
  process.stderr.write(
    `[neuromcp] Model download failed: ${err instanceof Error ? err.message : String(err)}\n` +
      '[neuromcp] The server downloads it lazily on first use, or run: npx neuromcp-download-model\n',
  );
  process.exitCode = 1;
});
