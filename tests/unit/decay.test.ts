import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory } from '../helpers/index.js';
import type { TestContext } from '../helpers/index.js';
import { computeDecay } from '../../src/consolidation/decay.js';

describe('computeDecay', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestDb();
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  it('computes decay formula correctly', () => {
    const daysAgo = 30;
    const oldDate = new Date(Date.now() - daysAgo * 86_400_000).toISOString();

    insertTestMemory(ctx, {
      importance: 1.0,
      created_at: oldDate,
      last_accessed_at: null,
      source: 'auto',
      source_trust: 'medium',
    });

    const lambda = 0.05;
    const { decays } = computeDecay(ctx.db, 'default', lambda, 0.01);

    expect(decays.length).toBe(1);

    const expected = 1.0 * Math.exp(-lambda * daysAgo);
    // Allow some tolerance for time differences during test execution
    expect(decays[0]!.new_importance).toBeCloseTo(expected, 1);
    expect(decays[0]!.days_since_access).toBeCloseTo(daysAgo, 0);
  });

  it('uses last_accessed_at if available', () => {
    const accessDaysAgo = 10;
    const createdDaysAgo = 60;
    const accessDate = new Date(
      Date.now() - accessDaysAgo * 86_400_000,
    ).toISOString();
    const createdDate = new Date(
      Date.now() - createdDaysAgo * 86_400_000,
    ).toISOString();

    insertTestMemory(ctx, {
      importance: 1.0,
      created_at: createdDate,
      last_accessed_at: accessDate,
      source: 'auto',
      source_trust: 'medium',
    });

    const lambda = 0.05;
    const { decays } = computeDecay(ctx.db, 'default', lambda, 0.01);

    expect(decays.length).toBe(1);
    // Should use last_accessed_at (10 days ago), not created_at (60 days ago)
    expect(decays[0]!.days_since_access).toBeCloseTo(accessDaysAgo, 0);
  });

  it('identifies prune candidates correctly', () => {
    const oldDate = new Date(Date.now() - 60 * 86_400_000).toISOString();

    insertTestMemory(ctx, {
      importance: 0.1,
      created_at: oldDate,
      last_accessed_at: null,
      access_count: 0,
      source: 'auto',
      source_trust: 'medium',
    });

    const { prunes } = computeDecay(ctx.db, 'default', 0.05, 0.5);

    expect(prunes.length).toBe(1);
    expect(prunes[0]!.access_count).toBeLessThan(3);
    expect(prunes[0]!.age_days).toBeGreaterThan(30);
  });

  it('does not prune high trust memories', () => {
    const oldDate = new Date(Date.now() - 60 * 86_400_000).toISOString();

    insertTestMemory(ctx, {
      importance: 0.1,
      created_at: oldDate,
      last_accessed_at: null,
      access_count: 0,
      source: 'auto',
      source_trust: 'high',
    });

    const { prunes } = computeDecay(ctx.db, 'default', 0.05, 0.5);

    expect(prunes.length).toBe(0);
  });

  it('does not prune user-sourced memories', () => {
    const oldDate = new Date(Date.now() - 60 * 86_400_000).toISOString();

    insertTestMemory(ctx, {
      importance: 0.1,
      created_at: oldDate,
      last_accessed_at: null,
      access_count: 0,
      source: 'user',
      source_trust: 'medium',
    });

    const { prunes } = computeDecay(ctx.db, 'default', 0.05, 0.5);

    expect(prunes.length).toBe(0);
  });

  it('skips memories with insignificant decay (< 0.01)', () => {
    // Recently created memory with low lambda = negligible decay
    const recentDate = new Date(Date.now() - 1000).toISOString();

    insertTestMemory(ctx, {
      importance: 0.5,
      created_at: recentDate,
      last_accessed_at: recentDate,
      source: 'auto',
      source_trust: 'medium',
    });

    const { decays } = computeDecay(ctx.db, 'default', 0.001, 0.01);

    expect(decays.length).toBe(0);
  });
});
