import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { openDatabase, closeDatabase } from '../../src/storage/database.js';
import { applySchema } from '../../src/storage/schema.js';
import { SqliteVecStore } from '../../src/vectors/sqlite-vec.js';
import { createLogger } from '../../src/observability/logger.js';
import { createMetrics } from '../../src/observability/metrics.js';
import { loadConfig } from '../../src/config.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';
import { OllamaEmbeddingProvider } from '../../src/embeddings/ollama.js';
// New v0.26 export — failing-first gate for this file.
import { validateEmbeddingCompatibility } from '../../src/embeddings/validate.js';
import type { StoreDeps } from '../../src/tools/store.js';
import { storeMemory } from '../../src/tools/store.js';
import type { SearchDeps } from '../../src/tools/search.js';
import { searchMemory } from '../../src/tools/search.js';

const DIMS = 384;

class FakeEmbedder implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  readonly maxTokens = 512;

  constructor(name = 'fake', dimensions = DIMS) {
    this.name = name;
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dimensions);
    for (let i = 0; i < Math.min(text.length, this.dimensions); i++) {
      v[i] = (text.charCodeAt(i) - 96) / 26;
    }
    let norm = 0;
    for (let i = 0; i < this.dimensions; i++) norm += v[i]! * v[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < this.dimensions; i++) v[i] /= norm;
    return v;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class DownEmbedder extends FakeEmbedder {
  override async embed(): Promise<Float32Array> {
    throw new Error('embedder is down');
  }
}

describe('v0.26 embedding safety', () => {
  const testDb = join(tmpdir(), `neuromcp-v026-p3-${Date.now()}-${randomUUID()}.db`);
  let db: ReturnType<typeof openDatabase>;
  const logger = createLogger({ level: 'error', format: 'text' });

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
        // ignore
      }
    }
  });

  describe('validateEmbeddingCompatibility', () => {
    it('throws loudly with a remediation hint when the vec table dimension differs', () => {
      const vec = new SqliteVecStore(DIMS);
      vec.initialize(db); // existing index at 384

      const bigger = new FakeEmbedder('other-model', 768);
      expect(() => validateEmbeddingCompatibility(db, bigger, logger)).toThrow(/backfill|dimension/i);
    });

    it('throws when stored memories used a different same-dimension model', async () => {
      const vec = new SqliteVecStore(DIMS);
      vec.initialize(db);
      const metrics = createMetrics();
      const config = { ...loadConfig(), entityExtractionMode: 'regex' as const };
      const deps: StoreDeps = { db, vecStore: vec, embedder: new FakeEmbedder('fake'), logger, metrics, config };
      await storeMemory({ content: 'embedded under the fake model' }, deps);

      const otherModel = new FakeEmbedder('different-model', DIMS);
      expect(() => validateEmbeddingCompatibility(db, otherModel, logger)).toThrow(/model/i);
    });

    it('passes when model and dimension match the stored state', async () => {
      const vec = new SqliteVecStore(DIMS);
      vec.initialize(db);
      const metrics = createMetrics();
      const config = { ...loadConfig(), entityExtractionMode: 'regex' as const };
      const deps: StoreDeps = { db, vecStore: vec, embedder: new FakeEmbedder('fake'), logger, metrics, config };
      await storeMemory({ content: 'embedded under the fake model' }, deps);

      expect(() => validateEmbeddingCompatibility(db, new FakeEmbedder('fake'), logger)).not.toThrow();
    });

    it('passes on an empty database (nothing stored yet)', () => {
      expect(() => validateEmbeddingCompatibility(db, new FakeEmbedder('fresh'), logger)).not.toThrow();
    });
  });

  describe('embed timeout', () => {
    let server: Server;
    let port: number;
    const sockets = new Set<import('node:net').Socket>();

    beforeEach(async () => {
      // A server that accepts connections and never responds — simulates a
      // hung Ollama. Connection succeeds, so only a request timeout saves us.
      server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        /* accept and stall */
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as { port: number }).port;
    });

    afterEach(async () => {
      // server.close() waits for open connections; destroy the stalled ones.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('embed rejects within the configured timeout instead of hanging forever', async () => {
      const provider = new OllamaEmbeddingProvider(`http://127.0.0.1:${port}`, 'nomic-embed-text', {
        timeoutMs: 250,
      });
      const start = Date.now();
      await expect(provider.embed('hello')).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(5_000);
    });
  });

  describe('FTS-only degradation when the embedder is down', () => {
    it('hybrid search still returns keyword results, loudly degraded', async () => {
      const vec = new SqliteVecStore(DIMS);
      vec.initialize(db);
      const metrics = createMetrics();
      const config = { ...loadConfig(), entityExtractionMode: 'regex' as const };
      const healthy: StoreDeps = { db, vecStore: vec, embedder: new FakeEmbedder(), logger, metrics, config };
      await storeMemory({ content: 'the flamingo migration happens in spring' }, healthy);

      const degraded: SearchDeps = { db, vecStore: vec, embedder: new DownEmbedder(), logger, metrics, config };
      const results = await searchMemory(
        { query: 'flamingo migration', namespace: 'default', graph_boost: false, explain: false },
        degraded,
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.content).toContain('flamingo');
      expect(metrics.snapshot().counters['search.degraded_fts_only']).toBe(1);
    });

    it('vector-only search (hybrid=false) still fails loudly', async () => {
      const vec = new SqliteVecStore(DIMS);
      vec.initialize(db);
      const metrics = createMetrics();
      const config = { ...loadConfig(), entityExtractionMode: 'regex' as const };
      const degraded: SearchDeps = { db, vecStore: vec, embedder: new DownEmbedder(), logger, metrics, config };

      await expect(
        searchMemory({ query: 'anything', hybrid: false, explain: false }, degraded),
      ).rejects.toThrow('embedder is down');
    });
  });
});
