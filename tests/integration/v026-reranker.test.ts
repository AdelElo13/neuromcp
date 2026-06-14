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
import type { RerankProvider } from '../../src/rerank/types.js';
import type { StoreDeps } from '../../src/tools/store.js';
import { storeMemory } from '../../src/tools/store.js';
import type { SearchDeps } from '../../src/tools/search.js';
import { searchMemory } from '../../src/tools/search.js';

const DIMS = 384;

class FakeEmbedder implements EmbeddingProvider {
  readonly name = 'fake';
  readonly dimensions = DIMS;
  readonly maxTokens = 512;
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(DIMS);
    for (let i = 0; i < Math.min(text.length, DIMS); i++) v[i] = (text.charCodeAt(i) - 96) / 26;
    let n = 0;
    for (let i = 0; i < DIMS; i++) n += v[i]! * v[i]!;
    n = Math.sqrt(n);
    if (n > 0) for (let i = 0; i < DIMS; i++) v[i] /= n;
    return v;
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

/** Scores documents containing the magic marker far higher than the rest. */
class MarkerReranker implements RerankProvider {
  readonly name = 'marker';
  readonly maxTokens = 512;
  rerankCalls = 0;
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async rerank(_query: string, documents: readonly string[]): Promise<number[]> {
    this.rerankCalls++;
    return documents.map((d) => (d.includes('RERANK_TARGET') ? 8 : -8));
  }
}

class ThrowingReranker implements RerankProvider {
  readonly name = 'boom';
  readonly maxTokens = 512;
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async rerank(): Promise<number[]> {
    throw new Error('reranker exploded');
  }
}

describe('v0.26 reranker integration', () => {
  const testDb = join(tmpdir(), `neuromcp-v026-rerank-${Date.now()}-${randomUUID()}.db`);
  let storeDeps: StoreDeps;
  let baseSearchDeps: SearchDeps;

  beforeEach(async () => {
    const db = openDatabase(testDb);
    applySchema(db);
    const vecStore = new SqliteVecStore(DIMS);
    vecStore.initialize(db);
    const logger = createLogger({ level: 'error', format: 'text' });
    const metrics = createMetrics();
    const config = { ...loadConfig(), entityExtractionMode: 'regex' as const, rerankPool: 30 };
    storeDeps = { db, vecStore, embedder: new FakeEmbedder(), logger, metrics, config };
    baseSearchDeps = { db, vecStore, embedder: new FakeEmbedder(), logger, metrics, config };

    // 20 memories about "alpha". The TARGET is worded to rank OUTSIDE the
    // top hybrid result for the query, so a reranker has to pull it up.
    for (let i = 0; i < 20; i++) {
      await storeMemory(
        { content: `note ${i}: the alpha subsystem handles widget number ${i} in the pipeline`, namespace: 'default' },
        storeDeps,
      );
    }
    await storeMemory(
      { content: 'a totally different phrasing zzz RERANK_TARGET buried among many widgets', namespace: 'default' },
      storeDeps,
    );
  });

  afterEach(() => {
    closeDatabase();
    for (const s of ['', '-wal', '-shm']) {
      try {
        unlinkSync(testDb + s);
      } catch {
        // ignore
      }
    }
  });

  it('with no reranker, the marker doc is NOT first', async () => {
    const out = await searchMemory(
      { query: 'alpha subsystem widget pipeline', namespace: 'default', explain: false, graph_boost: false },
      baseSearchDeps,
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.content.includes('RERANK_TARGET')).toBe(false);
  });

  it('with a reranker, the promoted doc is pulled into first place and carries rerank_score', async () => {
    const reranker = new MarkerReranker();
    const out = await searchMemory(
      { query: 'alpha subsystem widget pipeline', namespace: 'default', explain: false, graph_boost: false },
      { ...baseSearchDeps, reranker },
    );
    expect(reranker.rerankCalls).toBe(1);
    expect(out[0]!.content.includes('RERANK_TARGET')).toBe(true);
    // rerank_score is set and similarity_score (RRF scale) is preserved.
    expect(out[0]!.rerank_score).toBeDefined();
    expect(out[0]!.rerank_score!).toBeGreaterThan(0.9);
    expect(typeof out[0]!.similarity_score).toBe('number');
    expect(storeDeps.metrics.snapshot().counters['search.reranked']).toBe(1);
  });

  it('a failing reranker degrades to RRF order instead of throwing', async () => {
    const out = await searchMemory(
      { query: 'alpha subsystem widget pipeline', namespace: 'default', explain: false, graph_boost: false },
      { ...baseSearchDeps, reranker: new ThrowingReranker() },
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.content.includes('RERANK_TARGET')).toBe(false); // fell back
  });
});
