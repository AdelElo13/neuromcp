/**
 * v0.29.3 — the ONNX fallback model must not depend on an install script.
 *
 * Verified against a real `npm install -g neuromcp@0.29.2` on npm 11.12.1:
 *   - npm 11's `ignore-scripts` default is FALSE, so a plain install does run
 *     the postinstall (there is no `--allow-scripts` flag in npm at all),
 *   - but with `--ignore-scripts` (hardened .npmrc, CI policy, pnpm's build
 *     allowlist) the package installs fine and `models/` is simply never
 *     created — the server then reported "no embedding route at all".
 *   - a root-owned global prefix is also not writable by the user who later
 *     runs the server, so the package-local models/ dir cannot be used.
 *
 * Fix under test: resolve from a per-user cache dir first, and download
 * lazily at first use (with an explicit opt-out).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import {
  MODEL_FILENAME,
  userModelDir,
  modelSearchPaths,
  findModel,
  downloadsDisabled,
  ensureModel,
  downloadModel,
} from '../../src/embeddings/model-cache.js';

describe('model-cache', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'neuromcp-model-cache-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('defaults the user model dir to ~/.neuromcp/models and honours NEUROMCP_MODEL_DIR', () => {
    expect(userModelDir({}, '/home/x')).toBe('/home/x/.neuromcp/models');
    expect(userModelDir({ NEUROMCP_MODEL_DIR: '/models' }, '/home/x')).toBe('/models');
  });

  it('looks in the user dir BEFORE the package dir (global installs are read-only)', () => {
    const paths = modelSearchPaths('/pkg/dist', {}, '/home/x', '/work');
    expect(paths[0]).toBe(`/home/x/.neuromcp/models/${MODEL_FILENAME}`);
    expect(paths).toContain(`/pkg/models/${MODEL_FILENAME}`);
  });

  it('finds a model that only exists in the user dir', () => {
    const dir = join(home, '.neuromcp', 'models');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, MODEL_FILENAME);
    writeFileSync(file, 'not-a-real-model');

    expect(findModel('/pkg/dist', { env: {}, home, cwd: '/nowhere' })).toBe(file);
  });

  it('returns null and explains itself when the model is missing and downloads are disabled', async () => {
    const stderr = { out: '', write(s: string) { this.out += s; return true; } };
    const result = await ensureModel('/pkg/dist', {
      env: { NEUROMCP_DISABLE_MODEL_DOWNLOAD: '1' },
      home,
      cwd: '/nowhere',
      stderr,
    });
    expect(result).toBeNull();
    expect(stderr.out).toMatch(/neuromcp-download-model/);
    expect(downloadsDisabled({ NEUROMCP_DISABLE_MODEL_DOWNLOAD: '1' })).toBe(true);
    expect(downloadsDisabled({})).toBe(false);
  });

  it('downloads lazily into the user dir on first use', async () => {
    const payload = Buffer.from('fake-onnx-bytes');
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: Readable.toWeb(Readable.from([payload])),
    });
    const stderr = { out: '', write(s: string) { this.out += s; return true; } };

    const result = await ensureModel('/pkg/dist', { env: {}, home, cwd: '/nowhere', fetchImpl, stderr });

    const expected = join(home, '.neuromcp', 'models', MODEL_FILENAME);
    expect(result).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, 'utf8')).toBe('fake-onnx-bytes');
    expect(stderr.out).toMatch(/downloading/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never leaves a truncated model behind when the download fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, body: null });
    const dir = join(home, 'models');
    await expect(downloadModel(dir, { fetchImpl, stderr: { write: () => true } })).rejects.toThrow(/503/);
    expect(existsSync(join(dir, MODEL_FILENAME))).toBe(false);
  });

  it('ensureModel swallows a failed download (the provider just stays unavailable)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENOTFOUND huggingface.co'));
    const stderr = { out: '', write(s: string) { this.out += s; return true; } };
    const result = await ensureModel('/pkg/dist', { env: {}, home, cwd: '/nowhere', fetchImpl, stderr });
    expect(result).toBeNull();
    expect(stderr.out).toMatch(/ENOTFOUND/);
  });
});
