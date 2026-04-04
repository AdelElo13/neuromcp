import { describe, it, expect } from 'vitest';
import {
  trustRank,
  isHigherTrust,
  defaultTrustForSource,
  canAutoPrune,
  meetsMinTrust,
} from '../../src/governance/trust.js';

describe('trustRank', () => {
  it('returns correct numeric ranks', () => {
    expect(trustRank('unverified')).toBe(0);
    expect(trustRank('low')).toBe(1);
    expect(trustRank('medium')).toBe(2);
    expect(trustRank('high')).toBe(3);
  });

  it('maintains ordering', () => {
    expect(trustRank('high')).toBeGreaterThan(trustRank('medium'));
    expect(trustRank('medium')).toBeGreaterThan(trustRank('low'));
    expect(trustRank('low')).toBeGreaterThan(trustRank('unverified'));
  });
});

describe('isHigherTrust', () => {
  it('returns true when first is higher', () => {
    expect(isHigherTrust('high', 'medium')).toBe(true);
    expect(isHigherTrust('medium', 'low')).toBe(true);
  });

  it('returns false for equal or lower', () => {
    expect(isHigherTrust('medium', 'medium')).toBe(false);
    expect(isHigherTrust('low', 'high')).toBe(false);
  });
});

describe('defaultTrustForSource', () => {
  it('assigns high trust to user source', () => {
    expect(defaultTrustForSource('user')).toBe('high');
  });

  it('assigns medium trust to auto, consolidation, claude-code', () => {
    expect(defaultTrustForSource('auto')).toBe('medium');
    expect(defaultTrustForSource('consolidation')).toBe('medium');
    expect(defaultTrustForSource('claude-code')).toBe('medium');
  });

  it('assigns low trust to error source', () => {
    expect(defaultTrustForSource('error')).toBe('low');
  });
});

describe('canAutoPrune', () => {
  it('prevents pruning high-trust memories', () => {
    expect(canAutoPrune('high', 'auto')).toBe(false);
  });

  it('prevents pruning user-sourced memories regardless of trust', () => {
    expect(canAutoPrune('medium', 'user')).toBe(false);
    expect(canAutoPrune('low', 'user')).toBe(false);
  });

  it('allows pruning medium/low trust non-user memories', () => {
    expect(canAutoPrune('medium', 'auto')).toBe(true);
    expect(canAutoPrune('low', 'consolidation')).toBe(true);
    expect(canAutoPrune('unverified', 'claude-code')).toBe(true);
  });
});

describe('meetsMinTrust', () => {
  it('passes when memory trust meets threshold', () => {
    expect(meetsMinTrust('high', 'high')).toBe(true);
    expect(meetsMinTrust('high', 'medium')).toBe(true);
    expect(meetsMinTrust('medium', 'medium')).toBe(true);
  });

  it('fails when memory trust is below threshold', () => {
    expect(meetsMinTrust('low', 'medium')).toBe(false);
    expect(meetsMinTrust('unverified', 'high')).toBe(false);
  });

  it('unverified min allows everything', () => {
    expect(meetsMinTrust('unverified', 'unverified')).toBe(true);
    expect(meetsMinTrust('high', 'unverified')).toBe(true);
  });
});
