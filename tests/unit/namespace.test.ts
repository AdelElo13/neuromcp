import { describe, it, expect } from 'vitest';
import { namespaceFilter } from '../../src/governance/namespace.js';

describe('namespaceFilter', () => {
  it('uses default namespace when none provided', () => {
    const result = namespaceFilter(undefined, 'default');
    expect(result.clause).toBe('namespace = ?');
    expect(result.params).toEqual(['default']);
  });

  it('uses provided namespace over default', () => {
    const result = namespaceFilter('work', 'default');
    expect(result.clause).toBe('namespace = ?');
    expect(result.params).toEqual(['work']);
  });

  it('returns wildcard clause for * namespace', () => {
    const result = namespaceFilter('*', 'default');
    expect(result.clause).toBe('1=1');
    expect(result.params).toEqual([]);
  });

  it('treats * default the same when namespace is undefined', () => {
    const result = namespaceFilter(undefined, '*');
    expect(result.clause).toBe('1=1');
    expect(result.params).toEqual([]);
  });
});
