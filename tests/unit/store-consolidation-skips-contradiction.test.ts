import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { storeMemory, type StoreDeps } from '../../src/tools/store.js';

/**
 * v0.29.5 graph hygiene — root cause of the polluted knowledge graph.
 *
 * The consolidation job stores a daily report with `source: consolidation`
 * ("Consolidation run on 2026-09-13 merged 258 decayed 2255 …"). Each
 * report differs from the previous one only in date and counters, which is
 * exactly what the numeric-diff contradiction heuristic fires on. Every run
 * therefore produced a 'contradicts' edge plus a synthetic `memory:…` proxy
 * entity for both reports: 54 proxies and >150 bogus edges on the reference
 * machine (59 such reports with source 'consolidation' in that DB).
 *
 * The system's own output is a time series, not competing claims.
 * Contradiction detection must skip it — gated on the RESERVED source, not
 * on a category: `meta` is a free-form category users store real facts
 * under (scripts/migrate-memory.ts stores "Self Awareness" facts as
 * category meta, source user) and those keep full protection.
 */

const REPORT_A = 'Consolidation run on 2026-09-13 merged 258 decayed 2255 pruned 0 promoted 4';
// Counters chosen so the positional FakeEmbedder lands in the detector's
// window (0.82 < similarity < 0.999): measured 0.867 → 'coexist'.
const REPORT_B = 'Consolidation run on 2026-09-14 merged 1260 decayed 97 pruned 33 promoted 12';

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

function syntheticEntities(ctx: TestContext): number {
  return (ctx.db.prepare(
    "SELECT COUNT(*) AS n FROM entities WHERE entity_type = 'memory' AND name LIKE 'memory:%' AND is_deleted = 0",
  ).get() as { n: number }).n;
}

describe('storeMemory — source consolidation skips contradiction detection', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('control: the same two reports stored as source user DO produce a contradicts edge', async () => {
    // Proves the fixture actually trips the detector, so the negative cases
    // below are real and not vacuous passes.
    const a = await storeMemory({ content: REPORT_A, source: 'user' }, deps(ctx));
    const b = await storeMemory({ content: REPORT_B, source: 'user' }, deps(ctx));
    expect(a.matched).toBe(false);
    expect(b.matched).toBe(false);
    expect(contradictsEdges(ctx)).toBeGreaterThan(0);
    expect(syntheticEntities(ctx)).toBeGreaterThan(0);
  });

  it('consolidation reports never create contradicts edges or synthetic memory: entities', async () => {
    const a = await storeMemory({ content: REPORT_A, source: 'consolidation', category: 'meta' }, deps(ctx));
    const b = await storeMemory({ content: REPORT_B, source: 'consolidation', category: 'meta' }, deps(ctx));
    expect(a.matched).toBe(false);
    expect(b.matched).toBe(false);
    expect(contradictsEdges(ctx)).toBe(0);
    expect(syntheticEntities(ctx)).toBe(0);
  });

  it('a USER memory under category meta keeps contradiction protection (Codex PR-18 P2)', async () => {
    // The gate must be the reserved source, never the free-form category.
    await storeMemory({ content: REPORT_A, source: 'user', category: 'meta' }, deps(ctx));
    await storeMemory({ content: REPORT_B, source: 'user', category: 'meta' }, deps(ctx));
    expect(contradictsEdges(ctx)).toBeGreaterThan(0);
  });
});
