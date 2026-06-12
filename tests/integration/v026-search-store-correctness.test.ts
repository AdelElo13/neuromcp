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
import type { VectorStore } from '../../src/vectors/types.js';
import type { StoreDeps } from '../../src/tools/store.js';
import { storeMemory } from '../../src/tools/store.js';
import type { SearchDeps } from '../../src/tools/search.js';
import { searchMemory } from '../../src/tools/search.js';
import { generateReflection } from '../../src/tools/reflection.js';
import { transferMemories } from '../../src/tools/transfer.js';

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

/** Embedder that fails on content containing a poison marker. */
class PoisonEmbedder extends FakeEmbedder {
  override async embed(text: string): Promise<Float32Array> {
    if (text.includes('POISON')) throw new Error('embedder down for this content');
    return super.embed(text);
  }
}

/** VectorStore wrapper whose upsert always throws — fault injection for atomicity tests. */
class FailingUpsertVecStore implements VectorStore {
  constructor(private readonly inner: VectorStore) {}
  initialize(db: Parameters<VectorStore['initialize']>[0]): void {
    this.inner.initialize(db);
  }
  upsert(): void {
    throw new Error('vec upsert fault injection');
  }
  search(...args: Parameters<VectorStore['search']>): ReturnType<VectorStore['search']> {
    return this.inner.search(...args);
  }
  remove(id: string): void {
    this.inner.remove(id);
  }
  clear(): void {
    this.inner.clear();
  }
  count(): number {
    return this.inner.count();
  }
}

