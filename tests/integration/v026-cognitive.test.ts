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
import { updateAdaptiveImportance } from '../../src/cognitive/importance.js';

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

interface MemRow {
  importance: number;
  effective_importance: number | null;
  valid_to: string | null;
  superseded_by_id: string | null;
}

describe('v0.26 cognitive correctness', () => {
  const testDb = join(tmpdir(), `neuromcp-v026-p4-${Date.now()}-${randomUUID()}.db`);
  let deps: StoreDeps;

  beforeEach(() => {
    const db = openDatabase(testDb);
    applySchema(db);
    const vecStore = new SqliteVecStore(DIMS);
    vecStore.initialize(db);
    const logger = createLogger({ level: 'error', format: 'text' });
    const metrics = createMetrics();
    const config = { ...loadConfig(), entityExtractionMode: 'regex' as const };
    deps = { db, vecStore, embedder: new FakeEmbedder(), logger, metrics, config };
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

  function getRow(id: string): MemRow {
    return deps.db
      .prepare('SELECT importance, effective_importance, valid_to, superseded_by_id FROM memories WHERE id = ?')
      .get(id) as MemRow;
  }

  describe('user importance is never mutated (Bug #2)', () => {
    it('stores the exact user-supplied importance; surprise boost goes to effective_importance', async () => {
      const result = await storeMemory(
        { content: 'completely novel fact about deep sea bioluminescence', importance: 0.8 },
        deps,
      );
      const row = getRow(result.id);
      expect(row.importance).toBe(0.8);
      expect(row.effective_importance).not.toBeNull();
      expect(row.effective_importance!).toBeGreaterThanOrEqual(0.8);
    });

    it('a dedup re-store can LOWER the user importance (last writer wins on the user field)', async () => {
      const first = await storeMemory(
        { content: 'the deploy pipeline uses blue-green strategy', importance: 0.9 },
        deps,
      );
      const second = await storeMemory(
        { content: 'the deploy pipeline uses blue-green strategy', importance: 0.3 },
        deps,
      );
      expect(second.id).toBe(first.id);
      const row = getRow(first.id);
      expect(row.importance).toBe(0.3);
      // System signal keeps the historical maximum
      expect(row.effective_importance!).toBeGreaterThanOrEqual(0.3);
    });
  });

  describe('updateAdaptiveImportance writes effective_importance, idempotently', () => {
    it('leaves memories.importance untouched and converges in one run', async () => {
      const result = await storeMemory(
        { content: 'frequently used trivia about owls', importance: 0.5 },
        deps,
      );
      deps.db
        .prepare("UPDATE memories SET access_count = 10, last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
        .run(result.id);

      updateAdaptiveImportance(deps.db, 'default');
      const afterFirst = getRow(result.id);
      expect(afterFirst.importance).toBe(0.5);
      expect(afterFirst.effective_importance!).toBeGreaterThan(0.5);

      updateAdaptiveImportance(deps.db, 'default');
      const afterSecond = getRow(result.id);
      // No ratchet: recomputing from the immutable user base is idempotent.
      expect(afterSecond.effective_importance).toBeCloseTo(afterFirst.effective_importance!, 6);
      expect(afterSecond.importance).toBe(0.5);
    });
  });

  describe('contradiction auto-supersede requires a mutually-exclusive predicate match', () => {
    it('still supersedes a genuine same-subject update', async () => {
      const lowThreshold = { ...deps, config: { ...deps.config, contradictionThreshold: 0.3 } };
      const old = await storeMemory(
        { content: 'The staging server is on port 3000' },
        lowThreshold,
      );
      const updated = await storeMemory(
        { content: 'The staging server is now on port 4000' },
        lowThreshold,
      );

      const row = getRow(old.id);
      expect(row.valid_to).not.toBeNull();
      expect(row.superseded_by_id).toBe(updated.id);
    });

    it('downgrades keyword-only false positives instead of invalidating the old memory', async () => {
      const lowThreshold = { ...deps, config: { ...deps.config, contradictionThreshold: 0.3 } };
      // Different subjects (sprint eleven vs sprint twelve); the keyword
      // heuristics alone score this past the old supersede bar
      // ('actually' negation 0.15 + numeric difference 0.4 = 0.55 > 0.5).
      const old = await storeMemory(
        { content: 'the api gateway sprint eleven retro covered 3 topics' },
        lowThreshold,
      );
      const next = await storeMemory(
        { content: 'the api gateway sprint twelve retro actually covered 5 topics' },
        lowThreshold,
      );

      expect(next.id).not.toBe(old.id);
      const row = getRow(old.id);
      // Old memory must NOT be invalidated — no claim-level evidence of a
      // mutually-exclusive update.
      expect(row.valid_to).toBeNull();
      expect(row.superseded_by_id).toBeNull();
    });
  });
});
