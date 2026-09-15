import { describe, it, expect } from 'vitest';
import { predicatesAllowSupersede } from '../../src/cognitive/contradiction.js';
import { extractTriplesFromText } from '../../src/cognitive/claims.js';

/**
 * v0.29.5 — event-anchored objects are occurrences, not states.
 *
 * The daily consolidation report "Consolidation run on 2026-09-14 merged
 * 1260 …" parses as the SVO triple {Consolidation, run, "on 2026-09-14 …"}
 * and `run` is a mutually-exclusive predicate — so every report
 * "contradicted" the previous day's with claim-level evidence: a bogus
 * 'contradicts' edge (+ two proxy entities) per run, surfaced in
 * explain.contradictions of every search that hit a report.
 *
 * Fix: in the claim gate, an SVO object anchored to a calendar date or a
 * clock time describes when something happened, not what the subject IS;
 * two occurrences on different dates are a time series. The copula is
 * exempt: "the meeting is on 2026-09-13" → "… 2026-09-20" is a real update.
 * The extractor itself is untouched (a grammar heuristic there rejected
 * valid plural/pronoun subjects — Codex PR-18 round 4 [P2]).
 */

describe('predicatesAllowSupersede — event-anchored SVO objects', () => {
  it('the extractor still parses the report (no extractor regression)', () => {
    expect(extractTriplesFromText('Consolidation run on 2026-09-14 merged 1260 decayed 97')).toEqual([
      { subject: 'Consolidation', predicate: 'run', object: 'on 2026-09-14 merged 1260 decayed 97' },
    ]);
  });

  it('two daily consolidation reports carry no claim evidence', () => {
    expect(predicatesAllowSupersede(
      'Consolidation run on 2026-09-14 merged 1260 decayed 97 pruned 33 promoted 12',
      'Consolidation run on 2026-09-13 merged 258 decayed 2255 pruned 0 promoted 4',
    )).toBe(false);
  });

  it('a scheduled occurrence on another date is not a contradiction either', () => {
    expect(predicatesAllowSupersede(
      'the backup job runs at 03:00 on the primary',
      'the backup job runs at 04:30 on the primary',
    )).toBe(false);
    expect(predicatesAllowSupersede(
      'the release runs on 15/09/2026 for all tenants',
      'the release runs on 16/09/2026 for all tenants',
    )).toBe(false);
  });

  it('the copula keeps a changed date as a real update', () => {
    expect(predicatesAllowSupersede(
      'the kickoff meeting is on 2026-09-20 in Amsterdam',
      'the kickoff meeting is on 2026-09-13 in Amsterdam',
    )).toBe(true);
  });

  it('plural and coordinated subjects keep their evidence (round-4 regression cases)', () => {
    expect(predicatesAllowSupersede(
      'Alice and Bob use Postgres 17 for everything now',
      'Alice and Bob use Postgres 16 for everything',
    )).toBe(true);
    expect(predicatesAllowSupersede(
      'the APIs use Redis 7 for rate limiting',
      'the APIs use Redis 6 for rate limiting',
    )).toBe(true);
    expect(predicatesAllowSupersede(
      'the servers in production run caddy behind the load balancer',
      'the servers in production run nginx behind the load balancer',
    )).toBe(true);
  });

  it('a state with a date somewhere later in the object is still a state', () => {
    expect(predicatesAllowSupersede(
      'the project uses React 19 since 2026-09-01',
      'the project uses React 18 since 2026-01-01',
    )).toBe(true);
  });
});