describe('v0.26 search/store correctness', () => {
  const testDb = join(tmpdir(), `neuromcp-v026-p1-${Date.now()}-${randomUUID()}.db`);
  let storeDeps: StoreDeps;
  let searchDeps: SearchDeps;
  let vecStore: SqliteVecStore;

  beforeEach(() => {
    const db = openDatabase(testDb);
    applySchema(db);
    vecStore = new SqliteVecStore(DIMS);
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
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(testDb + suffix);
      } catch {
        // ignore missing files
      }
    }
  });

  describe('entity extraction default (no LLM on the write path)', () => {
    it('loadConfig defaults entityExtractionMode to regex', () => {
      const saved = process.env['NEUROMCP_ENTITY_EXTRACTION'];
      delete process.env['NEUROMCP_ENTITY_EXTRACTION'];
      try {
        expect(loadConfig().entityExtractionMode).toBe('regex');
      } finally {
        if (saved !== undefined) process.env['NEUROMCP_ENTITY_EXTRACTION'] = saved;
      }
    });
  });

  describe("namespace='*' keeps the vector leg alive", () => {
    it('finds memories across namespaces via vector search with hybrid off', async () => {
      await storeMemory(
        { content: 'alpha namespace secret about quasars', namespace: 'alpha' },
        storeDeps,
      );
      await storeMemory(
        { content: 'beta namespace note about pulsars', namespace: 'beta' },
        storeDeps,
      );

      const fromAlpha = await searchMemory(
        {
          query: 'alpha namespace secret about quasars',
          namespace: '*',
          hybrid: false,
          graph_boost: false,
          explain: false,
        },
        searchDeps,
      );
      expect(fromAlpha.length).toBeGreaterThan(0);
      expect(fromAlpha.some((m) => m.content.includes('quasars'))).toBe(true);

      const fromBeta = await searchMemory(
        {
          query: 'beta namespace note about pulsars',
          namespace: '*',
          hybrid: false,
          graph_boost: false,
          explain: false,
        },
        searchDeps,
      );
      expect(fromBeta.some((m) => m.content.includes('pulsars'))).toBe(true);
    });
  });

  describe('results are sorted by final score before MMR', () => {
    it('returns the highest-scoring memory first when the adaptive multiplier reorders candidates', async () => {
      // Raise the dedup threshold so the two near-matches stay separate rows.
      const noDedupConfig = { ...storeDeps.config, dedupThreshold: 0.9999 };
      const noDedupStore: StoreDeps = { ...storeDeps, config: noDedupConfig };

      const query = 'deployment checklist for the staging server';
      // X: exact query match → vec rank 1, but stale (no accesses, old).
      const x = await storeMemory({ content: query, namespace: 'sortns' }, noDedupStore);
      // Y: near match → vec rank 2, but heavily and recently accessed.
      const y = await storeMemory(
        { content: 'deployment checklist for the staging machine', namespace: 'sortns' },
        noDedupStore,
      );
      expect(y.id).not.toBe(x.id);

      const db = storeDeps.db;
      const past = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
      db.prepare(
        'UPDATE memories SET importance = 0.5, access_count = 0, last_accessed_at = NULL, created_at = ? WHERE id = ?',
      ).run(past, x.id);
      db.prepare(
        "UPDATE memories SET importance = 0.9, access_count = 50, last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      ).run(y.id);

      const out = await searchMemory(
        { query, namespace: 'sortns', hybrid: false, graph_boost: false, explain: false },
        searchDeps,
      );

      expect(out.length).toBeGreaterThanOrEqual(2);
      const maxScore = Math.max(...out.map((m) => m.similarity_score));
      expect(out[0]!.similarity_score).toBe(maxScore);
      expect(out[0]!.id).toBe(y.id);
    });
  });

  describe('storeMemory atomicity (memories + vec + FTS in one transaction)', () => {
    it('rolls back the memories row and FTS row when the vec upsert fails', async () => {
      const failingDeps: StoreDeps = {
        ...storeDeps,
        vecStore: new FailingUpsertVecStore(vecStore),
      };

      await expect(
        storeMemory({ content: 'atomicity canary xylophone', namespace: 'atomic' }, failingDeps),
      ).rejects.toThrow('vec upsert fault injection');

      const row = storeDeps.db
        .prepare("SELECT id FROM memories WHERE content LIKE '%atomicity canary xylophone%'")
        .get();
      expect(row).toBeUndefined();

      const fts = storeDeps.db
        .prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH '\"atomicity canary xylophone\"'")
        .all();
      expect(fts.length).toBe(0);
    });
  });

  describe('reflection memories are searchable', () => {
    it('a generated reflection is findable via hybrid search', async () => {
      const seed = await storeMemory(
        { content: 'docker compose profiles make local stacks composable', namespace: 'default' },
        storeDeps,
      );
      storeDeps.db
        .prepare(
          `INSERT INTO memory_usefulness
             (memory_id, namespace, helpful_count, neutral_count, harmful_count, total_observed, usefulness_score)
           VALUES (?, 'default', 3, 0, 0, 3, 0.9)`,
        )
        .run(seed.id);

      const result = await generateReflection(
        { namespace: 'default' },
        {
          db: storeDeps.db,
          logger: storeDeps.logger,
          embedder: storeDeps.embedder,
          vecStore: storeDeps.vecStore,
        },
      );
      expect(result.skipped).toBe(false);
      expect(result.reflection_id).not.toBeNull();

      const found = await searchMemory(
        {
          query: 'Synthesised from',
          namespace: 'default',
          graph_boost: false,
          explain: false,
        },
        searchDeps,
      );
      expect(found.some((m) => m.id === result.reflection_id)).toBe(true);
    });
  });

  describe('transferMemories integrity', () => {
    it('keeps transferred memories findable via FTS', async () => {
      const src = await storeMemory(
        { content: 'always pin dockerfile base images to digests', namespace: 'src', category: 'pattern' },
        storeDeps,
      );

      await transferMemories(storeDeps.db, storeDeps.embedder, storeDeps.vecStore, {
        memory_ids: [src.id],
        target_namespace: 'tgt',
      });

      const fts = storeDeps.db
        .prepare(
          `SELECT m.id FROM memories_fts f
             JOIN memories m ON m.rowid = f.rowid
            WHERE memories_fts MATCH '"pin dockerfile base images"' AND m.namespace = 'tgt'`,
        )
        .all();
      expect(fts.length).toBe(1);
    });

    it('dedups against the ADAPTED content hash so a re-transfer is skipped', async () => {
      const src = await storeMemory(
        {
          content: 'config lives at /Users/adel/projects/app/config.json on the dev box',
          namespace: 'src2',
          category: 'config',
        },
        storeDeps,
      );

      const first = await transferMemories(storeDeps.db, storeDeps.embedder, storeDeps.vecStore, {
        memory_ids: [src.id],
        target_namespace: 'tgt2',
        adapt: true,
      });
      expect(first.transferred).toBe(1);

      const second = await transferMemories(storeDeps.db, storeDeps.embedder, storeDeps.vecStore, {
        memory_ids: [src.id],
        target_namespace: 'tgt2',
        adapt: true,
      });
      expect(second.transferred).toBe(0);
      expect(second.skipped_duplicates).toBe(1);

      const count = storeDeps.db
        .prepare("SELECT COUNT(*) AS n FROM memories WHERE namespace = 'tgt2' AND is_deleted = 0")
        .get() as { n: number };
      expect(count.n).toBe(1);
    });

    it('an embed failure skips that memory without committing an unsearchable orphan', async () => {
      const good = await storeMemory(
        { content: 'rotate api tokens quarterly as a habit', namespace: 'src3', category: 'pattern' },
        storeDeps,
      );
      const bad = await storeMemory(
        { content: 'POISON entry that the embedder rejects', namespace: 'src3', category: 'pattern' },
        storeDeps,
      );

      const poisonDeps = new PoisonEmbedder();
      const result = await transferMemories(storeDeps.db, poisonDeps, storeDeps.vecStore, {
        memory_ids: [good.id, bad.id],
        target_namespace: 'tgt3',
        adapt: false,
      });

      expect(result.transferred).toBe(1);

      const rows = storeDeps.db
        .prepare("SELECT content FROM memories WHERE namespace = 'tgt3' AND is_deleted = 0")
        .all() as Array<{ content: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.content).toContain('rotate api tokens');
    });
  });
});
