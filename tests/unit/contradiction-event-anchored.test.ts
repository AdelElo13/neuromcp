import { describe, it, expect } from 'vitest';
import { predicatesAllowSupersede } from '../../src/cognitive/contradiction.js';
import { extractTriplesFromText } from '../../src/cognitive/claims.js';

/**
 * v0.29.5 — recorded occurrences on different calendar dates are not
 * contradictions.
 *
 * The daily consolidation report "Consolidation run on 2026-06-13: merged
 * 293 …" parses as the SVO triple {Consolidation, run, "on 2026-06-13:"}
 * and `run` is a mutually-exclusive predicate — so every report
 * "contradicted" the previous day's with claim-level evidence: a bogus
 * 'contradicts' edge (+ two proxy entities) per run, surfaced in
 * explain.contradictions of every search that hit a report.
 *
 * Rule, in the claim gate only (the extractor is untouched): a pair is
 * exempt iff BOTH objects are anchored to a full calendar date, the
 * (canonicalised) dates DIFFER, and both are RECORDS — each date does not
 * lie after the moment its memory was recorded. A plan with a future date
 * ("the migration runs on 2026-09-20 exactly once", stored 09-15) is a
 * state and a different date contradicts it; so does the same date with
 * different values; IP addresses and clock times never anchor; the copula
 * is exempt from the rule.
 */

const RECORDED = { newRecordedAt: '2026-09-14T03:05:00.000Z', existingRecordedAt: '2026-09-13T03:05:00.000Z' };

describe('predicatesAllowSupersede — date-anchored SVO objects', () => {
  it('the extractor still parses the report (no extractor change)', () => {
    expect(extractTriplesFromText('Consolidation run on 2026-09-14 merged 1260 decayed 97')).toEqual([
      { subject: 'Consolidation', predicate: 'run', object: 'on 2026-09-14 merged 1260 decayed 97' },
    ]);
  });

  it('two recorded daily consolidation reports carry no claim evidence', () => {
    expect(predicatesAllowSupersede(
      'Consolidation run on 2026-09-14 merged 1260 decayed 97 pruned 33 promoted 12',
      'Consolidation run on 2026-09-13 merged 258 decayed 2255 pruned 0 promoted 4',
      RECORDED,
    )).toBe(false);
    // The exact shape on the reference DB: date followed by a colon (the
    // sentence splitter cuts there, so the object is "on 2026-06-13:").
    expect(predicatesAllowSupersede(
      'Consolidation run on 2026-06-14: merged 14, decayed 1400, pruned 0, swept 0. Total memories: 1398.',
      'Consolidation run on 2026-06-13: merged 293, decayed 1634, pruned 0, swept 0. Total memories: 1408.',
      { newRecordedAt: '2026-06-14T03:00:00.000Z', existingRecordedAt: '2026-06-13T03:00:00.000Z' },
    )).toBe(false);
  });

  it('anchors are canonicalised: dd/mm/yyyy equals the ISO date (round-6 case)', () => {
    // Same day in two notations → not a time series → the numeric diff counts.
    expect(predicatesAllowSupersede(
      'Consolidation run on 14/09/2026 merged 260',
      'Consolidation run on 2026-09-14 merged 258',
      RECORDED,
    )).toBe(true);
    expect(predicatesAllowSupersede(
      'the batch run on 1/9/2026 wrote 12 files',
      'the batch run on 01/09/2026 wrote 10 files',
      { newRecordedAt: '2026-09-02T00:00:00.000Z', existingRecordedAt: '2026-09-01T12:00:00.000Z' },
    )).toBe(true);
    // Different recorded days in mixed notation → still a time series.
    expect(predicatesAllowSupersede(
      'the batch run on 15/09/2026 wrote 12 files',
      'the batch run on 2026-09-14 wrote 10 files',
      { newRecordedAt: '2026-09-15T22:00:00.000Z', existingRecordedAt: '2026-09-14T22:00:00.000Z' },
    )).toBe(false);
  });

  it('a PLAN with a future date is a state — a different date contradicts it (round-6 case)', () => {
    const planned = { newRecordedAt: '2026-09-15T10:00:00.000Z', existingRecordedAt: '2026-09-15T09:00:00.000Z' };
    expect(predicatesAllowSupersede(
      'The migration runs on 2026-09-21 exactly once',
      'The migration runs on 2026-09-20 exactly once',
      planned,
    )).toBe(true);
  });

  it('without recording moments nothing is exempted (conservative default)', () => {
    expect(predicatesAllowSupersede(
      'Consolidation run on 2026-09-14 merged 1260 decayed 97',
      'Consolidation run on 2026-09-13 merged 258 decayed 2255',
    )).toBe(true);
  });

  it('the SAME date with different values is still a contradiction', () => {
    expect(predicatesAllowSupersede(
      'Consolidation run on 2026-09-14 merged 260 decayed 97',
      'Consolidation run on 2026-09-14 merged 258 decayed 97',
      RECORDED,
    )).toBe(true);
  });

  it('IP addresses and clock times are states, not date anchors (round-5 cases)', () => {
    expect(predicatesAllowSupersede(
      'the service runs on 10.20.30.41 behind the proxy',
      'the service runs on 10.20.30.40 behind the proxy',
      RECORDED,
    )).toBe(true);
    expect(predicatesAllowSupersede(
      'the backup job runs at 03:00 every day now',
      'the backup job runs at 04:30 every day',
      RECORDED,
    )).toBe(true);
  });

  it('the copula keeps a changed date as a real update', () => {
    expect(predicatesAllowSupersede(
      'the kickoff meeting is on 2026-09-20 in Amsterdam',
      'the kickoff meeting is on 2026-09-13 in Amsterdam',
      RECORDED,
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
      RECORDED,
    )).toBe(true);
  });
});
