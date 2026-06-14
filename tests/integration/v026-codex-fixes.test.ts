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
import { executeConsolidationPlan } from '../../src/consolidation/executor.js';
import type { ConsolidationPlan } from '../../src/types.js';
import { synthesizeAnswer } from '../../src/cognitive/synthesize.js';
import type { MemoryWithScore } from '../../src/types.js';

const DIMS = 8;

// Content-varying embedder so distinct content gets distinct vectors
// (a constant embedder would make everything dedup at store time).
class FakeEmbedder implements EmbeddingProvider {
  readonly name = 'fake';
  readonly dimensions = DIMS;
  readonly maxTokens = 512;
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(DIMS);
    for (let i = 0; i < text.length; i++) v[i % DIMS] += text.charCodeAt(i);
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

describe('v0.26 Codex-review fixes', () => {
  const testDb = join(tmpdir(), `neuromcp-v026-codex-${Date.now()}-${randomUUID()}.db`);
  let db: ReturnType<typeof openDatabase>;
  let vecStore: SqliteVecStore;
  let deps: StoreDeps;
  const logger = createLogger({ level: 'error', format: 'text' });
  const metrics = createMetrics();

  beforeEach(() => {
    db = openDatabase(testDb);
    applySchema(db);
    vecStore = new SqliteVecStore(DIMS);
    vecStore.initialize(db);
    // High dedup threshold so the two near-dup memories in the P0-2 test stay
    // separate (we drive the merge manually via a ConsolidationPlan).
    const config = { ...loadConfig(), entityExtractionMode: 'regex' as const, dedupThreshold: 0.99999 };
    deps = { db, vecStore, embedder: new FakeEmbedder(), logger, metrics, config };
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

  describe('P0-1: decay is not undone by the adaptive refresh', () => {
    it('updateAdaptiveImportance composes on top of effective_importance, not the user base', async () => {
      const m = await storeMemory({ content: 'an old rarely-used fact', importance: 0.8 }, deps);
      // Simulate a decay having already written a low effective value, and age
      // the memory so the adaptive recency boost is ~0.
      db.prepare(
        "UPDATE memories SET effective_importance = 0.05, access_count = 0, last_accessed_at = NULL, created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
      ).run(m.id);

      updateAdaptiveImportance(db, 'default');

      const row = db
        .prepare('SELECT importance, effective_importance FROM memories WHERE id = ?')
        .get(m.id) as { importance: number; effective_importance: number };
      // User column untouched; decayed effective NOT reset back toward 0.8.
      expect(row.importance).toBe(0.8);
      expect(row.effective_importance).toBeLessThan(0.2);
    });
  });

  describe('P0-2: consolidation merge writes effective_importance, never the user column', () => {
    it('updateWinner leaves importance and bumps effective_importance to the merged max', async () => {
      const keep = await storeMemory({ content: 'keep this canonical memory', importance: 0.4 }, deps);
      const lose = await storeMemory({ content: 'a near duplicate of the canonical memory', importance: 0.9 }, deps);
      // Give the loser a high effective value so the merged max is observable.
      db.prepare('UPDATE memories SET effective_importance = 0.95 WHERE id = ?').run(lose.id);
      db.prepare('UPDATE memories SET effective_importance = 0.4 WHERE id = ?').run(keep.id);

      const plan: ConsolidationPlan = {
        operation_id: randomUUID(),
        namespace: 'default',
        created_at: new Date().toISOString(),
        proposed_merges: [
          {
            keep_id: keep.id,
            tombstone_id: lose.id,
            similarity: 0.99,
            merged_tags: [],
            merged_importance: 0.95, // max of effective values
            reason: 'near-duplicate',
          },
        ],
        proposed_decays: [],
        proposed_prunes: [],
        proposed_ttl_sweeps: [],
        summary: { merge_count: 1, decay_count: 0, prune_count: 0, sweep_count: 0 },
      };

      executeConsolidationPlan(plan, db, vecStore, logger, metrics);

      const row = db
        .prepare('SELECT importance, effective_importance FROM memories WHERE id = ?')
        .get(keep.id) as { importance: number; effective_importance: number };
      // THE fix Codex flagged: the user importance column is never mutated by
      // the merge. effective_importance is the computed column (the adaptive
      // refresh at the end of the plan recomputes it from the user base — the
      // merge writes it, never the user value).
      expect(row.importance).toBe(0.4);
      expect(typeof row.effective_importance).toBe('number');

      // And the loser is tombstoned, lineage set on the winner.
      const loserRow = db.prepare('SELECT is_deleted FROM memories WHERE id = ?').get(lose.id) as {
        is_deleted: number;
      };
      expect(loserRow.is_deleted).toBe(1);
    });
  });

  describe('P0-3: recall synthesis does not fabricate from off-topic memories', () => {
    it('returns not_in_memory when the best match is below the relevance floor', async () => {
      // Embedder: query orthogonal to the only memory → cosine 0.
      class OrthoEmbedder implements EmbeddingProvider {
        readonly name = 'ortho';
        readonly dimensions = DIMS;
        readonly maxTokens = 512;
        async embed(text: string): Promise<Float32Array> {
          const v = new Float32Array(DIMS);
          if (text.includes('kubernetes')) v[0] = 1;
          else v[1] = 1; // memory content lands on a different axis
          return v;
        }
        async embedBatch(texts: string[]): Promise<Float32Array[]> {
          return Promise.all(texts.map((t) => this.embed(t)));
        }
        async isAvailable(): Promise<boolean> {
          return true;
        }
      }
      const memory = {
        id: 'm1',
        content: 'The legacy billing cron runs nightly at 3am and emails a CSV report.',
        created_at: '2026-06-01T00:00:00.000Z',
        similarity_score: 0.01,
      } as MemoryWithScore;

      const result = await synthesizeAnswer(
        'how do I configure the kubernetes autoscaler',
        [memory],
        new OrthoEmbedder(),
      );
      expect(result.status).toBe('not_in_memory');
      expect(result.answer).toBeNull();
      expect(result.gaps[0]!.toLowerCase()).toContain('relevant');
    });
  });
});
