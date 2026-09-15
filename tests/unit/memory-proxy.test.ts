import { describe, it, expect } from 'vitest';
import { proxyEntityName, legacyProxyEntityName, PROXY_NAME_PREFIX } from '../../src/graph/memory-proxy.js';

describe('memory proxy names', () => {
  const opening = 'Weekly maintenance summary for the Atlas platform team, week 37. ';

  it('legacy derivation: first 60 characters, punctuation stripped — memories with the same opening collide', () => {
    const a = legacyProxyEntityName(`${opening}No changes.`);
    const b = legacyProxyEntityName(`${opening}The project uses React 18.`);
    expect(a).toBe(b);
    expect(a.startsWith(PROXY_NAME_PREFIX)).toBe(true);
    // 60 characters of content, comma stripped, trailing space trimmed.
    expect(a).toBe('memory:Weekly maintenance summary for the Atlas platform team week');
  });

  it('current derivation embeds the FULL memory id so one proxy represents exactly one memory', () => {
    const a = proxyEntityName(`${opening}No changes.`, 'aaaaaaaa1111');
    const b = proxyEntityName(`${opening}The project uses React 18.`, 'bbbbbbbb2222');
    expect(a).not.toBe(b);
    expect(a).toBe('memory:Weekly maintenance summary for the Atlas platform team week #aaaaaaaa1111');
    // Same stem AND same id prefix (Codex round 5): still distinct.
    const c = proxyEntityName(`${opening}No changes.`, 'deadbeef00000000000000000000001');
    const d = proxyEntityName(`${opening}No changes.`, 'deadbeef00000000000000000000002');
    expect(c).not.toBe(d);
  });
});
