/**
 * v0.29.3 — switching embedding provider must never kill the server.
 *
 * Reported on a machine where Claude Desktop, Claude Code and Codex Desktop
 * share ~/.neuromcp/memory.db: neuromcp was installed without Ollama, so the
 * ONNX fallback built a 384-dim vector index. Installing Ollama afterwards
 * made every start fail with "Embedding dimension mismatch" (validate.ts) —
 * the memory layer was simply gone, for all three clients at once. The same
 * crash happened in the other direction whenever Ollama was briefly down and
 * the 'auto' cascade fell back to ONNX.
 *
 * Contract under test (both directions, against a temp database WITH data):
 *   - 384 index + only a 768 provider reachable → DEGRADED start, no throw.
 *   - 768 index + only a 384 provider reachable → DEGRADED start, no throw.
 *   - index width still reachable → 'matched' start on THAT provider, even
 *     when a "better" provider of another width is available.
 *   - degraded: store works (no vector, queued for backfill), FTS search
 *     works, vector search is off, and the state is visible to tools.
 *   - nothing is ever migrated, dropped, or rebuilt behind the user's back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDatabase, closeDatabase } from '../../src/storage/database.js';
import { applySchema } from '../../src/storage/schema.js';
import { SqliteVecStore } from '../../src/vectors/sqlite-vec.js';
import { createLogger } from '../../src/observability/logger.js';
import { createMetrics } from '../../src/observability/metrics.js';
import { loadConfig } from '../../src/config.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';
import type { ProviderSelection } from '../../src/embeddings/factory.js';
import {
  resolveEmbeddingRuntime,
  isDegradedProvider,
  degradedNotice,
  embeddingStatus,
  isEmbeddingsUnavailable,
} from '../../src/embeddings/runtime.js';
import { getExistingVecDimension } from '../../src/embeddings/validate.js';
import { storeMemory, type StoreDeps } from '../../src/tools/store.js';
import { searchMemory, type SearchDeps } from '../../src/tools/search.js';
import { backfillEmbeddings } from '../../src/tools/backfill.js';

class FakeEmbedder implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  readonly maxTokens = 512;

  constructor(name: string, dimensions: number) {
    this.name = name;
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dimensions);
    for (let i = 0; i < Math.min(text.length, this.dimensions); i++) {
      v[i] = (text.charCodeAt(i) % 32) / 32;
    }
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) norm += v[i]! * v[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < this.dimensions; i++) v[i]! /= norm;
    return v;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/** A stand-in for the real cascade: "these providers are reachable". */
function cascade(...reachable: EmbeddingProvider[]) {
  // Mirrors the production contract: a candidate must match the index width
  // AND (when known) the stored model — see providerAcceptable in factory.ts.
  return async (
    _config: unknown,
    _logger: unknown,
    options: { requireDimension?: number; requireModel?: string } = {},
  ): Promise<ProviderSelection> => {
    const rejected: string[] = [];
    for (const p of reachable) {
      const widthOk =
        options.requireDimension === undefined || p.dimensions === options.requireDimension;
      const modelOk = options.requireModel === undefined || p.name === options.requireModel;
      if (widthOk && modelOk) {
        return { provider: p, rejected, explicitError: null };
      }
      rejected.push(`${p.name} (${p.dimensions}d)`);
    }
    return { provider: null, rejected, explicitError: null };
  };
}

const NEVER_SLEEP = async (): Promise<void> => {};
const SILENT = { write: (): boolean => true };

