import type Database from 'better-sqlite3';
import type { Memory } from '../types.js';

export interface ReviewItem {
  readonly memory: Memory;
  readonly days_overdue: number;
  readonly review_count: number;
  readonly interval_days: number;
}

export interface ReviewResult {
  readonly memory_id: string;
  readonly new_interval_days: number;
  readonly new_ease_factor: number;
  readonly next_review_at: string;
  readonly review_count: number;
}

/**
 * SM-2 algorithm for spaced repetition.
 *
 * quality: 0-5
 *   0 = complete blackout
 *   1 = wrong, remembered after seeing answer
 *   2 = wrong, but easy to recall after seeing answer
 *   3 = correct with serious difficulty
 *   4 = correct after hesitation
 *   5 = perfect recall
 */
export function computeNextReview(
  currentInterval: number,
  currentEase: number,
  reviewCount: number,
  quality: number,
): { interval: number; ease: number } {
  // Clamp quality
  const q = Math.max(0, Math.min(5, quality));

  // Update ease factor: EF' = EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
  let newEase = currentEase + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  newEase = Math.max(1.3, newEase); // minimum ease

  let newInterval: number;
  if (q < 3) {
    // Failed recall — reset to 1 day
    newInterval = 1;
  } else if (reviewCount === 0) {
    newInterval = 1;
  } else if (reviewCount === 1) {
    newInterval = 6;
  } else {
    newInterval = Math.round(currentInterval * newEase);
  }

  return { interval: newInterval, ease: newEase };
}

/**
 * Get memories due for review, ordered by overdue + importance.
 */
export function getReviewQueue(
  db: Database.Database,
  namespace: string,
  options: { limit?: number; minImportance?: number } = {},
): readonly ReviewItem[] {
  const limit = options.limit ?? 10;
  const minImportance = options.minImportance ?? 0.3;
  const now = new Date().toISOString();

  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE namespace = ? AND is_deleted = 0
      AND next_review_at IS NOT NULL
      AND next_review_at <= ?
      AND importance >= ?
    ORDER BY next_review_at ASC, importance DESC
    LIMIT ?
  `).all(namespace, now, minImportance, limit) as Memory[];

  return rows.map(mem => {
    const nextReview = new Date(mem.next_review_at ?? now);
    const daysOverdue = Math.max(0, (Date.now() - nextReview.getTime()) / (1000 * 60 * 60 * 24));
    return {
      memory: mem,
      days_overdue: Math.round(daysOverdue * 10) / 10,
      review_count: mem.review_count ?? 0,
      interval_days: mem.review_interval_days ?? 1,
    };
  });
}

/**
 * Process a review: update interval, ease, and next review date.
 */
export function reviewMemory(
  db: Database.Database,
  memoryId: string,
  quality: number,
): ReviewResult {
  const mem = db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) as Record<string, unknown> | undefined;
  if (!mem) throw new Error(`Memory not found: ${memoryId}`);

  const currentInterval = (mem.review_interval_days as number) ?? 1;
  const currentEase = (mem.ease_factor as number) ?? 2.5;
  const reviewCount = (mem.review_count as number) ?? 0;

  const { interval, ease } = computeNextReview(currentInterval, currentEase, reviewCount, quality);
  const nextReview = new Date(Date.now() + interval * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    UPDATE memories SET
      review_interval_days = ?,
      ease_factor = ?,
      next_review_at = ?,
      review_count = ?,
      access_count = access_count + 1,
      last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(interval, ease, nextReview, reviewCount + 1, memoryId);

  return {
    memory_id: memoryId,
    new_interval_days: interval,
    new_ease_factor: ease,
    next_review_at: nextReview,
    review_count: reviewCount + 1,
  };
}

/**
 * Initialize spaced repetition for important memories that don't have it yet.
 */
export function initReviewSchedule(
  db: Database.Database,
  namespace: string,
  minImportance: number = 0.5,
): number {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE memories SET
      next_review_at = ?,
      review_interval_days = 1,
      ease_factor = 2.5,
      review_count = 0
    WHERE namespace = ? AND is_deleted = 0
      AND importance >= ?
      AND next_review_at IS NULL
  `).run(now, namespace, minImportance);

  return result.changes;
}
