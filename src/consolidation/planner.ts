import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { Metrics } from '../observability/metrics.js';
import type { ConsolidationPlan } from '../types.js';
import { findDuplicates } from './dedup.js';
import { computeDecay } from './decay.js';
import { findExpired } from './sweep.js';

export interface ConsolidationOptions {
  readonly similarity_threshold: number;
  readonly decay_lambda: number;
  readonly min_importance_after_decay: number;
}

/**
 * Orchestrates dedup + decay + sweep into a ConsolidationPlan.
 * Pure read operation — no mutations.
 */
export function createConsolidationPlan(
  db: Database.Database,
  vecStore: VectorStore,
  namespace: string,
  options: ConsolidationOptions,
  metrics: Metrics,
): ConsolidationPlan {
  const operationId = randomBytes(16).toString('hex');
  const start = Date.now();

  // 1. Find duplicates
  const proposedMerges = findDuplicates(
    db,
    vecStore,
    namespace,
    options.similarity_threshold,
  );

  // 2. Compute decay and find prune candidates
  const { decays: proposedDecays, prunes: proposedPrunes } = computeDecay(
    db,
    namespace,
    options.decay_lambda,
    options.min_importance_after_decay,
  );

  // 3. Find expired memories
  const proposedSweeps = findExpired(db, namespace);

  metrics.record('consolidation.plan_duration_ms', Date.now() - start);

  return {
    operation_id: operationId,
    namespace,
    created_at: new Date().toISOString(),
    proposed_merges: proposedMerges,
    proposed_decays: proposedDecays,
    proposed_prunes: proposedPrunes,
    proposed_ttl_sweeps: proposedSweeps,
    summary: {
      merge_count: proposedMerges.length,
      decay_count: proposedDecays.length,
      prune_count: proposedPrunes.length,
      sweep_count: proposedSweeps.length,
    },
  };
}