describe('v0.29.3 embedding provider switch', () => {
  const testDb = join(tmpdir(), `neuromcp-v0293-${Date.now()}-${randomUUID()}.db`);
  let db: ReturnType<typeof openDatabase>;
  const logger = createLogger({ level: 'error', format: 'text' });
  const config = { ...loadConfig(), entityExtractionMode: 'regex' as const };

  beforeEach(() => {
    db = openDatabase(testDb);
    applySchema(db);
  });

  afterEach(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(testDb + suffix);
      } catch {
        /* ignore */
      }
    }
  });

  /** Build an index of `dim` and store one memory through it. */
  async function seed(dim: number, modelName: string): Promise<void> {
    const vec = new SqliteVecStore(dim);
    vec.initialize(db);
    const deps: StoreDeps = {
      db,
      vecStore: vec,
      embedder: new FakeEmbedder(modelName, dim),
      logger,
      metrics: createMetrics(),
      config,
    };
    await storeMemory({ content: 'the deployment key rotates every ninety days' }, deps);
    await storeMemory({ content: 'postgres runs on port 5433 in staging' }, deps);
  }

  it('384 index + only a 768 provider reachable → degraded start, never throws', async () => {
    await seed(384, 'bge-small-en-v1.5');

    const runtime = await resolveEmbeddingRuntime(db, config, logger, {
      select: cascade(new FakeEmbedder('nomic-embed-text', 768)),
      attempts: 2,
      sleep: NEVER_SLEEP,
      stderr: SILENT,
      env: {},
    });

    expect(runtime.mode).toBe('degraded');
    expect(runtime.vectorEnabled).toBe(false);
    expect(runtime.indexDimension).toBe(384);
    expect(isDegradedProvider(runtime.embedder)).toBe(true);
    // The degraded provider reports the INDEX width, so re-initializing the
    // vector store can never recreate the table at another width.
    expect(runtime.embedder.dimensions).toBe(384);
    expect(getExistingVecDimension(db)).toBe(384);
  });

  it('768 index + only a 384 provider reachable → degraded start, never throws', async () => {
    await seed(768, 'nomic-embed-text');

    const runtime = await resolveEmbeddingRuntime(db, config, logger, {
      select: cascade(new FakeEmbedder('bge-small-en-v1.5', 384)),
      attempts: 2,
      sleep: NEVER_SLEEP,
      stderr: SILENT,
      env: {},
    });

    expect(runtime.mode).toBe('degraded');
    expect(runtime.vectorEnabled).toBe(false);
    expect(runtime.indexDimension).toBe(768);
    expect(getExistingVecDimension(db)).toBe(768);
  });

  it('prefers the provider that matches the index over a "better" one of another width', async () => {
    await seed(384, 'bge-small-en-v1.5');

    const runtime = await resolveEmbeddingRuntime(db, config, logger, {
      // Ollama is back up, but the index is still 384: keep using ONNX.
      select: cascade(
        new FakeEmbedder('nomic-embed-text', 768),
        new FakeEmbedder('bge-small-en-v1.5', 384),
      ),
      attempts: 1,
      sleep: NEVER_SLEEP,
      stderr: SILENT,
      env: {},
    });

    expect(runtime.mode).toBe('matched');
    expect(runtime.vectorEnabled).toBe(true);
    expect(runtime.embedder.name).toBe('bge-small-en-v1.5');
    expect(runtime.embedder.dimensions).toBe(384);
  });

  it('retries with backoff before degrading (a provider that comes up late is used)', async () => {
    await seed(768, 'nomic-embed-text');

    const slept: number[] = [];
    let attempt = 0;
    const flaky = async (
      _c: unknown,
      _l: unknown,
      options: { requireDimension?: number } = {},
    ): Promise<ProviderSelection> => {
      attempt++;
      if (attempt < 3) return { provider: null, rejected: [], explicitError: null };
      const p = new FakeEmbedder('nomic-embed-text', 768);
      expect(options.requireDimension).toBe(768);
      return { provider: p, rejected: [], explicitError: null };
    };

    const runtime = await resolveEmbeddingRuntime(db, config, logger, {
      select: flaky,
      attempts: 3,
      baseDelayMs: 10,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      stderr: SILENT,
      env: {},
    });

    expect(runtime.mode).toBe('matched');
    expect(attempt).toBe(3);
    expect(slept).toEqual([10, 20]); // exponential backoff between passes
  });

  it('degraded: store works without a vector, FTS search works, state is tool-visible', async () => {
    await seed(768, 'nomic-embed-text');

    const runtime = await resolveEmbeddingRuntime(db, config, logger, {
      select: cascade(),
      attempts: 1,
      sleep: NEVER_SLEEP,
      stderr: SILENT,
      env: {},
    });
    expect(runtime.mode).toBe('degraded');

    const vecStore = new SqliteVecStore(runtime.embedder.dimensions);
    vecStore.initialize(db); // must NOT recreate the table at another width
    expect(getExistingVecDimension(db)).toBe(768);

    const metrics = createMetrics();
    const storeDeps: StoreDeps = {
      db, vecStore, embedder: runtime.embedder, logger, metrics, config,
    };

    const stored = await storeMemory(
      { content: 'the incident postmortem lives in the runbook repository' },
      storeDeps,
    );
    expect(stored.id).toBeTruthy();
    expect(stored.matched).toBe(false);

    const row = db
      .prepare('SELECT embedding_model, embedding_dim FROM memories WHERE id = ?')
      .get(stored.id) as { embedding_model: string; embedding_dim: number };
    expect(row.embedding_model).toBe('none');
    expect(row.embedding_dim).toBe(0);
    const vecRow = db.prepare('SELECT COUNT(*) AS n FROM memories_vec WHERE id = ?').get(stored.id) as { n: number };
    expect(vecRow.n).toBe(0); // queued for backfill, not polluted with a fake vector

    // Hybrid search still returns the memory via FTS.
    const searchDeps: SearchDeps = {
      db, vecStore, embedder: runtime.embedder, logger, metrics, config,
    };
    // NOTE: search.ts wraps the whole query in quotes (FTS5 phrase match), so
    // a single term is what exercises the keyword leg here. That phrase-only
    // behaviour is pre-existing and deliberately not changed in this fix.
    const results = await searchMemory({ query: 'postmortem' }, searchDeps);
    expect(results.map((r) => r.id)).toContain(stored.id);

    // Vector-only search still fails loudly — degradation is not silent.
    await expect(searchMemory({ query: 'postmortem', hybrid: false }, searchDeps)).rejects.toThrow();

    // Tool-visible state.
    const notice = degradedNotice(runtime.embedder);
    expect(notice).toMatch(/DEGRADED/);
    expect(notice).toMatch(/neuromcp-doctor/);
    const status = embeddingStatus(db, runtime.embedder);
    expect(status.status).toBe('degraded');
    expect(status.vector_search).toBe('disabled');
    expect(status.index_dimensions).toBe(768);
    expect(status.memories_without_embedding).toBe(1);

    // Backfill says "cannot" instead of failing one batch per 10 memories.
    const backfill = await backfillEmbeddings(db, vecStore, runtime.embedder, logger, metrics);
    expect(backfill.embedded).toBe(0);
    expect(backfill.errors).toBe(0);
    expect(backfill.total).toBeGreaterThan(0);

    // The typed error is what makes the skip deliberate rather than accidental.
    await expect(runtime.embedder.embed('x')).rejects.toSatisfy(isEmbeddingsUnavailable);
  });

  it('a fresh database keeps the 0.29.2 behaviour (first provider wins, no index yet)', async () => {
    const runtime = await resolveEmbeddingRuntime(db, config, logger, {
      create: async () => new FakeEmbedder('nomic-embed-text', 768),
      attempts: 1,
      sleep: NEVER_SLEEP,
      stderr: SILENT,
      env: {},
    });
    expect(runtime.mode).toBe('fresh');
    expect(runtime.vectorEnabled).toBe(true);
    expect(runtime.indexDimension).toBeNull();
  });

  it('NEUROMCP_STRICT_EMBEDDINGS=1 restores the old hard failure', async () => {
    await seed(384, 'bge-small-en-v1.5');
    await expect(
      resolveEmbeddingRuntime(db, config, logger, {
        select: cascade(new FakeEmbedder('nomic-embed-text', 768)),
        attempts: 1,
        sleep: NEVER_SLEEP,
        stderr: SILENT,
        env: { NEUROMCP_STRICT_EMBEDDINGS: '1' },
      }),
    ).rejects.toThrow(/dimension mismatch/i);
  });

  it('same width, wrong model FIRST in the cascade: keeps walking and picks the matching model', async () => {
    // Codex round-2 [P2]: a 384 index built by bge-small-en-v1.5, with an
    // Ollama all-minilm (also 384) reachable AND the correct ONNX bge
    // reachable. The old behaviour took the first width-match (all-minilm),
    // failed model validation, and degraded — even though the right
    // provider was one step further down the cascade.
    await seed(384, 'bge-small-en-v1.5');

    const runtime = await resolveEmbeddingRuntime(db, config, logger, {
      select: cascade(
        new FakeEmbedder('all-minilm', 384),
        new FakeEmbedder('bge-small-en-v1.5', 384),
      ),
      attempts: 1,
      sleep: NEVER_SLEEP,
      stderr: SILENT,
      env: {},
    });

    expect(runtime.mode).toBe('matched');
    expect(runtime.embedder.name).toBe('bge-small-en-v1.5');
    expect(runtime.vectorEnabled).toBe(true);
  });

  it('NEUROMCP_ALLOW_EMBEDDING_MODEL_MIX=1 still admits a different same-width model — the override survives requireModel', async () => {
    // Codex round-3 [P2]: with exactly one stored model, requireModel was
    // enforced unconditionally, so the documented mix-override never
    // reached the validator anymore. The override must disable the model
    // requirement in SELECTION and be honoured by VALIDATION, consistently
    // from the same injected env.
    await seed(768, 'old-model');

    const runtime = await resolveEmbeddingRuntime(db, config, logger, {
      select: cascade(new FakeEmbedder('nomic-embed-text', 768)),
      attempts: 1,
      sleep: NEVER_SLEEP,
      stderr: SILENT,
      env: { NEUROMCP_ALLOW_EMBEDDING_MODEL_MIX: '1' },
    });

    expect(runtime.mode).toBe('matched');
    expect(runtime.embedder.name).toBe('nomic-embed-text');
  });

  it('same width but a different model degrades instead of poisoning recall', async () => {
    await seed(384, 'bge-small-en-v1.5');

    const runtime = await resolveEmbeddingRuntime(db, config, logger, {
      select: cascade(new FakeEmbedder('some-other-384-model', 384)),
      attempts: 1,
      sleep: NEVER_SLEEP,
      stderr: SILENT,
      env: {},
    });

    expect(runtime.mode).toBe('degraded');
    expect(runtime.message).toMatch(/model/i);
  });
});
