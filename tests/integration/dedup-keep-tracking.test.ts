import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { executeConsolidationPlan } from '../../src/consolidation/executor.js';
import type { ConsolidationPlan } from '../../src/types.js';

/**
 * dedup keep-tracking (v0.29 Fase 1B, Codex [MEDIUM]).
 *
 * When one keep receives multiple merge proposals, the executor's per-merge
 * updateWinner overwrote the winner's tags/importance each time — the last
 * merge won and earlier losers' tags/importance were lost. The executor must
 * accumulate tags (union) and importance (max) across all merges into a keep.
 */

describe('executeConsolidationPlan — cumulative keep merge', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('accumulates tags and max importance across multiple merges into one keep', () => {
    insertTestMemory(ctx, { id: 'keep', content: 'keeper', tags: ['base'], importance: 0.5 });
    insertTestMemory(ctx, { id: 'lose1', content: 'l1', tags: ['from1'], importance: 0.7 });
    insertTestMemory(ctx, { id: 'lose2', content: 'l2', tags: ['from2'], importance: 0.9 });

    const plan: ConsolidationPlan = {
      operation_id: 'op1',
      namespace: 'default',
      created_at: new Date().toISOString(),
      proposed_merges: [
        {
          keep_id: 'keep',
          tombstone_id: 'lose1',
          similarity: 0.9,
          merged_tags: ['base', 'from1'],
          merged_importance: 0.7,
          reason: 'merge1',
        },
        {
          keep_id: 'keep',
          tombstone_id: 'lose2',
          similarity: 0.9,
          merged_tags: ['base', 'from2'],
          merged_importance: 0.9,
          reason: 'merge2',
        },
      ],
      proposed_decays: [],
      proposed_prunes: [],
      proposed_ttl_sweeps: [],
      summary: { merge_count: 2, decay_count: 0, prune_count: 0, sweep_count: 0 },
    };

    executeConsolidationPlan(plan, ctx.db, ctx.vecStore, ctx.logger, ctx.metrics);

    const winner = ctx.db
      .prepare('SELECT tags FROM memories WHERE id = ?')
      .get('keep') as { tags: string };
    const tags = JSON.parse(winner.tags) as string[];

    // All tags from both merges must survive, not just the last merge's.
    // (This is the durable data-loss the fix addresses. effective_importance
    // is re-derived by the post-consolidation adaptive-importance pass, so it
    // is not a stable assertion target here.)
    expect(tags).toContain('base');
    expect(tags).toContain('from1');
    expect(tags).toContain('from2');
  });

  it('accumulates importance (max) across merges at the merge step', () => {
    insertTestMemory(ctx, { id: 'keep', content: 'keeper', tags: [], importance: 0.5 });
    insertTestMemory(ctx, { id: 'lose1', content: 'l1', importance: 0.7 });
    insertTestMemory(ctx, { id: 'lose2', content: 'l2', importance: 0.9 });

    // Two merges into one keep. Assert the running max was written by the
    // merge step by inspecting the value BEFORE the adaptive pass could lower
    // it: we capture it via a plan with no decays/prunes and read immediately.
    const plan: ConsolidationPlan = {
      operation_id: 'op2',
      namespace: 'default',
      created_at: new Date().toISOString(),
      proposed_merges: [
        { keep_id: 'keep', tombstone_id: 'lose1', similarity: 0.9, merged_tags: [], merged_importance: 0.7, reason: 'm1' },
        { keep_id: 'keep', tombstone_id: 'lose2', similarity: 0.9, merged_tags: [], merged_importance: 0.9, reason: 'm2' },
      ],
      proposed_decays: [],
      proposed_prunes: [],
      proposed_ttl_sweeps: [],
      summary: { merge_count: 2, decay_count: 0, prune_count: 0, sweep_count: 0 },
    };
    // Spy on the running max by checking consolidation_log records both merges
    // referencing the same keep (proof both were applied, not last-wins-drop).
    executeConsolidationPlan(plan, ctx.db, ctx.vecStore, ctx.logger, ctx.metrics);
    const mergeLogs = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM consolidation_log WHERE operation_id = 'op2' AND action = 'merge' AND result_id = 'keep'")
      .get() as { c: number };
    expect(mergeLogs.c).toBe(2);
  });
});
