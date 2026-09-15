import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// @ts-expect-error — plain-ESM helper in bin/, no type declarations shipped
import {
  resolveDaemonPort,
  checkDaemon,
  checkOllama,
  checkOnnxModel,
  checkDatabase,
  checkBetterSqlite,
  checkEmbeddingIndex,
  deriveEmbeddingRoute,
  aggregateExitCode,
  terminateChild,
  runAuditNetwork,
} from '../../bin/doctor.mjs';

/**
 * DX-review upgrade: bin/doctor.mjs used to be a surface-level check
 * (path-existence for better-sqlite3, no daemon/Ollama/ONNX/db probes).
 * These tests pin the real triage behavior:
 *  - daemon /health probe (port from NEUROMCP_DAEMON_PORT, default 3200)
 *  - Ollama /api/tags probe + nomic-embed-text presence
 *  - ONNX fallback model presence (scripts/download-model.mjs target path)
 *  - DB open-read-only check, skipped cleanly when better-sqlite3 won't load
 *  - exit-code aggregation: 0 = all ok, 1 = warnings, 2 = broken
 */

function jsonResponse(body: unknown, ok = true): Promise<Response> {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

describe('resolveDaemonPort', () => {
  it('defaults to 3200 when NEUROMCP_DAEMON_PORT is unset', () => {
    expect(resolveDaemonPort({})).toBe(3200);
  });

  it('honours NEUROMCP_DAEMON_PORT from the environment', () => {
    expect(resolveDaemonPort({ NEUROMCP_DAEMON_PORT: '33200' })).toBe(33200);
  });

  it('falls back to the default on a non-numeric port', () => {
    expect(resolveDaemonPort({ NEUROMCP_DAEMON_PORT: 'abc' })).toBe(3200);
  });
});

describe('checkDaemon', () => {
  it('reports ok with the daemon version when /health answers', async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      jsonResponse({ status: 'ok', version: '0.26.0' }));
    const result = await checkDaemon({ fetchImpl, env: {} });
    expect(result.status).toBe('ok');
    expect(result.info).toContain('0.26.0');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:3200/health',
      expect.anything(),
    );
  });

  it('probes the port from NEUROMCP_DAEMON_PORT', async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      jsonResponse({ status: 'ok', version: '0.26.0' }));
    await checkDaemon({ fetchImpl, env: { NEUROMCP_DAEMON_PORT: '33200' } });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:33200/health',
      expect.anything(),
    );
  });

  it('warns (not fails) when the daemon is unreachable, with a launchctl hint on darwin', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkDaemon({ fetchImpl, env: {}, osPlatform: 'darwin' });
    expect(result.status).toBe('warn');
    expect(result.info).toContain('optional');
    expect(result.info).toContain('launchctl print gui/$(id -u)/com.neuromcp.daemon');
  });

  it('omits the launchctl hint on non-darwin platforms', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkDaemon({ fetchImpl, env: {}, osPlatform: 'linux' });
    expect(result.status).toBe('warn');
    expect(result.info).not.toContain('launchctl');
  });

  it('warns when the probe times out (AbortError)', async () => {
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    const fetchImpl = vi.fn().mockRejectedValue(abort);
    const result = await checkDaemon({ fetchImpl, env: {} });
    expect(result.status).toBe('warn');
  });
});

