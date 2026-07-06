import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, FakeEmbedder, type TestContext } from '../helpers/index.js';
import { compressMemories } from '../../src/consolidation/compress.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';

/**
 * compress.ts atomicity (v0.29 Fase 1B, Codex [HIGH]).
 *
 * Originals must not be tombstoned + de-vectored unless the digest is fully
 * embedded/indexed. A failure while producing the digest must leave the
 * originals intact (recoverable), never a state where originals are gone and
 * the digest is not searchable.
 */

const OLD = '2020-01-01T00:00:00.000Z';

describe('compressMemories — atomicity', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  async function seed(id: string, content: string): Promise<void> {
    insertTestMemory(ctx, { id, content, namespace: 'default', created_at: OLD });
    const e = await ctx.embedder.embed(content);
    ctx.vecStore.upsert(id, e);
  }

  it('does not tombstone originals when digest embedding fails', async () => {
    // Three near-identical old memories → one cluster to compress.
    await seed('m1', 'the deploy step runs npm build and npm test together');
    await seed('m2', 'the deploy step runs npm build and npm test in sequence');
    await seed('m3', 'the deploy step runs npm build then npm test');

    // Embedder that succeeds for clustering (embedBatch) but throws on the
    // single embed() used to index the digest — the exact seam the bug lives on.
    class FailOnDigestEmbedder extends FakeEmbedder {
      async embed(text: string): Promise<Float32Array> {
        if (text.startsWith('[digest]')) throw new Error('digest embed failed');
        return super.embed(text);
      }
    }
    const embedder: EmbeddingProvider = new FailOnDigestEmbedder();

    await expect(
      compressMemories(ctx.db, embedder, ctx.vecStore, 'default', { ageDays: 0, minCluster: 3, threshold: 0.5 }),
    ).rejects.toThrow();

    // Originals must still be active — the digest never became searchable, so
    // the compression must roll back rather than orphan the originals.
    const active = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM memories WHERE id IN ('m1','m2','m3') AND is_deleted = 0")
      .get() as { c: number };
    expect(active.c).toBe(3);

    // And their vectors must still be present.
    for (const id of ['m1', 'm2', 'm3']) {
      const vec = ctx.db.prepare('SELECT COUNT(*) AS c FROM memories_vec WHERE id = ?').get(id) as { c: number };
      expect(vec.c).toBe(1);
    }
  });

  it('successful compression tombstones originals and leaves a searchable digest', async () => {
    await seed('m1', 'the deploy step runs npm build and npm test together');
    await seed('m2', 'the deploy step runs npm build and npm test in sequence');
    await seed('m3', 'the deploy step runs npm build then npm test');

    const result = await compressMemories(ctx.db, ctx.embedder, ctx.vecStore, 'default', {
      ageDays: 0, minCluster: 3, threshold: 0.5,
    });
    expect(result.digests_created).toBe(1);
    expect(result.memories_compressed).toBe(3);

    // The digest exists, is active, and has a vector.
    const digest = ctx.db
      .prepare("SELECT id FROM memories WHERE source = 'consolidation' AND is_deleted = 0 AND json_extract(metadata,'$.type') = 'digest'")
      .get() as { id: string } | undefined;
    expect(digest).toBeDefined();
    const vec = ctx.db.prepare('SELECT COUNT(*) AS c FROM memories_vec WHERE id = ?').get(digest!.id) as { c: number };
    expect(vec.c).toBe(1);
  });
});
