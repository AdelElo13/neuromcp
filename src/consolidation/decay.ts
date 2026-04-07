import type Database from 'better-sqlite3';
import type { ProposedDecay, ProposedPrune } from '../types.js';

export interface DecayResult {
  readonly decays: readonly ProposedDecay[];
  readonly prunes: readonly ProposedPrune[];
}

/**
 * Computes importance decay for all active memories in a namespace.
 * Formula: new_importance = importance * exp(-lambda * daysSinceAccess)
 *
 * Also identifies memories eligible for pruning:
 * - importance < minImportance after decay
 * - access_count < 3
 * - age > 30 days
 * - source_trust != 'high'
 * - source != 'user'
 */
export function computeDecay(
  db: Database.Database,
  namespace: string,
  lambda: number,
  minImportance: number,
): DecayResult {
  const isAll = namespace === '*';
  const nsClause = isAll ? '1=1' : 'namespace = ?';
  const nsParams = isAll ? [] : [namespace];

  const rows = db
    .prepare(
      `SELECT id, importance, access_count, created_at, last_accessed_at, source, source_trust
       FROM memories
       WHERE is_deleted = 0 AND ${nsClause}`,
    )
    .all(...nsParams) as Array<{
    id: string;
    importance: number;
    access_count: number;
    created_at: string;
    last_accessed_at: string | null;
    source: string;
    source_trust: string;
  }>;

  const now = Date.now();
  const decays: ProposedDecay[] = [];
  const prunes: ProposedPrune[] = [];

  for (const row of rows) {
    const referenceDate = row.last_accessed_at ?? row.created_at;
    const refMs = new Date(referenceDate).getTime();
    const daysSinceAccess = (now - refMs) / 86_400_000;

    const newImportance =
      row.importance * Math.exp(-lambda * daysSinceAccess);

    // Only include if change is significant (> 0.01)
    if (Math.abs(newImportance - row.importance) > 0.01) {
      decays.push({
        id: row.id,
        current_importance: row.importance,
        new_importance: newImportance,
        days_since_access: daysSinceAccess,
      });
    }

    // Check prune eligibility
    const ageMs = now - new Date(row.created_at).getTime();
    const ageDays = ageMs / 86_400_000;

    // Standard prune: low importance + low access + old + not user-sourced
    if (
      newImportance < minImportance &&
      row.access_count < 3 &&
      ageDays > 30 &&
      row.source_trust !== 'high' &&
      row.source !== 'user'
    ) {
      prunes.push({
        id: row.id,
        importance: newImportance,
        access_count: row.access_count,
        age_days: ageDays,
        reason: `decayed importance ${newImportance.toFixed(4)} below threshold ${minImportance}`,
      });
    }
    // Stale prune: 90+ days without access, regardless of importance
    // Still protect user-sourced and high-trust memories
    else if (
      daysSinceAccess >= 90 &&
      row.access_count === 0 &&
      row.source !== 'user' &&
      row.source_trust !== 'high'
    ) {
      prunes.push({
        id: row.id,
        importance: newImportance,
        access_count: row.access_count,
        age_days: ageDays,
        reason: `stale: ${Math.floor(daysSinceAccess)} days without access, zero access count`,
      });
    }
  }

  return { decays, prunes };
}