describe('checkOllama — probes the CONFIGURED model and measures its dimension', () => {
  // Codex round-3 [P2]: the old check only proved nomic-embed-text exists
  // and hardcoded 768d; with NEUROMCP_EMBEDDING_MODEL set to a custom model
  // the doctor presented the nomic probe as evidence for a model it never
  // checked. The check now returns { result, probe } where probe carries
  // the configured model plus its MEASURED dimension.
  function tagsThenEmbed(models: string[], dims: number) {
    return vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/api/tags')) {
        return jsonResponse({ models: models.map((name) => ({ name })) });
      }
      return jsonResponse({ embeddings: [Array.from({ length: dims }, () => 0.1)] });
    });
  }

  it('reports ok with the MEASURED dimension when the default model is installed', async () => {
    const fetchImpl = tagsThenEmbed(['nomic-embed-text:latest', 'llama3.2:3b'], 768);
    const { result, probe } = await checkOllama({ fetchImpl, env: {} });
    expect(result.status).toBe('ok');
    expect(probe).toEqual({ model: 'nomic-embed-text', dimensions: 768 });
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:11434/api/tags', expect.anything());
  });

  it('probes the model from NEUROMCP_EMBEDDING_MODEL, not nomic, and measures ITS width', async () => {
    const fetchImpl = tagsThenEmbed(['all-minilm:latest'], 384);
    const { result, probe } = await checkOllama({
      fetchImpl,
      env: { NEUROMCP_EMBEDDING_MODEL: 'all-minilm' },
    });
    expect(result.status).toBe('ok');
    expect(probe).toEqual({ model: 'all-minilm', dimensions: 384 });
    expect(result.info).toContain('all-minilm');
    expect(result.info).toContain('384');
  });

  it('warns (probe null) when the CONFIGURED model is missing, even though nomic is present', async () => {
    const fetchImpl = tagsThenEmbed(['nomic-embed-text:latest'], 768);
    const { result, probe } = await checkOllama({
      fetchImpl,
      env: { NEUROMCP_EMBEDDING_MODEL: 'all-minilm' },
    });
    expect(result.status).toBe('warn');
    expect(probe).toBeNull();
    expect(result.info).toContain('ollama pull all-minilm');
  });

  it('honours OLLAMA_HOST from the environment', async () => {
    const fetchImpl = tagsThenEmbed(['nomic-embed-text'], 768);
    await checkOllama({ fetchImpl, env: { OLLAMA_HOST: 'http://10.0.0.5:11434' } });
    expect(fetchImpl).toHaveBeenCalledWith('http://10.0.0.5:11434/api/tags', expect.anything());
  });

  it('accepts a fully-TAGGED configured model against the same listed tag', async () => {
    // Codex round-4 [P2]: `listed.split(':')[0] === configured` can never
    // match a configured value that itself carries a tag — the doctor
    // failed a setup the runtime accepts.
    const fetchImpl = tagsThenEmbed(['all-minilm:latest'], 384);
    const { result, probe } = await checkOllama({
      fetchImpl,
      env: { NEUROMCP_EMBEDDING_MODEL: 'all-minilm:latest' },
    });
    expect(result.status).toBe('ok');
    expect(probe).toEqual({ model: 'all-minilm:latest', dimensions: 384 });
  });

  it('does NOT match a different tag of the same base model', async () => {
    const fetchImpl = tagsThenEmbed(['all-minilm:latest'], 384);
    const { result, probe } = await checkOllama({
      fetchImpl,
      env: { NEUROMCP_EMBEDDING_MODEL: 'all-minilm:v2' },
    });
    expect(result.status).toBe('warn');
    expect(probe).toBeNull();
    expect(result.info).toContain('ollama pull all-minilm:v2');
  });

  it('an UNTAGGED config means :latest — a different listed tag is NOT a match', async () => {
    // Codex round-5 [P3]: `ollama run all-minilm` resolves to :latest
    // specifically; the runtime's embed probe fails when only :v2 is
    // pulled. The doctor accepting any tag reported UNVERIFIED where the
    // truthful diagnosis is "model missing, pull it".
    const fetchImpl = tagsThenEmbed(['all-minilm:v2'], 384);
    const { result, probe } = await checkOllama({
      fetchImpl,
      env: { NEUROMCP_EMBEDDING_MODEL: 'all-minilm' },
    });
    expect(result.status).toBe('warn');
    expect(probe).toBeNull();
    expect(result.info).toContain('ollama pull all-minilm');
  });

  it('reports the model as UNVERIFIED (dimensions null) when the embed probe fails — not as absent', async () => {
    // Codex round-4 [P2]: a slow model (cold load) blew the 2s probe budget
    // and the doctor concluded "no embedding route" (exit 2) while the
    // runtime, with its 30s budget, matched fine. A listed model whose
    // width cannot be measured is UNVERIFIED, not missing.
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/api/tags')) {
        return jsonResponse({ models: [{ name: 'nomic-embed-text:latest' }] });
      }
      const err = new Error('timeout');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const { result, probe } = await checkOllama({ fetchImpl, env: {} });
    expect(result.status).toBe('warn');
    expect(probe).toEqual({ model: 'nomic-embed-text', dimensions: null });
    expect(result.info).toMatch(/verify|unverified/i);
  });

  it('warns with a pull hint when Ollama runs but the model is missing', async () => {
    const fetchImpl = tagsThenEmbed(['llama3.2:3b'], 768);
    const { result, probe } = await checkOllama({ fetchImpl, env: {} });
    expect(result.status).toBe('warn');
    expect(probe).toBeNull();
    expect(result.info).toContain('ollama pull nomic-embed-text');
    expect(result.info).toContain('ONNX');
  });

  it('warns about the ONNX 384d fallback when Ollama is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const { result, probe } = await checkOllama({ fetchImpl, env: {} });
    expect(result.status).toBe('warn');
    expect(probe).toBeNull();
    expect(result.info).toContain('ONNX');
    expect(result.info).toContain('384');
  });
});

