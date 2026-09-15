import { describe, it, expect } from 'vitest';
import { predicatesAllowSupersede } from '../../src/cognitive/contradiction.js';
import { extractTriplesFromText } from '../../src/cognitive/claims.js';

/**
 * v0.29.5 — occurrences on different calendar dates are not contradictions.
 *
 * The daily consolidation report "Consolidation run on 2026-09-14 merged
 * 1260 …" parses as the SVO triple {Consolidation, run, "on 2026-09-14 …"}
 * and `run` is a mutually-exclusive predicate — so every report
 * "contradicted" the previous day's with claim-level evidence: a bogus
 * 'contradicts' edge (+ two proxy entities) per run, surfaced in
 * explain.contradictions of every search that hit a report.
 *
 * Fix, in the claim gate only (the extractor is untouched): when BOTH
 * objects are anchored to a full calendar date and the dates DIFFER, the
 * pair is a time series. Everything else keeps its evidence — IP
 * addresses, clock times (a recurring schedule is a state), the same date
 * with different values, and the copula ("the meeting is on <date>").
 */

describe('predicatesAllowSupersede — date-anchored SVO objects', () => {
  it('the extractor still parses the report (no extractor change)', () => {
    expect(extractTriplesFromText('Consolidation run on 2026-09-14 merged 1260 decayed 97')).toEqual([
      { subject: 'Consolidation', predicate: 'run', object: 'on 2026-09-14 merged 1260 decayed 97' },
    ]);
  });

  it('two daily consolidation reports carry no claim evidence', () => {
    expect(predicatesAllowSupersede(
      'Consolidation run on 2026-09-14 merged 1260 decayed 97 pruned 33 promoted 12',
      'Consolidation run on 2026-09-13 merged 258 decayed 2255 pruned 0 promoted 4',
    )).toBe(false);
    // The exact shape on the reference DB: date followed by a colon (the
    // sentence splitter cuts there, so the object is "on 2026-06-13:").
    expect(predicatesAllowSupersede(
      'Consolidation run on 2026-06-14: merged 14, decayed 1400, pruned 0, swept 0. Total memories: 1398.',
      'Consolidation run on 2026-06-13: merged 293, decayed 1634, pruned 0, swept 0. Total memories: 1408.',
    )).toBe(false);
    expect(predicatesAllowSupersede(
      'the release runs on 16/09/2026 for all tenants',
      'the release runs on 15/09/2026 for all tenants',
    )).toBe(false);
  });

  it('the SAME date with different values is still a contradiction', () => {
    expect(predicatesAllowSupersede(
      'Consolidation run on 2026-09-14 merged 260 decayed 97',
      'Consolidation run on 2026-09-14 merged 258 decayed 97',
    )).toBe(true);
  });

  it('IP addresses and clock times are states, not date anchors (round-5 cases)', () => {
    expect(predicatesAllowSupersede(
      'the service runs on 10.20.30.41 behind the proxy',
      'the service runs on 10.20.30.40 behind the proxy',
    )).toBe(true);
    expect(predicatesAllowSupersede(
      'the backup job runs at 03:00 every day now',
      'the backup job runs at 04:30 every day',
    )).toBe(true);
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

  it('a date later in the object does not anchor the claim', () => {
    expect(predicatesAllowSupersede(
      'the project uses React 19 since 2026-09-01',
      'the project uses React 18 since 2026-01-01',
    )).toBe(true);
  });
});
