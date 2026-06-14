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
import type { StoreDeps } from '../../src/tools/store.js';
import { storeMemory } from '../../src/tools/store.js';
import type { SearchDeps } from '../../src/tools/search.js';
import { recallAnswer } from '../../src/tools/recall-answer.js';

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

describe('v0.26 synthesis recall (recall_answer)', () => {
  const testDb = join(tmpdir(), `neuromcp-v026-synth-${Date.now()}-${randomUUID()}.db`);
  let storeDeps: StoreDeps;
  let searchDeps: SearchDeps;

  beforeEach(() => {
    const db = openDatabase(testDb);
    applySchema(db);
    const vecStore = new SqliteVecStore(DIMS);
    vecStore.initialize(db);
    const logger = createLogger({ level: 'error', format: 'text' });
    const metrics = createMetrics();
    const config = { ...loadConfig(), entityExtractionMode: 'regex' as const };
    const embedder = new FakeEmbedder();
    storeDeps = { db, vecStore, embedder, logger, metrics, config };
    searchDeps = { db, vecStore, embedder, logger, metrics, config };
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

  it('returns a cited extractive answer with sources, citations and a staleness boundary', async () => {
    const m1 = await storeMemory(
      { content: 'The deploy pipeline uses a blue-green strategy with health checks before cutover.', namespace: 'default' },
      storeDeps,
    );
    await storeMemory(
      { content: 'Rollbacks switch the load balancer back to the previous color in under a minute.', namespace: 'default' },
      storeDeps,
    );

    const result = await recallAnswer(
      { query: 'how does the deploy pipeline work', namespace: 'default' },
      searchDeps,
      { relevanceFloor: 0 }, // FakeEmbedder cosines are artificially low; gate tested separately
    );

    expect(result.status).toBe('answered');
    expect(result.answer).toBeTruthy();
    expect(result.answer!.toLowerCase()).toContain('blue-green');
    // every citation maps to a real source memory id
    expect(result.citations.length).toBeGreaterThan(0);
    const sourceIds = new Set(result.sources.map((s) => s.id));
    for (const c of result.citations) {
      expect(sourceIds.has(c.memory_id)).toBe(true);
    }
    expect(sourceIds.has(m1.id)).toBe(true);
    // staleness boundary present + a boundary gap line
    expect(result.stale_since).not.toBeNull();
    expect(result.gaps.some((g) => g.toLowerCase().includes('boundary'))).toBe(true);
  });

  it('says not_in_memory (never fabricates) when nothing matches', async () => {
    await storeMemory({ content: 'completely unrelated note about gardening', namespace: 'default' }, storeDeps);

    const result = await recallAnswer(
      { query: 'quantum chromodynamics lattice gauge', namespace: 'empty-namespace' },
      searchDeps,
    );

    expect(result.status).toBe('not_in_memory');
    expect(result.answer).toBeNull();
    expect(result.citations.length).toBe(0);
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.gaps[0]!.toLowerCase()).toContain('no stored memory');
  });

  it('flags thin coverage and staleness in the gaps', async () => {
    const old = new Date('2026-01-01T00:00:00.000Z').toISOString();
    const m = await storeMemory(
      { content: 'The legacy billing cron runs nightly at 3am and emails a CSV report.', namespace: 'default' },
      storeDeps,
    );
    storeDeps.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(old, m.id);

    const result = await recallAnswer(
      { query: 'billing cron schedule', namespace: 'default' },
      // fixed "now" well after the memory so staleness fires deterministically
      searchDeps,
      { now: new Date('2026-06-01T00:00:00.000Z').getTime(), relevanceFloor: 0 },
    );

    expect(result.status).toBe('answered');
    expect(result.gaps.some((g) => g.toLowerCase().includes('thin coverage'))).toBe(true);
    expect(result.gaps.some((g) => g.toLowerCase().includes('days ago'))).toBe(true);
  });
});