describe('checkOnnxModel', () => {
  it('NEUROMCP_MODEL_DIR REPLACES the default user cache — runtime parity, not augmentation', () => {
    // Codex round-6 [P2]: the runtime's userModelDir() returns the
    // override INSTEAD OF ~/.neuromcp/models. A doctor that still finds a
    // model in the default cache reports a route the runtime cannot see.
    const exists = vi
      .fn()
      .mockImplementation((p: string) => String(p) === '/home/x/.neuromcp/models/bge-small-en-v1.5.onnx');
    const result = checkOnnxModel({
      exists,
      env: { NEUROMCP_MODEL_DIR: '/custom/models' },
      userModelPath: '/home/x/.neuromcp/models/bge-small-en-v1.5.onnx',
      modelPath: '/nonexistent/pkg/models/bge-small-en-v1.5.onnx',
    });
    // Default user cache has the file, but the runtime will not look there
    // with the override set — and the package path does not exist either.
    expect(exists).not.toHaveBeenCalledWith('/home/x/.neuromcp/models/bge-small-en-v1.5.onnx');
    expect(result.status).toBe('warn');
    // The message must name the path that was actually searched (the
    // override), not the default cache it deliberately skipped.
    expect(result.info).toContain('/custom/models');
    expect(result.info).not.toContain('/home/x/.neuromcp/models');
  });

  it('honours NEUROMCP_MODEL_DIR — the runtime resolves the model there first', () => {
    // Codex round-5 [P2]: the doctor only looked at the default user dir
    // and the package dir; a model that lives only in the configured
    // custom dir made a WORKING install look route-less.
    const exists = vi.fn().mockImplementation((p: string) => String(p).startsWith('/custom/models'));
    const result = checkOnnxModel({
      exists,
      env: { NEUROMCP_MODEL_DIR: '/custom/models' },
    });
    expect(result.status).toBe('ok');
    expect(result.info).toContain('/custom/models');
  });

  it('reports ok when the fallback model file exists', () => {
    const exists = vi.fn().mockReturnValue(true);
    const result = checkOnnxModel({ exists });
    expect(result.status).toBe('ok');
    expect(exists).toHaveBeenCalledWith(expect.stringContaining('bge-small-en-v1.5.onnx'));
  });

  it('warns with a download hint when the model is absent', () => {
    const exists = vi.fn().mockReturnValue(false);
    const result = checkOnnxModel({ exists });
    expect(result.status).toBe('warn');
    expect(result.info).toContain('node scripts/download-model.mjs');
  });
});

describe('checkBetterSqlite — must exercise the NATIVE binding, not just the JS module', () => {
  // Codex round-2 [P2]: importing better-sqlite3 succeeds even when the
  // native binding is missing (`--ignore-scripts` install) — the binding
  // only loads when a Database is constructed. The check has to construct
  // one, or exactly the documented failure mode gets diagnosed as healthy.
  it('constructs (and closes) a :memory: database as the smoke test', async () => {
    const constructed: string[] = [];
    const close = vi.fn();
    class FakeDb {
      constructor(path: string) { constructed.push(path); }
      close(): void { close(); }
    }
    const { result, Database } = await checkBetterSqlite({
      loadModule: () => Promise.resolve({ default: FakeDb }),
    });
    expect(result.status).toBe('ok');
    expect(constructed).toContain(':memory:');
    expect(close).toHaveBeenCalled();
    expect(Database).toBe(FakeDb);
  });

  it('fails when the module imports but the native binding refuses to construct', async () => {
    class BrokenDb {
      constructor() { throw new Error('Could not locate the bindings file'); }
    }
    const { result, Database } = await checkBetterSqlite({
      loadModule: () => Promise.resolve({ default: BrokenDb }),
    });
    expect(result.status).toBe('fail');
    expect(result.info).toMatch(/bindings/i);
    expect(Database).toBeNull();
  });
});

