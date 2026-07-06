import { describe, it, expect } from 'vitest';
import { currentValiditySql, isCurrent } from '../../src/governance/validity.js';
import type { Memory } from '../../src/types.js';

/**
 * The shared current-validity source of truth (KERNBESLISSING v0.29).
 *
 * "Current" = the default read contract: a memory is current when it has not
 * been superseded AND its validity window has not closed at `now`.
 * "Historical" is explicit opt-in (valid_at / include_superseded).
 */

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'm1',
    content: 'x',
    summary: null,
    content_hash: 'h',
    embedding_model: 'fake',
    embedding_dim: 384,
    namespace: 'default',
    project_id: null,
    agent_id: null,
    source: 'user',
    source_trust: 'medium',
    visibility: 'namespace',
    schema_version: 2,
    category: 'general',
    tags: '[]',
    importance: 0.5,
    effective_importance: null,
    access_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_accessed_at: null,
    expires_at: null,
    is_deleted: 0,
    tombstoned_at: null,
    supersedes_id: null,
    superseded_by_id: null,
    metadata: '{}',
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_to: null,
    surprise_score: 0,
    episode_id: null,
    cluster_id: null,
    review_interval_days: null,
    ease_factor: 2.5,
    next_review_at: null,
    review_count: 0,
    ...overrides,
  };
}

describe('currentValiditySql', () => {
  it('produces a clause requiring not-superseded and open validity window', () => {
    const { clause, params } = currentValiditySql('2026-06-01T00:00:00.000Z');
    expect(clause).toContain('superseded_by_id IS NULL');
    expect(clause).toContain('valid_to IS NULL');
    expect(clause).toContain('valid_to >');
    expect(params).toEqual(['2026-06-01T00:00:00.000Z']);
  });

  it('supports a column-qualified prefix for joined queries', () => {
    const { clause } = currentValiditySql('2026-06-01T00:00:00.000Z', 'm');
    expect(clause).toContain('m.superseded_by_id IS NULL');
    expect(clause).toContain('m.valid_to IS NULL');
    expect(clause).toContain('m.valid_to >');
  });
});

describe('isCurrent', () => {
  const now = '2026-06-01T00:00:00.000Z';

  it('returns true for a non-superseded, open-window memory', () => {
    expect(isCurrent(makeMemory(), now)).toBe(true);
  });

  it('returns false for a superseded memory', () => {
    expect(isCurrent(makeMemory({ superseded_by_id: 'newer' }), now)).toBe(false);
  });

  it('returns false when valid_to is in the past relative to now', () => {
    expect(isCurrent(makeMemory({ valid_to: '2026-05-01T00:00:00.000Z' }), now)).toBe(false);
  });

  it('returns true when valid_to is in the future relative to now', () => {
    expect(isCurrent(makeMemory({ valid_to: '2026-07-01T00:00:00.000Z' }), now)).toBe(true);
  });

  it('returns false when valid_to equals now (window closed at now)', () => {
    expect(isCurrent(makeMemory({ valid_to: now }), now)).toBe(false);
  });
});
