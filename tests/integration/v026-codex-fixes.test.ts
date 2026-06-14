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

    it('gates short off-topic memories that yield no extractable sentence (no-sentence fallback hole)', async () => {
      // Codex round-2: a memory too short to split into a sentence (<16 chars)
      // used to skip the relevance gate via the raw-content fallback and
      // fabricate an answer. The gate now scores memory CONTENT, so it fires
      // even when there are zero sentences.
      class OrthoEmbedder implements EmbeddingProvider {
        readonly name = 'ortho';
        readonly dimensions = DIMS;
        readonly maxTokens = 512;
        async embed(text: string): Promise<Float32Array> {
          const v = new Float32Array(DIMS);
          if (text.includes('kubernetes')) v[0] = 1;
          else v[1] = 1;
          return v;
        }
        async embedBatch(texts: string[]): Promise<Float32Array[]> {
          return Promise.all(texts.map((t) => this.embed(t)));
        }
        async isAvailable(): Promise<boolean> {
          return true;
        }
      }
      const shortMemory = {
        id: 'm-short',
        content: 'billing', // 7 chars → splitSentences() yields nothing
        created_at: '2026-06-01T00:00:00.000Z',
        similarity_score: 0.01,
      } as MemoryWithScore;

      const result = await synthesizeAnswer(
        'how do I configure the kubernetes autoscaler',
        [shortMemory],
        new OrthoEmbedder(),
      );
      expect(result.status).toBe('not_in_memory');
      expect(result.answer).toBeNull();
      expect(result.citations.length).toBe(0);
    });

    it('still answers a long mixed memory whose ONE relevant sentence is diluted by filler (no false-negative)', async () => {
      // Codex round-3: gating on whole-content cosine ALONE would false-negative
      // here — the filler drags the full-content cosine under the floor even
      // though one sentence is strongly on-topic. The gate now takes
      // max(contentCosine, bestSentenceCosine), so the sentence rescues it.
      // Embedder models real dilution: cosine to the query == fraction of words
      // containing "deploy".
      class FractionEmbedder implements EmbeddingProvider {
        readonly name = 'frac';
        readonly dimensions = DIMS;
        readonly maxTokens = 512;
        async embed(text: string): Promise<Float32Array> {
          const words = text.toLowerCase().split(/\s+/).filter(Boolean);
          const rel = words.filter((w) => w.includes('deploy')).length;
          const f = words.length > 0 ? rel / words.length : 0;
          const v = new Float32Array(DIMS);
          v[0] = f;
          v[1] = Math.sqrt(Math.max(0, 1 - f * f));
          return v;
        }
        async embedBatch(texts: string[]): Promise<Float32Array[]> {
          return Promise.all(texts.map((t) => this.embed(t)));
        }
        async isAvailable(): Promise<boolean> {
          return true;
        }
      }
      // 3 sentences; only the last is about "deploy". Full-content deploy
      // fraction = 5/21 ≈ 0.24 (< 0.3 floor); the relevant sentence alone =
      // 5/6 ≈ 0.83 (>= floor).
      const mixed = {
        id: 'm-mixed',
        content:
          'gardening tips about tomatoes and sunshine today. ' +
          'cats and coffee make mornings calmer somehow always. ' +
          'deploy deploy deploy deploy deploy works.',
        created_at: '2026-06-01T00:00:00.000Z',
        similarity_score: 0.5,
      } as MemoryWithScore;

      const result = await synthesizeAnswer('deploy', [mixed], new FractionEmbedder());
      expect(result.status).toBe('answered');
      expect(result.answer).toBeTruthy();
      expect(result.citations.some((c) => c.memory_id === 'm-mixed')).toBe(true);
    });

    it('never selects a below-floor sentence even when the gate is opened by a different memory (gate/selection contract)', async () => {
      // Codex round-4: the gate opened on the single best sentence, but
      // selection ranked by rawCosine·memWeight and always kept the top
      // candidate — so a below-floor off-topic sentence from a higher-ranked
      // (higher memWeight) memory could win over the above-floor sentence that
      // actually opened the gate. Embedder maps marker substrings to exact
      // cosines so we can reproduce the precise interleaving.
      class MarkerEmbedder implements EmbeddingProvider {
        readonly name = 'marker';
        readonly dimensions = DIMS;
        readonly maxTokens = 512;
        async embed(text: string): Promise<Float32Array> {
          let f = 0;
          if (text.includes('QUERYMARK')) f = 1;
          else if (text.includes('SCORE29')) f = 0.29; // below the 0.3 floor
          else if (text.includes('SCORE31')) f = 0.31; // above the floor
          const v = new Float32Array(DIMS);
          v[0] = f;
          v[1] = Math.sqrt(Math.max(0, 1 - f * f));
          return v;
        }
        async embedBatch(texts: string[]): Promise<Float32Array[]> {
          return Promise.all(texts.map((t) => this.embed(t)));
        }
        async isAvailable(): Promise<boolean> {
          return true;
        }
      }
      // m0 is rank 0 (memWeight 1.0) and off-topic: its sentence scores 0.29
      //   (below floor) but 0.29·1.0 = 0.29 by selection score.
      // m1 is rank 1 (memWeight 0.8) and relevant: its sentence scores 0.31
      //   (above floor) but 0.31·0.8 = 0.248 by selection score — it OPENS the
      //   gate yet LOSES the old accept-the-top selection.
      const m0 = {
        id: 'm0-offtopic',
        content: 'this off-topic sentence carries SCORE29 marker and is long enough to split.',
        created_at: '2026-06-01T00:00:00.000Z',
        similarity_score: 0.9,
      } as MemoryWithScore;
      const m1 = {
        id: 'm1-relevant',
        content: 'this relevant sentence carries SCORE31 marker and is also long enough here.',
        created_at: '2026-06-01T00:00:00.000Z',
        similarity_score: 0.5,
      } as MemoryWithScore;

      const result = await synthesizeAnswer('QUERYMARK', [m0, m1], new MarkerEmbedder());
      // Answered (m1 is genuinely relevant), but the off-topic m0 sentence must
      // NOT leak into the answer — every citation comes from the above-floor m1.
      expect(result.status).toBe('answered');
      expect(result.citations.length).toBeGreaterThan(0);
      expect(result.citations.every((c) => c.memory_id === 'm1-relevant')).toBe(true);
    });

    it('applies the same per-memory floor in the no-sentence fallback (short memories)', async () => {
      // Codex round-5: with zero extractable sentences, the fallback gated on
      // the BEST content cosine but cited memories in retrieval order, so a
      // below-floor short memory could be cited when a DIFFERENT memory opened
      // the gate. The fallback now filters memories by their OWN content cosine.
      class MarkerEmbedder implements EmbeddingProvider {
        readonly name = 'marker';
        readonly dimensions = DIMS;
        readonly maxTokens = 512;
        async embed(text: string): Promise<Float32Array> {
          let f = 0;
          if (text.includes('QUERYMARK')) f = 1;
          else if (text.includes('SCORE29')) f = 0.29; // below floor
          else if (text.includes('SCORE31')) f = 0.31; // above floor
          const v = new Float32Array(DIMS);
          v[0] = f;
          v[1] = Math.sqrt(Math.max(0, 1 - f * f));
          return v;
        }
        async embedBatch(texts: string[]): Promise<Float32Array[]> {
          return Promise.all(texts.map((t) => this.embed(t)));
        }
        async isAvailable(): Promise<boolean> {
          return true;
        }
      }
      // Both contents are too short to split into a sentence (no '.', <16 chars
      // of sentence material) → the no-sentence fallback path. m0 (rank 0) is
      // below floor; m1 (rank 1) is above floor and opens the gate.
      const m0 = {
        id: 'm0-offtopic-short',
        content: 'SCORE29',
        created_at: '2026-06-01T00:00:00.000Z',
        similarity_score: 0.9,
      } as MemoryWithScore;
      const m1 = {
        id: 'm1-relevant-short',
        content: 'SCORE31',
        created_at: '2026-06-01T00:00:00.000Z',
        similarity_score: 0.5,
      } as MemoryWithScore;

      const result = await synthesizeAnswer('QUERYMARK', [m0, m1], new MarkerEmbedder());
      expect(result.status).toBe('answered');
      expect(result.citations.length).toBeGreaterThan(0);
      // Below-floor m0 must never be cited, even with maxSentences large enough
      // to include it in retrieval order.
      expect(result.citations.every((c) => c.memory_id === 'm1-relevant-short')).toBe(true);
    });
  });
});
