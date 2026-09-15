import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { storeMemory, type StoreDeps } from '../../src/tools/store.js';
import { MEMORY_PROXY_TYPE } from '../../src/graph/memory-proxy.js';

/**
 * v0.29.5 graph hygiene — root cause of the polluted knowledge graph.
 *
 * A 'contradicts' edge is an assertion (it feeds explain.contradictions for
 * downstream LLMs), so it needs claim-level evidence: same subject,
 * mutually-exclusive predicate, different object. The keyword heuristics
 * (numeric diff, negation words) alone yield 'flag' — reported in the store
 * result, never materialised as an edge or a proxy entity.
 *
 * Before: every daily consolidation report ("… merged 258 …" vs
 * "… merged 260 …") tripped the numeric-diff heuristic → 'coexist' → an
 * edge plus a synthetic proxy entity per report. 54 proxies and >150 bogus
 * edges on the reference machine. No producer-based gate (source /
 * category) can fix that: neither field is reserved (Codex PR-18 [P2],
 * two rounds) — the evidence requirement is the fix.
 */

// Numeric diff + similar wording, but NO claim-level evidence: "took" is not
// a mutually-exclusive predicate (measured similarity 0.995 under the
// positional FakeEmbedder — inside the detector's 0.82–0.999 window).
const EVENT_A = 'the nightly deploy took 45 minutes on 2026-09-13 for the api';
const EVENT_B = 'the nightly deploy took 90 minutes on 2026-09-14 for the web';

// The real daily consolidation report. NOTE: the triple extractor reads the
// noun "run" as the predicate "run" ({Consolidation, run, "on 2026-09-14 …"}),
// so this pair DOES carry (spurious) claim evidence — tracked as P3 in
// FOUND-DURING-FIX.md. It is used here only to prove there is no
// producer-based gate: source/category never change the outcome.
const REPORT_A = 'Consolidation run on 2026-09-13 merged 258 decayed 2255 pruned 0 promoted 4';
const REPORT_B = 'Consolidation run on 2026-09-14 merged 1260 decayed 97 pruned 33 promoted 12';

// Same subject ("project"), mutually-exclusive predicate ("uses"), different
// object — measured similarity 0.938, numeric diff → score 0.4 → coexist.
const CLAIM_A = 'the project uses React 18 on the customer portal';
const CLAIM_B = 'the project uses Svelte 5 on the customer portal';

function deps(ctx: TestContext): StoreDeps {
  return {
    db: ctx.db, vecStore: ctx.vecStore, embedder: ctx.embedder,
    logger: ctx.logger, metrics: ctx.metrics, config: ctx.config,
  };
}

function contradictsEdges(ctx: TestContext): number {
  return (ctx.db.prepare(
    "SELECT COUNT(*) AS n FROM relations WHERE relation_type = 'contradicts' AND is_deleted = 0",
  ).get() as { n: number }).n;
}

function proxyEntities(ctx: TestContext): number {
  return (ctx.db.prepare(
    'SELECT COUNT(*) AS n FROM entities WHERE entity_type = ? AND is_deleted = 0',
  ).get(MEMORY_PROXY_TYPE) as { n: number }).n;
}

describe('storeMemory — contradicts edges require claim-level evidence', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('control: a claim-backed contradiction DOES create an edge and proxy entities', async () => {
    // Proves the pipeline still materialises real contradictions, so the
    // negative cases below are meaningful.
    const a = await storeMemory({ content: CLAIM_A }, deps(ctx));
    const b = await storeMemory({ content: CLAIM_B }, deps(ctx));
    expect(a.matched).toBe(false);
    expect(b.matched).toBe(false);
    expect(b.contradictions?.map((c) => c.resolution)).toEqual(['coexist']);
    expect(contradictsEdges(ctx)).toBe(1);
    expect(proxyEntities(ctx)).toBe(2);
  });

  it('heuristic-only contradictions are reported as flag but create no edge and no proxy', async () => {
    const a = await storeMemory({ content: EVENT_A }, deps(ctx));
    const b = await storeMemory({ content: EVENT_B }, deps(ctx));
    expect(a.matched).toBe(false);
    expect(b.matched).toBe(false);
    // Still visible to the caller — the numeric diff is a real signal …
    expect(b.contradictions?.map((c) => c.resolution)).toEqual(['flag']);
    // … but not an assertion in the graph.
    expect(contradictsEdges(ctx)).toBe(0);
    expect(proxyEntities(ctx)).toBe(0);
  });

  it('source and category never change the outcome — no producer-based gate (Codex PR-18 P2)', async () => {
    // Same pair stored as the system would store it and as a user would:
    // identical result either way. (Whatever the extractor decides about
    // the report pair, it must decide it the same for both producers.)
    const asSystem = setupTestDb();
    try {
      await storeMemory({ content: REPORT_A, source: 'consolidation', category: 'meta' }, deps(asSystem));
      await storeMemory({ content: REPORT_B, source: 'consolidation', category: 'meta' }, deps(asSystem));
      await storeMemory({ content: REPORT_A, source: 'user', category: 'general' }, deps(ctx));
      await storeMemory({ content: REPORT_B, source: 'user', category: 'general' }, deps(ctx));
      expect(contradictsEdges(asSystem)).toBe(contradictsEdges(ctx));
      expect(proxyEntities(asSystem)).toBe(proxyEntities(ctx));
    } finally {
      teardownTestDb(asSystem);
    }

    // And a user memory under category meta keeps full detection: the
    // claim-backed pair still links.
    const before = contradictsEdges(ctx);
    await storeMemory({ content: CLAIM_A, source: 'user', category: 'meta' }, deps(ctx));
    await storeMemory({ content: CLAIM_B, source: 'user', category: 'meta' }, deps(ctx));
    expect(contradictsEdges(ctx)).toBe(before + 1);
  });

  it('proxy entities carry the reserved type and a back-reference to their memory', async () => {
    const a = await storeMemory({ content: CLAIM_A }, deps(ctx));
    await storeMemory({ content: CLAIM_B }, deps(ctx));
    const rows = ctx.db.prepare(
      'SELECT name, entity_type, metadata FROM entities WHERE entity_type = ? ORDER BY created_at',
    ).all(MEMORY_PROXY_TYPE) as Array<{ name: string; entity_type: string; metadata: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.name.startsWith('memory:'))).toBe(true);
    const refs = rows.map((r) => (JSON.parse(r.metadata) as { proxy_for_memory_id?: string }).proxy_for_memory_id);
    expect(refs).toContain(a.id);
  });
});
