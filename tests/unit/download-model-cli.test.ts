import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// @ts-expect-error — plain-ESM CLI in scripts/, no type declarations shipped
import { resolveExistingModel, chooseTargetDir } from '../../scripts/download-model.mjs';

/**
 * Codex round-7 [P2]: `neuromcp-download-model` checked the DEFAULT user
 * cache for an existing model before applying the NEUROMCP_MODEL_DIR
 * override — with the override set and the model only in the default
 * cache it printed "already present" and exited 0, while the runtime
 * (whose override REPLACES the default cache) saw nothing. The recovery
 * command the docs recommend must use the runtime's own search rules.
 */
describe('neuromcp-download-model — override-aware existence check', () => {
  it('does NOT count a model in the default cache when NEUROMCP_MODEL_DIR is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nmcp-dl-'));
    try {
      const defaultCache = join(dir, 'default-cache');
      const override = join(dir, 'override');
      mkdirSync(defaultCache, { recursive: true });
      mkdirSync(override, { recursive: true });
      writeFileSync(join(defaultCache, 'bge-small-en-v1.5.onnx'), 'stub');

      const found = resolveExistingModel(
        { NEUROMCP_MODEL_DIR: override },
        { userModelDir: defaultCache, packageModelDir: join(dir, 'empty-pkg') },
      );
      expect(found).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds the model in the override dir, and in the default cache without an override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nmcp-dl-'));
    try {
      const defaultCache = join(dir, 'default-cache');
      const override = join(dir, 'override');
      mkdirSync(defaultCache, { recursive: true });
      mkdirSync(override, { recursive: true });
      writeFileSync(join(override, 'bge-small-en-v1.5.onnx'), 'stub');
      writeFileSync(join(defaultCache, 'bge-small-en-v1.5.onnx'), 'stub');

      const pkg = join(dir, 'empty-pkg');
      expect(
        resolveExistingModel({ NEUROMCP_MODEL_DIR: override }, { userModelDir: defaultCache, packageModelDir: pkg }),
      ).toBe(join(override, 'bge-small-en-v1.5.onnx'));
      expect(resolveExistingModel({}, { userModelDir: defaultCache, packageModelDir: pkg })).toBe(
        join(defaultCache, 'bge-small-en-v1.5.onnx'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('chooseTargetDir still prefers the override', () => {
    expect(chooseTargetDir({ NEUROMCP_MODEL_DIR: '/custom' })).toBe('/custom');
  });

  it('IMPORTING the script performs no I/O — main() only runs when invoked as the CLI', async () => {
    // Codex round-8 [P2]: the script ran main() unconditionally at module
    // load, so merely importing it (this very test file!) could start a
    // real 33MB download, write model paths and flip process.exitCode.
    // The bin/ entrypoints solved this with the symlink-safe isMainModule
    // guard; the script must use the same one.
    const before = process.exitCode;
    // Import already happened at the top of this file; a triggered main()
    // would have set exitCode on failure or logged a download. Assert the
    // guard exists structurally AND that exitCode is untouched.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../scripts/download-model.mjs', import.meta.url), 'utf8');
    expect(source).toMatch(/isMainModule\(import\.meta\.url\)/);
    expect(source).not.toMatch(/^main\(\)\.catch/m);
    expect(process.exitCode).toBe(before);
  });
});
