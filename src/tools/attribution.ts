/**
 * attribution.ts — retrieval attribution + critic-scored usefulness.
 *
 * Implements Codex's brutal critique of speculative reflection: before
 * synthesizing insights, learn which memories actually help. Every search
 * can emit a retrieval event, every response can cite memory IDs, and a
 * cheap critic pass labels each cited memory helpful/neutral/harmful.
 *
 * Usefulness scores are applied as a multiplicative prior during search
 * ranking — a memory that helped three times ranks above one that has
 * never been proven useful, even at equal hybrid score.
 */
import type { Database } from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import type { Logger } from '../observability/logger.js';

export interface LogRetrievalArgs {
  query: string;
  namespace?: string;
  retrieved_ids: string[];
  cited_ids?: string[];
  outcome?: 'helpful' | 'neutral' | 'harmful';
  critic_reason?: string;
  model?: string;
}

export interface CiteMemoriesArgs {
  event_id: string;
  cited_ids: string[];
  outcome?: 'helpful' | 'neutral' | 'harmful';
  critic_reason?: string;
}

export interface UsefulnessStatsArgs {
  namespace?: string;
  min_observations?: number;
  limit?: number;
}

export interface UsefulnessRow {
  memory_id: string;
  namespace: string;
  helpful_count: number;
  neutral_count: number;
  harmful_count: number;
  total_observed: number;
  usefulness_score: number;
  last_updated: string;
}

