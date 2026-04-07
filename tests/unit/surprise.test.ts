import { describe, it, expect } from 'vitest';
import { decaySurprise } from '../../src/cognitive/surprise.js';

describe('decaySurprise', () => {
  it('returns original score when no time has passed', () => {
    expect(decaySurprise(1.0, 0, 30)).toBe(1.0);
  });

  it('decays to ~0.368 at one half-life', () => {
    const result = decaySurprise(1.0, 30, 30);
    expect(result).toBeCloseTo(Math.exp(-1), 2);
  });

  it('decays proportionally from lower initial score', () => {
    const result = decaySurprise(0.5, 30, 30);
    expect(result).toBeCloseTo(0.5 * Math.exp(-1), 2);
  });

  it('returns near-zero for very old surprise', () => {
    const result = decaySurprise(1.0, 300, 30);
    expect(result).toBeLessThan(0.01);
  });

  it('handles zero initial score', () => {
    expect(decaySurprise(0, 10, 30)).toBe(0);
  });
});
