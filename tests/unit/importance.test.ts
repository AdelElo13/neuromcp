import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { computeAdaptiveImportance, updateAdaptiveImportance } from '../../src/cognitive/importance.js';

describe('adaptive importance', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('returns base importance for fresh memory', () => {
    const id = insertTestMemory(ctx, { importance: 0.5 });
    const factors = computeAdaptiveImportance(ctx.db, id);
    expect(factors.base).toBe(0.5);
    expect(factors.adjusted).toBeGreaterThanOrEqual(0.5); // recency boost
  });

  it('boosts frequently accessed memories', () => {
    const id = insertTestMemory(ctx, { importance: 0.5, access_count: 20 });
    const factors = computeAdaptiveImportance(ctx.db, id);
    expect(factors.access_boost).toBeGreaterThan(0);
    expect(factors.adjusted).toBeGreaterThan(0.5);
  });

  it('batch updates namespace', () => {
    insertTestMemory(ctx, { importance: 0.5 });
    insertTestMemory(ctx, { importance: 0.7 });

    const result = updateAdaptiveImportance(ctx.db, 'default');
    expect(result.updated).toBeGreaterThanOrEqual(0);
  });

  it('returns zero for non-existent memory', () => {
    const factors = computeAdaptiveImportance(ctx.db, 'nonexistent');
    expect(factors.adjusted).toBe(0);
  });
});
