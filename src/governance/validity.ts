import type { Memory } from '../types.js';

/**
 * Shared "current validity" source of truth (v0.29 KERNBESLISSING).
 *
 * A memory is CURRENT when it has not been superseded AND its validity window
 * is still open at `now`:
 *
 *   superseded_by_id IS NULL AND (valid_to IS NULL OR valid_to > now)
 *
 * "Current" is the contract for DEFAULT reads. "Historical" is explicit
 * opt-in — either an `include_superseded: true` flag or a point-in-time
 * `valid_at` query. An id-lookup is the one legitimate bypass (an explicit
 * fetch may return anything, including superseded/expired rows).
 *
 * Every read path (search hybrid + chrono, recall, recall_answer, timeline,
 * recent/namespace resources, stats) MUST reuse this helper rather than
 * re-deriving the predicate ad hoc — a divergence is exactly how superseded
 * rows leaked back into default reads before v0.29.
 */

export interface ValiditySql {
  /** SQL fragment, e.g. `superseded_by_id IS NULL AND (valid_to IS NULL OR valid_to > ?)`. */
  readonly clause: string;
  /** Bind parameters for the clause (the `now` ISO timestamp). */
  readonly params: readonly string[];
}

/**
 * Build the SQL fragment that restricts a query to CURRENT memories.
 *
 * @param nowIso ISO-8601 timestamp representing "now" for the window check.
 * @param columnPrefix Optional table alias/prefix (e.g. `'m'`) so the clause
 *   can be used in a joined query as `m.superseded_by_id ...`. Omit for an
 *   unqualified `memories`-only query.
 */
export function currentValiditySql(nowIso: string, columnPrefix?: string): ValiditySql {
  const p = columnPrefix !== undefined && columnPrefix.length > 0 ? `${columnPrefix}.` : '';
  return {
    clause: `${p}superseded_by_id IS NULL AND (${p}valid_to IS NULL OR ${p}valid_to > ?)`,
    params: [nowIso],
  };
}

/**
 * In-memory twin of {@link currentValiditySql}. Returns true when `memory`
 * is current at `nowIso`.
 */
export function isCurrent(memory: Pick<Memory, 'superseded_by_id' | 'valid_to'>, nowIso: string): boolean {
  return (
    memory.superseded_by_id === null &&
    (memory.valid_to === null || memory.valid_to > nowIso)
  );
}