describe('checkEmbeddingIndex — must apply the same rules as the runtime', () => {
  // Fake Database whose prepare() routes on the SQL text: the vec-table DDL
  // lookup and the stored-model aggregation are the two queries the check runs.
  function fakeDbFor(indexDim: number | null, storedModels: Array<{ embedding_model: string; n: number }>) {
    return class {
      prepare(sql: string) {
        if (sql.includes('sqlite_master')) {
          return {
            get: () =>
              indexDim === null
                ? undefined
                : { sql: `CREATE VIRTUAL TABLE memories_vec USING vec0(id TEXT, embedding float[${indexDim}])` },
          };
        }
        return { all: () => storedModels, get: () => undefined };
      }
      close(): void { /* noop */ }
    };
  }
  const ok = { status: 'ok' } as const;
  const NOMIC = { model: 'nomic-embed-text', dimensions: 768 } as const;
  const baseDeps = { exists: () => true, home: '/home/x' };

  it('reports matched when a reachable default provider fits width and stored model', () => {
    const result = checkEmbeddingIndex({
      ...baseDeps,
      Database: fakeDbFor(384, [{ embedding_model: 'bge-small-en-v1.5', n: 5 }]),
      ollamaProbe: NOMIC,
      onnxResult: ok,
      env: {},
    });
    expect(result.status).toBe('ok');
    expect(result.info).toMatch(/onnx|bge/i);
  });

  it('does NOT count ONNX as a match when NEUROMCP_EMBEDDING_PROVIDER=ollama excludes it', () => {
    // Codex round-2 [P2]: with an explicit provider the runtime will never
    // select ONNX — a doctor that still says "matched by onnx" declares a
    // degraded configuration healthy.
    const result = checkEmbeddingIndex({
      ...baseDeps,
      Database: fakeDbFor(384, [{ embedding_model: 'bge-small-en-v1.5', n: 5 }]),
      ollamaProbe: NOMIC,
      onnxResult: ok,
      env: { NEUROMCP_EMBEDDING_PROVIDER: 'ollama' },
    });
    expect(result.status).toBe('fail');
    expect(result.info).toMatch(/ollama/i);
  });

  it('fails on a stored-model mismatch even when the width matches', () => {
    const result = checkEmbeddingIndex({
      ...baseDeps,
      Database: fakeDbFor(768, [{ embedding_model: 'some-custom-768d-model', n: 9 }]),
      ollamaProbe: NOMIC,
      onnxResult: ok,
      env: {},
    });
    expect(result.status).toBe('fail');
    expect(result.info).toMatch(/model/i);
    expect(result.info).toMatch(/some-custom-768d-model/);
  });

  it('fails on MIXED stored models — one matching model does not make the others compatible', () => {
    // Codex round-3 [P2]: `some()` accepted the database as soon as ONE
    // stored model matched; the runtime refuses when ANY foreign model is
    // present. Doctor must apply the runtime's rule (every, not some).
    const result = checkEmbeddingIndex({
      ...baseDeps,
      Database: fakeDbFor(768, [
        { embedding_model: 'nomic-embed-text', n: 100 },
        { embedding_model: 'other-model', n: 3 },
      ]),
      ollamaProbe: NOMIC,
      onnxResult: ok,
      env: {},
    });
    expect(result.status).toBe('fail');
    expect(result.info).toMatch(/other-model/);
  });

  it('accepts mixed stored models when NEUROMCP_ALLOW_EMBEDDING_MODEL_MIX=1 — runtime parity', () => {
    const result = checkEmbeddingIndex({
      ...baseDeps,
      Database: fakeDbFor(768, [
        { embedding_model: 'nomic-embed-text', n: 100 },
        { embedding_model: 'other-model', n: 3 },
      ]),
      ollamaProbe: NOMIC,
      onnxResult: ok,
      env: { NEUROMCP_ALLOW_EMBEDDING_MODEL_MIX: '1' },
    });
    expect(result.status).toBe('ok');
  });

  it('uses the MEASURED Ollama dimension: a custom 384d model matches a 384d index', () => {
    // Codex round-3 [P2]: the doctor hardcoded ollama=768d, failing a
    // perfectly matched custom-model setup that the runtime accepts.
    const result = checkEmbeddingIndex({
      ...baseDeps,
      Database: fakeDbFor(384, [{ embedding_model: 'all-minilm', n: 7 }]),
      ollamaProbe: { model: 'all-minilm', dimensions: 384 },
      onnxResult: { status: 'warn' },
      env: { NEUROMCP_EMBEDDING_PROVIDER: 'ollama', NEUROMCP_EMBEDDING_MODEL: 'all-minilm' },
    });
    expect(result.status).toBe('ok');
    expect(result.info).toMatch(/all-minilm/);
  });

  it('treats a null ollamaProbe as "not eligible" — a nomic probe is no evidence for a custom model', () => {
    const result = checkEmbeddingIndex({
      ...baseDeps,
      Database: fakeDbFor(384, [{ embedding_model: 'all-minilm', n: 7 }]),
      ollamaProbe: null,
      onnxResult: { status: 'warn' },
      env: { NEUROMCP_EMBEDDING_PROVIDER: 'ollama', NEUROMCP_EMBEDDING_MODEL: 'all-minilm' },
    });
    expect(result.status).toBe('fail');
  });

  it('an unverified candidate whose KNOWN MODEL is already incompatible does NOT soften the verdict', () => {
    // Codex round-6 [P2]: stored all-minilm, measured ONNX bge (mismatch),
    // unverified Ollama candidate is nomic-embed-text — its NAME already
    // rules it out regardless of width, so "the runtime may still match"
    // is false and the honest verdict is the hard model-mismatch fail.
    const result = checkEmbeddingIndex({
      ...baseDeps,
      Database: fakeDbFor(384, [{ embedding_model: 'all-minilm', n: 7 }]),
      ollamaProbe: { model: 'nomic-embed-text', dimensions: null },
      onnxResult: ok,
      env: {},
    });
    expect(result.status).toBe('fail');
    expect(result.info).toMatch(/model/i);
  });

  it('UNVERIFIED outranks a measured model-mismatch fail — uncertainty must soften the verdict', () => {
    // Codex round-5 [P2]: a measured same-width wrong-model candidate
    // (ONNX bge on an all-minilm index) returned FAIL before the
    // unverified branch was reached — while the unverified Ollama probe
    // could be exactly the matching model.
    const result = checkEmbeddingIndex({
      ...baseDeps,
      Database: fakeDbFor(384, [{ embedding_model: 'all-minilm', n: 7 }]),
      ollamaProbe: { model: 'all-minilm', dimensions: null },
      onnxResult: ok,
      env: {},
    });
    expect(result.status).toBe('warn');
    expect(result.info).toMatch(/unverified|verify/i);
  });

  it('an explicit OpenAI-compatible CUSTOM model name is preserved, mirroring the factory rule', () => {
    // Codex round-7 [P2]: the doctor replaced any non-text-embedding-*
    // name with text-embedding-3-small; the factory keeps an explicit
    // model as-is when the provider is explicitly openai — the runtime
    // matched 'custom-embedding' at 1536d while the doctor failed it.
    const result = checkEmbeddingIndex({
      ...baseDeps,
      Database: fakeDbFor(1536, [{ embedding_model: 'custom-embedding', n: 4 }]),
      ollamaProbe: null,
      onnxResult: { status: 'warn' },
      env: {
        NEUROMCP_EMBEDDING_PROVIDER: 'openai',
        NEUROMCP_EMBEDDING_MODEL: 'custom-embedding',
        OPENAI_API_KEY: 'sk-test',
      },
    });
    expect(result.status).toBe('warn');
    expect(result.info).toContain('custom-embedding');
  });

  it('an explicitly requested OpenAI provider is UNVERIFIABLE, not a proven mismatch', () => {
    // Codex round-5 [P2]: the runtime can match text-embedding-3-small
    // (1536d) while the doctor, which never probes OpenAI, declared
    // DIMENSION MISMATCH with reembed advice. Unverifiable ≠ mismatched.
    const result = checkEmbeddingIndex({
      ...baseDeps,
      Database: fakeDbFor(1536, [{ embedding_model: 'text-embedding-3-small', n: 4 }]),
      ollamaProbe: null,
      onnxResult: { status: 'warn' },
      env: { NEUROMCP_EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' },
    });
    expect(result.status).toBe('warn');
    expect(result.info).toMatch(/openai/i);
    expect(result.info).toMatch(/unverified|verify|cannot/i);
  });

  it('warns (not fail) when the only candidate is listed but its dimension is UNVERIFIED', () => {
    // Codex round-4 [P2]: an unmeasured width is not proof of a mismatch.
    // The runtime may still match with its own (longer) embed budget, so
    // concluding "broken, exit 2" here is a misdiagnosis.
    const result = checkEmbeddingIndex({
      ...baseDeps,
      Database: fakeDbFor(768, [{ embedding_model: 'nomic-embed-text', n: 5 }]),
      ollamaProbe: { model: 'nomic-embed-text', dimensions: null },
      onnxResult: { status: 'warn' },
      env: {},
    });
    expect(result.status).toBe('warn');
    expect(result.info).toMatch(/unverified|verify/i);
    expect(result.info).toMatch(/nomic-embed-text/);
  });
});

describe('deriveEmbeddingRoute — reports the MEASURED route, not a hardcoded one', () => {
  it('an UNVERIFIED ollama probe without ONNX is a warn, NOT "no embedding route" (exit 2)', () => {
    // Codex round-5 [P2]: checkEmbeddingIndex learned to warn on an
    // unverified probe, but THIS check still concluded "no embedding
    // route at all — fail", dragging the aggregate exit code back to 2.
    const result = deriveEmbeddingRoute(
      { status: 'warn' },
      { status: 'warn' },
      { model: 'nomic-embed-text', dimensions: null },
      {},
    );
    expect(result.status).toBe('warn');
    expect(result.info).toMatch(/unverified|verify/i);
    expect(result.info).toMatch(/nomic-embed-text/);
  });

  it('still fails when there is truly no route at all (no probe, no ONNX)', () => {
    const result = deriveEmbeddingRoute({ status: 'warn' }, { status: 'warn' }, null, {});
    expect(result.status).toBe('fail');
  });

  it('an explicit provider FILTERS the route — ONNX does not count under NEUROMCP_EMBEDDING_PROVIDER=ollama', () => {
    // Codex round-7 [P2]: explicit ollama + Ollama down + ONNX present
    // reported "route ok: ONNX fallback", while the runtime with an
    // explicit provider refuses to fall back and errors out.
    const result = deriveEmbeddingRoute({ status: 'warn' }, { status: 'ok' }, null, {
      NEUROMCP_EMBEDDING_PROVIDER: 'ollama',
    });
    expect(result.status).toBe('fail');
    expect(result.info).toMatch(/ollama/i);
    expect(result.info).not.toMatch(/fallback only/i);
  });

  it('symmetrically: Ollama does not count under NEUROMCP_EMBEDDING_PROVIDER=onnx', () => {
    const result = deriveEmbeddingRoute({ status: 'ok' }, { status: 'warn' }, { model: 'nomic-embed-text', dimensions: 768 }, {
      NEUROMCP_EMBEDDING_PROVIDER: 'onnx',
    });
    expect(result.status).toBe('fail');
    expect(result.info).toMatch(/onnx/i);
  });

  it('an OpenAI-eligible configuration is a warn route, not "no embedding route" (exit 2)', () => {
    // Codex round-6 [P2]: checkEmbeddingIndex learned OpenAI, but the
    // route summary still failed a runtime-matched openai setup.
    const explicit = deriveEmbeddingRoute({ status: 'warn' }, { status: 'warn' }, null, {
      NEUROMCP_EMBEDDING_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test',
    });
    expect(explicit.status).toBe('warn');
    expect(explicit.info).toMatch(/openai/i);

    const auto = deriveEmbeddingRoute({ status: 'warn' }, { status: 'warn' }, null, {
      OPENAI_API_KEY: 'sk-test',
    });
    expect(auto.status).toBe('warn');

    // Without a key, auto cannot reach OpenAI either — fail stands.
    const noKey = deriveEmbeddingRoute({ status: 'warn' }, { status: 'warn' }, null, {});
    expect(noKey.status).toBe('fail');
  });

  it('names the measured model and width when a probe is available', () => {
    // Codex round-4 [P3]: with a measured all-minilm 384d the summary
    // still claimed "ollama nomic-embed-text 768d".
    const result = deriveEmbeddingRoute(
      { status: 'ok' },
      { status: 'warn' },
      { model: 'all-minilm', dimensions: 384 },
      {},
    );
    expect(result.status).toBe('ok');
    expect(result.info).toContain('all-minilm');
    expect(result.info).toContain('384');
    expect(result.info).not.toContain('768');
  });
});

describe('checkDatabase', () => {
  it('skips cleanly when better-sqlite3 itself did not load', () => {
    const result = checkDatabase({ Database: null, env: {}, exists: vi.fn() });
    expect(result.status).toBe('skip');
    expect(result.info).toContain('better-sqlite3');
  });

  it('reports ok when the db opens read-only and passes quick_check', () => {
    const close = vi.fn();
    const pragma = vi.fn().mockReturnValue([{ quick_check: 'ok' }]);
    const Database = vi.fn().mockImplementation(() => ({ pragma, close }));
    const result = checkDatabase({
      Database,
      env: { NEUROMCP_DB_PATH: '/tmp/x/memory.db' },
      exists: vi.fn().mockReturnValue(true),
    });
    expect(result.status).toBe('ok');
    expect(Database).toHaveBeenCalledWith('/tmp/x/memory.db', expect.objectContaining({ readonly: true }));
    expect(close).toHaveBeenCalled();
  });

  it('reports ok (not created yet) when the db file does not exist', () => {
    const Database = vi.fn();
    const result = checkDatabase({
      Database,
      env: {},
      exists: vi.fn().mockReturnValue(false),
    });
    expect(result.status).toBe('ok');
    expect(result.info).toContain('first run');
    expect(Database).not.toHaveBeenCalled();
  });

  it('fails when better-sqlite3 cannot open the db', () => {
    const Database = vi.fn().mockImplementation(() => {
      throw new Error('file is not a database');
    });
    const result = checkDatabase({
      Database,
      env: { NEUROMCP_DB_PATH: '/tmp/x/memory.db' },
      exists: vi.fn().mockReturnValue(true),
    });
    expect(result.status).toBe('fail');
    expect(result.info).toContain('file is not a database');
  });

  it('fails when quick_check reports corruption', () => {
    const close = vi.fn();
    const pragma = vi.fn().mockReturnValue([{ quick_check: 'row 12 missing from index' }]);
    const Database = vi.fn().mockImplementation(() => ({ pragma, close }));
    const result = checkDatabase({
      Database,
      env: { NEUROMCP_DB_PATH: '/tmp/x/memory.db' },
      exists: vi.fn().mockReturnValue(true),
    });
    expect(result.status).toBe('fail');
    expect(close).toHaveBeenCalled();
  });
});

describe('deriveEmbeddingRoute', () => {
  it('is ok when Ollama works', () => {
    const result = deriveEmbeddingRoute({ status: 'ok' }, { status: 'warn' }, null, {});
    expect(result.status).toBe('ok');
  });

  it('is ok when only the ONNX fallback is available', () => {
    const result = deriveEmbeddingRoute({ status: 'warn' }, { status: 'ok' }, null, {});
    expect(result.status).toBe('ok');
    expect(result.info).toContain('ONNX');
  });

  it('fails when no embedding route exists at all', () => {
    const result = deriveEmbeddingRoute({ status: 'warn' }, { status: 'warn' }, null, {});
    expect(result.status).toBe('fail');
  });
});

/**
 * Test double for child_process.ChildProcess with real `killed` semantics:
 * `killed` flips to true as soon as a signal is *sent* — it says nothing
 * about the child having exited. A child that traps/ignores SIGTERM keeps
 * exitCode/signalCode at null and never emits 'exit' for it.
 */
class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  signals: string[] = [];

  constructor(private behavior: 'ignore-sigterm' | 'exit-on-sigterm') {
    super();
  }

  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal);
    this.killed = true;
    if (signal === 'SIGKILL' || this.behavior === 'exit-on-sigterm') {
      queueMicrotask(() => {
        this.signalCode = signal;
        this.emit('exit', null, signal);
      });
    }
    return true;
  }
}

