import { describe, it, expect } from 'vitest';
import { predicatesAllowSupersede } from '../../src/cognitive/contradiction.js';

/**
 * Contradiction supersede-gate (v0.29, Codex Task1 #4).
 *
 * Auto-supersede must require the SAME normalized predicate on the same
 * subject with a different object. Two DIFFERENT mutually-exclusive predicates
 * (uses vs requires) are additive facts, not a contradiction.
 */

describe('predicatesAllowSupersede', () => {
  it('does NOT supersede across different predicates (uses vs requires)', () => {
    // "uses React 18" must not be superseded by "requires Node 22".
    const allow = predicatesAllowSupersede(
      'the project requires Node 22',
      'the project uses React 18',
    );
    expect(allow).toBe(false);
  });

  it('supersedes same-predicate, same-subject, different-object', () => {
    const allow = predicatesAllowSupersede(
      'the project uses React 19',
      'the project uses React 18',
    );
    expect(allow).toBe(true);
  });

  it('does NOT supersede when subjects differ (no bare-substring match)', () => {
    // "app" is a substring of "the mapping app" but they are different subjects.
    const allow = predicatesAllowSupersede(
      'the mapping app uses Redis',
      'the app uses Memcached',
    );
    expect(allow).toBe(false);
  });

  it('supersedes when the same subject appears with the same predicate', () => {
    const allow = predicatesAllowSupersede(
      'the database is Postgres',
      'the database is MySQL',
    );
    expect(allow).toBe(true);
  });

  it('does not supersede when objects are equal (no change)', () => {
    const allow = predicatesAllowSupersede(
      'the server runs nginx',
      'the server runs nginx',
    );
    expect(allow).toBe(false);
  });
});
