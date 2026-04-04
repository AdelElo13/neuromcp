import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';
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
import { searchMemory } from '../../src/tools/search.js';

const DIMS = 384;

class FakeEmbedder implements EmbeddingProvider {
  readonly name = 'fake';
  readonly dimensions = DIMS;
  readonly maxTokens = 512;

  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(DIMS);
    for (let i = 0; i < Math.min(text.length, DIMS); i++) {
      v[i] = (text.charCodeAt(i) - 96) / 26;
    }
    let norm = 0;
    for (let i = 0; i < DIMS; i++) norm += v[i]! * v[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < DIMS; i++) v[i] /= norm;
    return v;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

describe('searchMemory', () => {
  const testDb = join(tmpdir(), `neuromcp-search-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  let storeDeps: StoreDeps;
  let searchDeps: SearchDeps;

  beforeEach(async () => {
    const db = openDatabase(testDb);
    applySchema(db);
    const vecStore = new SqliteVecStore(DIMS);
    vecStore.initialize(db);
    const logger = createLogger({ level: 'error', format: 'text' });
    const metrics = createMetrics();
    const config = loadConfig();
    const embedder = new FakeEmbedder();

    storeDeps = { db, vecStore, embedder, logger, metrics, config };
    searchDeps = { db, vecStore, embedder, logger, metrics, config };

    // Seed memories
    await storeMemory({ content: 'typescript patterns and best practices', category: 'code', tags: ['typescript'], importance: 0.8 }, storeDeps);
    await storeMemory({ content: 'python machine learning tutorial', category: 'code', tags: ['python', 'ml'], importance: 0.6 }, storeDeps);
    await storeMemory({ content: 'cooking recipes for pasta dishes', category: 'personal', tags: ['cooking'], importance: 0.4 }, storeDeps);
    await storeMemory({ content: 'javascript async await patterns', category: 'code', tags: ['javascript'], importance: 0.7 }, storeDeps);
  });

  afterEach(() => {
    closeDatabase();
    try {
      unlinkSync(testDb);
      unlinkSync(testDb + '-wal');
      unlinkSync(testDb + '-shm');
    } catch {
      // ignore missing files
    }
  });

  it('returns results sorted by relevance', async () => {
    const results = await searchMemory(
      { query: 'typescript patterns' },
      searchDeps,
    );

    expect(results.length).toBeGreaterThan(0);
    // Scores should be in descending order
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.similarity_score).toBeGreaterThanOrEqual(
        results[i]!.similarity_score,
      );
    }
  });

  it('respects limit', async () => {
    const results = await searchMemory(
      { query: 'patterns', limit: 2 },
      searchDeps,
    );

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('filters by category', async () => {
    const results = await searchMemory(
      { query: 'patterns', category: 'personal' },
      searchDeps,
    );

    for (const r of results) {
      expect(r.category).toBe('personal');
    }
  });

  it('bumps access count', async () => {
    // Get initial access count
    const before = storeDeps.db
      .prepare('SELECT access_count FROM memories WHERE content LIKE ?')
      .get('%typescript patterns%') as { access_count: number } | undefined;

    const initialCount = before?.access_count ?? 0;

    await searchMemory(
      { query: 'typescript patterns' },
      searchDeps,
    );

    const after = storeDeps.db
      .prepare('SELECT access_count FROM memories WHERE content LIKE ?')
      .get('%typescript patterns%') as { access_count: number };

    // Access count should have been bumped (if the memory was in results)
    expect(after.access_count).toBeGreaterThan(initialCount);
  });

  it('excludes tombstoned memories', async () => {
    // Tombstone one memory
    storeDeps.db
      .prepare(
        "UPDATE memories SET is_deleted = 1, tombstoned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE content LIKE '%cooking%'",
      )
      .run();

    const results = await searchMemory(
      { query: 'cooking recipes pasta' },
      searchDeps,
    );

    for (const r of results) {
      expect(r.content).not.toContain('cooking');
    }
  });

  it('respects namespace isolation', async () => {
    // Store a memory in a different namespace
    await storeMemory(
      { content: 'secret namespace data', namespace: 'private-ns' },
      storeDeps,
    );

    // Search in default namespace should not return it
    const results = await searchMemory(
      { query: 'secret namespace data', namespace: 'default' },
      searchDeps,
    );

    for (const r of results) {
      expect(r.namespace).toBe('default');
    }
  });

  it('filters by min_importance', async () => {
    const results = await searchMemory(
      { query: 'patterns', min_importance: 0.7 },
      searchDeps,
    );

    for (const r of results) {
      expect(r.importance).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('returns empty array when no matches', async () => {
    const results = await searchMemory(
      { query: 'zzzzz nonexistent content', namespace: 'empty-ns' },
      searchDeps,
    );

    expect(results).toEqual([]);
  });
});
