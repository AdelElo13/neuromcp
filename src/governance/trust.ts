import type { TrustLevel, MemorySource } from '../types.js';

const TRUST_RANKS: Record<TrustLevel, number> = {
  unverified: 0,
  low: 1,
  medium: 2,
  high: 3,
} as const;

/** Map a trust level to a numeric rank (unverified=0 … high=3). */
export function trustRank(level: TrustLevel): number {
  return TRUST_RANKS[level];
}

/** Returns true when `a` has strictly higher trust than `b`. */
export function isHigherTrust(a: TrustLevel, b: TrustLevel): boolean {
  return TRUST_RANKS[a] > TRUST_RANKS[b];
}

/** Default trust level for a given memory source. */
export function defaultTrustForSource(source: MemorySource): TrustLevel {
  switch (source) {
    case 'user':
      return 'high';
    case 'consolidation':
    case 'auto':
    case 'claude-code':
      return 'medium';
    case 'error':
      return 'low';
  }
}

/** Whether a memory can be automatically pruned. High-trust or user-sourced memories are protected. */
export function canAutoPrune(trust: TrustLevel, source: MemorySource): boolean {
  if (trust === 'high') return false;
  if (source === 'user') return false;
  return true;
}

/** Returns true when the memory's trust meets or exceeds the minimum threshold. */
export function meetsMinTrust(memoryTrust: TrustLevel, minTrust: TrustLevel): boolean {
  return TRUST_RANKS[memoryTrust] >= TRUST_RANKS[minTrust];
}