export function logRetrieval(
  args: LogRetrievalArgs,
  deps: { db: Database; logger: Logger }
): { event_id: string } {
  const { db, logger } = deps;
  const {
    query,
    namespace = 'default',
    retrieved_ids,
    cited_ids = [],
    outcome,
    critic_reason,
    model,
  } = args;

  const event_id = randomBytes(16).toString('hex');
  const query_hash = createHash('sha256').update(query).digest('hex');

  db.prepare(
    `INSERT INTO retrieval_events
       (id, query, query_hash, namespace, retrieved_ids, cited_ids, outcome, critic_reason, model, critiqued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event_id,
    query,
    query_hash,
    namespace,
    JSON.stringify(retrieved_ids),
    JSON.stringify(cited_ids),
    outcome ?? null,
    critic_reason ?? null,
    model ?? null,
    outcome ? new Date().toISOString() : null
  );

  if (outcome) {
    applyUsefulnessUpdate(db, retrieved_ids, cited_ids, outcome, namespace);
  }

  logger.info('attribution', 'retrieval logged', {
    event_id,
    retrieved: retrieved_ids.length,
    cited: cited_ids.length,
    outcome: outcome ?? 'pending',
  });
  return { event_id };
}

export function citeMemories(
  args: CiteMemoriesArgs,
  deps: { db: Database; logger: Logger }
): { event_id: string; updated_memories: number } {
  const { db, logger } = deps;
  const { event_id, cited_ids, outcome, critic_reason } = args;

  const event = db
    .prepare(`SELECT namespace, retrieved_ids FROM retrieval_events WHERE id = ?`)
    .get(event_id) as { namespace: string; retrieved_ids: string } | undefined;

  if (!event) {
    throw new Error(`retrieval event ${event_id} not found`);
  }

  const retrieved_ids = JSON.parse(event.retrieved_ids) as string[];
  db.prepare(
    `UPDATE retrieval_events
        SET cited_ids = ?, outcome = ?, critic_reason = ?, critiqued_at = ?
      WHERE id = ?`
  ).run(
    JSON.stringify(cited_ids),
    outcome ?? null,
    critic_reason ?? null,
    new Date().toISOString(),
    event_id
  );

  const updated = outcome
    ? applyUsefulnessUpdate(db, retrieved_ids, cited_ids, outcome, event.namespace)
    : 0;

  logger.info('attribution', 'event critiqued', { event_id, outcome, updated });
  return { event_id, updated_memories: updated };
}

function applyUsefulnessUpdate(
  db: Database,
  retrieved_ids: string[],
  cited_ids: string[],
  outcome: 'helpful' | 'neutral' | 'harmful',
  namespace: string
): number {
  const citedSet = new Set(cited_ids);
  const upsert = db.prepare(`
    INSERT INTO memory_usefulness
      (memory_id, namespace, helpful_count, neutral_count, harmful_count, total_observed, usefulness_score, last_updated, last_critiqued_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET
      helpful_count = helpful_count + excluded.helpful_count,
      neutral_count = neutral_count + excluded.neutral_count,
      harmful_count = harmful_count + excluded.harmful_count,
      total_observed = total_observed + 1,
      usefulness_score = CAST(helpful_count + excluded.helpful_count + 1 AS REAL)
                       / CAST(helpful_count + excluded.helpful_count
                              + harmful_count + excluded.harmful_count + 2 AS REAL),
      last_updated = excluded.last_updated,
      last_critiqued_at = excluded.last_critiqued_at
  `);

  const now = new Date().toISOString();
  let updated = 0;
  for (const id of retrieved_ids) {
    const isCited = citedSet.has(id);
    // Only increment counts based on EXPLICIT critic signal for cited memories.
    // Not-cited memories are skipped entirely — "not used" is not evidence
    // for or against. This was a v0.16.0 bug: it conflated absence of signal
    // with neutral evidence and polluted usefulness scores.
    if (!isCited) continue;
    const helpful = outcome === 'helpful' ? 1 : 0;
    const harmful = outcome === 'harmful' ? 1 : 0;
    const neutral = outcome === 'neutral' ? 1 : 0;
    const initialScore = helpful === 1 ? 0.67 : harmful === 1 ? 0.33 : 0.5;
    upsert.run(id, namespace, helpful, neutral, harmful, initialScore, now, now);
    updated++;
  }
  return updated;
}

export function usefulnessStats(
  args: UsefulnessStatsArgs,
  deps: { db: Database }
): UsefulnessRow[] {
  const { db } = deps;
  const { namespace, min_observations = 1, limit = 50 } = args;
  const where = namespace ? 'WHERE namespace = ? AND total_observed >= ?' : 'WHERE total_observed >= ?';
  const params = namespace ? [namespace, min_observations, limit] : [min_observations, limit];
  return db
    .prepare(
      `SELECT memory_id, namespace, helpful_count, neutral_count, harmful_count,
              total_observed, usefulness_score, last_updated
         FROM memory_usefulness
         ${where}
         ORDER BY usefulness_score DESC, total_observed DESC
         LIMIT ?`
    )
    .all(...params) as UsefulnessRow[];
}

export function getUsefulnessScores(
  db: Database,
  memory_ids: string[]
): Map<string, number> {
  const scores = new Map<string, number>();
  if (memory_ids.length === 0) return scores;
  const placeholders = memory_ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT memory_id, usefulness_score FROM memory_usefulness WHERE memory_id IN (${placeholders})`
    )
    .all(...memory_ids) as Array<{ memory_id: string; usefulness_score: number }>;
  for (const row of rows) scores.set(row.memory_id, row.usefulness_score);
  for (const id of memory_ids) if (!scores.has(id)) scores.set(id, 0.5);
  return scores;
}

export function decayUsefulness(
  deps: { db: Database; logger: Logger },
  opts: { half_life_days?: number } = {}
): { decayed: number } {
  const { db, logger } = deps;
  const half = opts.half_life_days ?? 14;
  const now = new Date();
  // Decay tracks age via `last_critiqued_at` — only advances on real critic
  // feedback, not on every retrieval hit. SELECT + UPDATE live inside the
  // same transaction so concurrent writers can't invalidate the row set
  // between the two statements.
  const cutoffIso = new Date(now.getTime() - half * 24 * 3600 * 1000).toISOString();
  const nowIso = now.toISOString();
  const selectStale = db.prepare(
    `SELECT memory_id, usefulness_score, decay_floor, COALESCE(last_critiqued_at, last_updated) AS anchor
       FROM memory_usefulness
       WHERE COALESCE(last_critiqued_at, last_updated) < ?`
  );
  const update = db.prepare(
    `UPDATE memory_usefulness SET usefulness_score = ?, last_critiqued_at = ? WHERE memory_id = ?`
  );
  // Counter lives inside the transaction closure so that a mid-batch
  // exception rolls back writes AND aborts the closure — `applyDecay()`
  // re-throws, the outer `decayed` binding is never assigned, and the
  // caller sees the exception with no partial count. better-sqlite3 does
  // not retry automatically; the retry semantics are the caller's job.
  const applyDecay = db.transaction((): number => {
  let localDecayed = 0;
  const rows = selectStale.all(cutoffIso) as Array<{ memory_id: string; usefulness_score: number; decay_floor: number; anchor: string }>;
  for (const row of rows) {
    const ageMs = now.getTime() - new Date(row.anchor).getTime();
    const halfLifeMs = half * 24 * 3600 * 1000;
    if (ageMs < halfLifeMs) continue;
    const delta = row.usefulness_score - row.decay_floor;
    const fraction = Math.pow(0.5, ageMs / halfLifeMs);
    const next = row.decay_floor + delta * fraction;
    if (Math.abs(next - row.usefulness_score) < 0.001) continue;
    update.run(next, nowIso, row.memory_id);
    localDecayed++;
  }
  return localDecayed;
  });
  const decayed = applyDecay();
  logger.info('attribution', 'usefulness decay applied', { decayed, half_life_days: half });
  return { decayed };
}
