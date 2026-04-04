import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { NeuromcpConfig } from '../config.js';
import type { ConsolidationPlan, ConsolidationResult } from '../types.js';
import { createConsolidationPlan } from '../consolidation/planner.js';
import { executeConsolidationPlan } from '../consolidation/executor.js';

export interface ConsolidateInput {
  readonly namespace?: string;
  readonly similarity_threshold?: number;
  readonly decay_lambda?: number;
  readonly min_importance_after_decay?: number;
  readonly commit: boolean;
}

export type ConsolidateOutput =
  | { readonly type: 'plan'; readonly plan: ConsolidationPlan }
  | { readonly type: 'result'; readonly result: ConsolidationResult };

export function consolidate(
  input: ConsolidateInput,
  db: Database.Database,
  vecStore: VectorStore,
  embedder: EmbeddingProvider,
  config: NeuromcpConfig,
  logger: Logger,
  metrics: Metrics,
): ConsolidateOutput {
  const namespace = input.namespace ?? config.defaultNamespace;
  const similarityThreshold =
    input.similarity_threshold ?? config.dedupThreshold;
  const decayLambda = input.decay_lambda ?? config.decayLambda;
  const minImportance =
    input.min_importance_after_decay ?? config.minImportance;

  const plan = createConsolidationPlan(db, vecStore, namespace, {
    similarity_threshold: similarityThreshold,
    decay_lambda: decayLambda,
    min_importance_after_decay: minImportance,
  }, metrics);

  if (!input.commit) {
    return { type: 'plan', plan };
  }

  const result = executeConsolidationPlan(plan, db, vecStore, logger, metrics);
  return { type: 'result', result };
}