describe('terminateChild', () => {
  it('escalates to SIGKILL when the child ignores SIGTERM (regression: child.killed is not "child exited")', async () => {
    const child = new FakeChild('ignore-sigterm');
    const escalated = await terminateChild(child, { graceMs: 20 });
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(escalated).toBe(true);
  });

  it('does not SIGKILL a child that exits on SIGTERM within the grace window', async () => {
    const child = new FakeChild('exit-on-sigterm');
    const escalated = await terminateChild(child, { graceMs: 20 });
    expect(child.signals).toEqual(['SIGTERM']);
    expect(escalated).toBe(false);
  });
});

describe('runAuditNetwork', () => {
  function collector() {
    const lines: string[] = [];
    return { lines, write: (s: string) => lines.push(s) };
  }

  it('fails cleanly with a readable message when the server cannot be spawned (regression: unhandled ENOENT)', async () => {
    const child = new FakeChild('ignore-sigterm');
    const spawnImpl = vi.fn().mockImplementation(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn node ENOENT')));
      return child;
    });
    const out = collector();
    const errOut = collector();
    const code = await runAuditNetwork({
      spawnImpl,
      exists: () => true,
      auditMs: 100,
      graceMs: 10,
      stdout: out,
      stderr: errOut,
    });
    expect(code).toBe(1);
    expect(errOut.lines.join('')).toContain('ENOENT');
  });

  it('returns 1 with a build hint when dist/index.js is missing', async () => {
    const spawnImpl = vi.fn();
    const errOut = collector();
    const code = await runAuditNetwork({
      spawnImpl,
      exists: (p: string) => !p.endsWith('index.js'),
      stdout: collector(),
      stderr: errOut,
    });
    expect(code).toBe(1);
    expect(errOut.lines.join('')).toContain('npm run build');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('returns 0 and reports zero egress when no [NET-AUDIT] lines appear', async () => {
    const child = new FakeChild('exit-on-sigterm');
    const out = collector();
    const code = await runAuditNetwork({
      spawnImpl: vi.fn().mockReturnValue(child),
      exists: () => true,
      auditMs: 30,
      graceMs: 10,
      stdout: out,
      stderr: collector(),
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('zero TCP/UDP outbound connections');
    expect(child.signals).toContain('SIGTERM');
  });

  it('returns 1 and lists the destinations when [NET-AUDIT] lines appear on child stderr', async () => {
    const child = new FakeChild('exit-on-sigterm');
    const spawnImpl = vi.fn().mockImplementation(() => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('[NET-AUDIT] tcp connect host=93.184.216.34 port=443\n'));
      });
      return child;
    });
    const out = collector();
    const code = await runAuditNetwork({
      spawnImpl,
      exists: () => true,
      auditMs: 30,
      graceMs: 10,
      stdout: out,
      stderr: collector(),
    });
    expect(code).toBe(1);
    expect(out.lines.join('')).toContain('tcp connect host=93.184.216.34 port=443');
  });
});

describe('aggregateExitCode', () => {
  it('returns 0 when every check is ok or skipped', () => {
    expect(aggregateExitCode([
      { status: 'ok' }, { status: 'ok' }, { status: 'skip' },
    ])).toBe(0);
  });

  it('returns 1 when there are warnings but nothing broken', () => {
    expect(aggregateExitCode([
      { status: 'ok' }, { status: 'warn' }, { status: 'ok' },
    ])).toBe(1);
  });

  it('returns 2 when any check failed, even alongside warnings', () => {
    expect(aggregateExitCode([
      { status: 'ok' }, { status: 'warn' }, { status: 'fail' },
    ])).toBe(2);
  });
});
