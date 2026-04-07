import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { computeNextReview, initReviewSchedule, reviewMemory, getReviewQueue } from '../../src/cognitive/spaced-repetition.js';

describe('computeNextReview (SM-2)', () => {
  it('resets interval on failed recall (quality < 3)', () => {
    const result = computeNextReview(10, 2.5, 5, 2);
    expect(result.interval).toBe(1);
  });

  it('sets 1-day interval for first review', () => {
    const result = computeNextReview(1, 2.5, 0, 4);
    expect(result.interval).toBe(1);
  });

  it('sets 6-day interval for second review', () => {
    const result = computeNextReview(1, 2.5, 1, 4);
    expect(result.interval).toBe(6);
  });

  it('increases interval on good recall', () => {
    const result = computeNextReview(6, 2.5, 2, 5);
    expect(result.interval).toBeGreaterThan(6);
  });

  it('maintains minimum ease factor of 1.3', () => {
    const result = computeNextReview(1, 1.3, 2, 0);
    expect(result.ease).toBeGreaterThanOrEqual(1.3);
  });
});

describe('spaced repetition DB operations', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('initializes review schedule for important memories', () => {
    insertTestMemory(ctx, { importance: 0.8 });
    insertTestMemory(ctx, { importance: 0.3 });

    const count = initReviewSchedule(ctx.db, 'default', 0.5);
    expect(count).toBe(1); // only the 0.8 importance one
  });

  it('returns overdue memories in review queue', () => {
    const id = insertTestMemory(ctx, { importance: 0.8 });
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    ctx.db.prepare('UPDATE memories SET next_review_at = ?, review_interval_days = 1 WHERE id = ?').run(pastDate, id);

    const queue = getReviewQueue(ctx.db, 'default', { limit: 10 });
    expect(queue).toHaveLength(1);
    expect(queue[0]!.days_overdue).toBeGreaterThan(0);
  });

  it('updates interval after review', () => {
    const id = insertTestMemory(ctx, { importance: 0.8 });
    ctx.db.prepare('UPDATE memories SET next_review_at = ?, review_interval_days = 1, ease_factor = 2.5, review_count = 0 WHERE id = ?')
      .run(new Date().toISOString(), id);

    const result = reviewMemory(ctx.db, id, 5);
    expect(result.new_interval_days).toBe(1); // first review → 1 day
    expect(result.review_count).toBe(1);
    expect(result.next_review_at).toBeDefined();
  });
});
