import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  providerAcceptable,
  staticOnnxSkipReason,
} from '../../src/embeddings/factory.js';
import { downloadModel } from '../../src/embeddings/model-cache.js';

/**
 * v0.29.3 review round 2 — selection must respect the STORED MODEL as well
 * as the index width, and must never start an unbounded model download for
 * a provider that can be ruled out statically.
 *
 * Codex findings this pins:
 *  - [P2] a same-width model conflict stopped the cascade instead of trying
 *    the next candidate (runtime degraded even though the RIGHT provider
 *    was reachable) — providerAcceptable gains requireModel;
 *  - [P2] the ONNX probe could trigger a ~33 MB lazy download even when its
 *    fixed 384 width can never match the existing index, delaying the
 *    degraded start past client timeouts — staticOnnxSkipReason rules it
 *    out before any I/O, and downloadModel gets an explicit deadline.
 */

describe('providerAcceptable', () => {
  const fake = (name: string, dimensions: number) =>
    ({ name, dimensions }) as { name: string; dimensions: number };

  it('accepts when no requirements are set', () => {
    expect(providerAcceptable(fake('anything', 512), {})).toEqual({ ok: true });
  });

  it('rejects a width mismatch with the width in the reason', () => {
    const verdict = providerAcceptable(fake('bge-small-en-v1.5', 384), { requireDimension: 768 });
    expect(verdict.ok).toBe(false);
    expect(String((verdict as { reason: string }).reason)).toMatch(/384/);
    expect(String((verdict as { reason: string }).reason)).toMatch(/768/);
  });

  it('rejects a model mismatch at the same width — vectors of another model are noise', () => {
    const verdict = providerAcceptable(fake('all-minilm', 384), {
      requireDimension: 384,
      requireModel: 'bge-small-en-v1.5',
    });
    expect(verdict.ok).toBe(false);
    expect(String((verdict as { reason: string }).reason)).toMatch(/bge-small-en-v1\.5/);
  });

  it('accepts when both width and model match', () => {
    expect(
      providerAcceptable(fake('bge-small-en-v1.5', 384), {
        requireDimension: 384,
        requireModel: 'bge-small-en-v1.5',
      }),
    ).toEqual({ ok: true });
  });
});

describe('staticOnnxSkipReason', () => {
  it('skips ONNX without probing when the index width can never match', () => {
    const reason = staticOnnxSkipReason({ requireDimension: 768 });
    expect(reason).toMatch(/384/);
    expect(reason).toMatch(/without probing|skipped/i);
  });

  it('skips ONNX without probing when the stored model is not the ONNX model', () => {
    const reason = staticOnnxSkipReason({ requireDimension: 384, requireModel: 'all-minilm' });
    expect(reason).toMatch(/all-minilm|model/);
  });

  it('does not skip when ONNX could match', () => {
    expect(staticOnnxSkipReason({ requireDimension: 384 })).toBeNull();
    expect(staticOnnxSkipReason({})).toBeNull();
    expect(
      staticOnnxSkipReason({ requireDimension: 384, requireModel: 'bge-small-en-v1.5' }),
    ).toBeNull();
  });
});

describe('downloadModel deadline', () => {
  it('passes an abort signal that fires after timeoutMs — a hung download cannot block startup forever', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neuromcp-dl-'));
    try {
      const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          expect(init?.signal, 'downloadModel must pass an AbortSignal to fetch').toBeDefined();
          init!.signal!.addEventListener('abort', () => reject(new Error('download aborted by deadline')));
        })) as unknown as typeof fetch;

      await expect(
        downloadModel(dir, { fetchImpl, timeoutMs: 50, stderr: { write: () => undefined } }),
      ).rejects.toThrow(/abort/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
