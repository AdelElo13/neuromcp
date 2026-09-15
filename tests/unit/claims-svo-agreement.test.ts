import { describe, it, expect } from 'vitest';
import { extractTriplesFromText } from '../../src/cognitive/claims.js';
import { predicatesAllowSupersede } from '../../src/cognitive/contradiction.js';

/**
 * v0.29.5 — SVO subject/verb agreement in the claim extractor.
 *
 * The SVO pattern accepted the bare verb form ("run", "use", "store") after
 * ANY subject, so "Consolidation run on 2026-09-14 merged 1260 …" became
 * the claim {Consolidation, run, "on 2026-09-14 merged 1260 …"}. "run" is
 * a mutually-exclusive predicate, so every daily consolidation report
 * "contradicted" the previous one with claim-level evidence: a bogus
 * 'contradicts' edge (+ two proxy entities) per run, surfaced in
 * explain.contradictions of every search that hit a report.
 *
 * In English SVO the bare form is a verb only after a plural or pronoun
 * subject; after a singular noun it is a noun.
 */

describe('extractTriplesFromText — bare verb form needs a plural/pronoun subject', () => {
  it('does not read "Consolidation run on …" as a claim', () => {
    expect(extractTriplesFromText('Consolidation run on 2026-09-14 merged 1260 decayed 97 pruned 33 promoted 12')).toEqual([]);
  });

  it('does not read "the test run failed" as a claim', () => {
    expect(extractTriplesFromText('the nightly test run store the artefacts elsewhere')).toEqual([]);
  });

  it('still reads the conjugated form after a singular subject', () => {
    expect(extractTriplesFromText('the project uses React 18 on the customer portal')).toEqual([
      { subject: 'the project', predicate: 'uses', object: 'React 18 on the customer portal' },
    ]);
  });

  it('still reads the bare form after a plural subject', () => {
    expect(extractTriplesFromText('the servers run nginx behind cloudflare')).toEqual([
      { subject: 'the servers', predicate: 'run', object: 'nginx behind cloudflare' },
    ]);
  });

  it('still reads the bare form after a pronoun subject', () => {
    expect(extractTriplesFromText('we use Postgres 16 for everything')).toEqual([
      { subject: 'we', predicate: 'use', object: 'Postgres 16 for everything' },
    ]);
  });

  it('does not treat a singular -us/-ss/-is noun as plural', () => {
    expect(extractTriplesFromText('the status run through the nightly job')).toEqual([]);
  });

  it('two daily consolidation reports therefore carry no claim evidence', () => {
    expect(predicatesAllowSupersede(
      'Consolidation run on 2026-09-14 merged 1260 decayed 97 pruned 33 promoted 12',
      'Consolidation run on 2026-09-13 merged 258 decayed 2255 pruned 0 promoted 4',
    )).toBe(false);
  });
});
