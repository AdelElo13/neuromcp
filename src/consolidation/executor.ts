import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { ConsolidationPlan, ConsolidationResult } from '../types.js';
import { tombstone, tombstoneWithLineage } from '../governance/tombstone.js';
import { computePageRank, persistCentrality } from '../graph/pagerank.js';
import { updateAdaptiveImportance } from '../cognitive/importance.js';

/**
 * Applies a consolidation plan in a single transaction.
 * - Merges: tombstoneWithLineage() on loser, update winner
 * - Decays: UPDATE importance
 * - Prunes: tombstone()
 * - Sweeps: tombstone() on expired
 * Logs every action to consolidation_log.
 */
export function executeConsolidationPlan(
  plan: ConsolidationPlan,
  db: Database.Database,
  vecStore: VectorStore,
  logger: Logger,
  metrics: Metrics,
): ConsolidationResult {
  const start = Date.now();
  let merged = 0;
  let decayed = 0;
  let pruned = 0;
  let swept = 0;

  const logAction = db.prepare(
    `INSERT INTO consolidation_log (id, operation_id, action, source_ids, result_id, reason, namespace)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  // Decay writes the computed column (v14 split) — user importance is
  // never system-mutated.
  const updateImportance = db.prepare(
    "UPDATE memories SET effective_importance = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  );

  const updateWinner = db.prepare(
    `UPDATE memories
       SET tags = ?,
           importance = ?,
           supersedes_id = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  );

  const runAll = db.transaction(() => {
    // 1. Merges
    for (const merge of plan.proposed_merges) {
      tombstoneWithLineage(db, merge.tombstone_id, merge.keep_id);
      vecStore.remove(merge.tombstone_id);

      updateWinner.run(
        JSON.stringify([...merge.merged_tags]),
        merge.merged_importance,
        merge.tombstone_id,
        merge.keep_id,
      );

      logAction.run(
        randomBytes(16).toString('hex'),
        plan.operation_id,
        'merge',
        JSON.stringify([merge.keep_id, merge.tombstone_id]),
        merge.keep_id,
        merge.reason,
        plan.namespace,
      );

      merged++;
    }

    // 2. Decays
    for (const decay of plan.proposed_decays) {
      updateImportance.run(decay.new_importance, decay.id);

      logAction.run(
        randomBytes(16).toString('hex'),
        plan.operation_id,
        'decay',
        JSON.stringify([decay.id]),
        decay.id,
        `importance ${decay.current_importance.toFixed(4)} -> ${decay.new_importance.toFixed(4)}`,
        plan.namespace,
      );

      decayed++;
    }

    // 3. Prunes
    for (const prune of plan.proposed_prunes) {
      tombstone(db, prune.id);
      vecStore.remove(prune.id);

      logAction.run(
        randomBytes(16).toString('hex'),
        plan.operation_id,
        'prune',
        JSON.stringify([prune.id]),
        null,
        prune.reason,
        plan.namespace,
      );

      pruned++;
    }

    // 4. TTL Sweeps
    for (const sweep of plan.proposed_ttl_sweeps) {
      tombstone(db, sweep.id);
      vecStore.remove(sweep.id);

      logAction.run(
        randomBytes(16).toString('hex'),
        plan.operation_id,
        'tombstone',
        JSON.stringify([sweep.id]),
        null,
        `expired at ${sweep.expired_at}`,
        plan.namespace,
      );

      swept++;
    }
  });

  runAll();

  // Post-consolidation: recompute PageRank centrality scores
  // This keeps entity centrality fresh after merges/prunes change the graph
  let pagerankUpdated = 0;
  try {
    const prResults = computePageRank(db, plan.namespace);
    if (prResults.length > 0) {
      pagerankUpdated = persistCentrality(db, prResults);
    }
    logger.info('consolidation', 'PageRank recomputed', {
      entities: pagerankUpdated,
    });
  } catch (err) {
    logger.warn('consolidation', 'PageRank recompute failed', {
      error: String(err),
    });
  }

  // Post-consolidation: refresh adaptive importance scores
  let importanceRefreshed = 0;
  try {
    const result = updateAdaptiveImportance(db, plan.namespace);
    importanceRefreshed = result.updated;
    logger.info('consolidation', 'adaptive importance refreshed', {
      updated: result.updated,
      avg_delta: result.avg_delta.toFixed(4),
    });
  } catch (err) {
    logger.warn('consolidation', 'adaptive importance refresh failed', {
      error: String(err),
    });
  }

  logger.info('consolidation', 'plan executed', {
    operationId: plan.operation_id,
    merged,
    decayed,
    pruned,
    swept,
    pagerankUpdated,
    importanceRefreshed,
  });

  metrics.increment('consolidation.merged', merged);
  metrics.increment('consolidation.decayed', decayed);
  metrics.increment('consolidation.pruned', pruned);
  metrics.increment('consolidation.swept', swept);
  metrics.record('consolidation.pagerank_entities', pagerankUpdated);
  metrics.record('consolidation.importance_refreshed', importanceRefreshed);
  metrics.record('consolidation.exec_duration_ms', Date.now() - start);

  return {
    operation_id: plan.operation_id,
    merged,
    decayed,
    pruned,
    swept,
  };
}
