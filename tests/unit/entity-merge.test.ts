import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { mergeEntitiesInNamespace, levenshtein } from '../../src/consolidation/entity-merge.js';
import { upsertEntity, linkMemoryEntity } from '../../src/graph/entities.js';

describe('levenshtein (bounded)', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('emily', 'emily', 2)).toBe(0);
  });
  it('counts single substitutions', () => {
    expect(levenshtein('yosemite', 'yosemyte', 2)).toBe(1);
  });
  it('returns -1 when distance exceeds maxDist (early exit)', () => {
    expect(levenshtein('apple', 'banana', 1)).toBe(-1);
  });
  it('handles empty strings', () => {
    expect(levenshtein('', 'abc', 5)).toBe(3);
  });
});

describe('mergeEntitiesInNamespace', () => {
  let ctx: TestContext;
  let memNs1A: string;
  let memNs1B: string;

  beforeEach(() => {
    ctx = setupTestDb();
    memNs1A = insertTestMemory(ctx, { namespace: 'ns1', content: 'mem A in ns1' });
    memNs1B = insertTestMemory(ctx, { namespace: 'ns1', content: 'mem B in ns1' });
    insertTestMemory(ctx, { namespace: 'ns2', content: 'mem in ns2' });
  });
  afterEach(() => { teardownTestDb(ctx); });

  it('merges prefix-extension aliases (Emily ⊂ Emily Williams)', () => {
    const short = upsertEntity(ctx.db, 'Emily', 'person', 'ns1');
    const long = upsertEntity(ctx.db, 'Emily Williams', 'person', 'ns1');
    linkMemoryEntity(ctx.db, memNs1A, short.id);
    linkMemoryEntity(ctx.db, memNs1B, long.id);

    const result = mergeEntitiesInNamespace(ctx.db, 'ns1');
    expect(result.merged).toBe(1);
    expect(result.proposed[0]).toMatchObject({
      canonicalName: 'Emily Williams',
      mergedName: 'Emily',
      reason: 'prefix_extension',
    });

    const links = ctx.db.prepare(
      'SELECT entity_id FROM memory_entities WHERE memory_id = ?',
    ).all(memNs1A) as Array<{ entity_id: string }>;
    expect(links.map((l) => l.entity_id)).toContain(long.id);

    const old = ctx.db.prepare(
      'SELECT is_deleted FROM entities WHERE id = ?',
    ).get(short.id) as { is_deleted: number };
    expect(old.is_deleted).toBe(1);
  });

  it('merges Levenshtein-near typos (Yosemite / Yosemyte)', () => {
    upsertEntity(ctx.db, 'Yosemite National Park', 'place', 'ns1');
    upsertEntity(ctx.db, 'Yosemite National Parc', 'place', 'ns1');

    const result = mergeEntitiesInNamespace(ctx.db, 'ns1');
    expect(result.merged).toBe(1);
    expect(result.proposed[0]?.reason).toBe('levenshtein');
  });

  it('does NOT merge entities of different types', () => {
    upsertEntity(ctx.db, 'Apple Things Inc', 'org', 'ns1');
    upsertEntity(ctx.db, 'Apple Things Inc', 'product', 'ns1');
    const result = mergeEntitiesInNamespace(ctx.db, 'ns1');
    expect(result.merged).toBe(0);
  });

  it('does NOT cross namespace boundaries', () => {
    upsertEntity(ctx.db, 'Emily', 'person', 'ns1');
    upsertEntity(ctx.db, 'Emily Williams', 'person', 'ns2');
    const result = mergeEntitiesInNamespace(ctx.db, 'ns1');
    expect(result.merged).toBe(0);
  });

  it('respects dryRun and returns 0 merged', () => {
    upsertEntity(ctx.db, 'Emily', 'person', 'ns1');
    upsertEntity(ctx.db, 'Emily Williams', 'person', 'ns1');
    const result = mergeEntitiesInNamespace(ctx.db, 'ns1', { dryRun: true });
    expect(result.proposed).toHaveLength(1);
    expect(result.merged).toBe(0);
    const active = ctx.db.prepare(
      "SELECT COUNT(*) AS c FROM entities WHERE is_deleted = 0 AND namespace = 'ns1'",
    ).get() as { c: number };
    expect(active.c).toBe(2);
  });

  it('skips ultra-short names (below minNameLen)', () => {
    upsertEntity(ctx.db, 'Bo', 'person', 'ns1');
    upsertEntity(ctx.db, 'Bo Burnham', 'person', 'ns1');
    const result = mergeEntitiesInNamespace(ctx.db, 'ns1', { minNameLen: 4 });
    expect(result.merged).toBe(0);
  });

  it('does not merge equal-cased names (upsertEntity already dedupes)', () => {
    upsertEntity(ctx.db, 'Rachel', 'person', 'ns1');
    upsertEntity(ctx.db, 'rachel', 'person', 'ns1');
    const result = mergeEntitiesInNamespace(ctx.db, 'ns1');
    expect(result.merged).toBe(0);
  });

  // v0.29 Fase 1B (Codex [MEDIUM]): bare prefix is not enough evidence for a
  // non-person merge. "Apple" and "Apple Music" (same concept type, no shared
  // memory) are distinct entities and must NOT be merged.
  it('does NOT prefix-merge non-person entities without shared-memory evidence', () => {
    const a = upsertEntity(ctx.db, 'Apple', 'concept', 'ns1');
    const b = upsertEntity(ctx.db, 'Apple Music', 'concept', 'ns1');
    linkMemoryEntity(ctx.db, memNs1A, a.id);
    linkMemoryEntity(ctx.db, memNs1B, b.id); // different memories → no evidence
    const result = mergeEntitiesInNamespace(ctx.db, 'ns1');
    expect(result.merged).toBe(0);
  });

  it('does NOT prefix-merge "Washington" / "Washington Post" (concept, no shared memory)', () => {
    upsertEntity(ctx.db, 'Washington', 'concept', 'ns1');
    upsertEntity(ctx.db, 'Washington Post', 'concept', 'ns1');
    const result = mergeEntitiesInNamespace(ctx.db, 'ns1');
    expect(result.merged).toBe(0);
  });

  it('DOES prefix-merge non-person entities that SHARE a memory (evidence)', () => {
    const a = upsertEntity(ctx.db, 'Postgres', 'concept', 'ns1');
    const b = upsertEntity(ctx.db, 'Postgres Database', 'concept', 'ns1');
    // Both linked to the SAME memory → co-occurrence evidence they are the same.
    linkMemoryEntity(ctx.db, memNs1A, a.id);
    linkMemoryEntity(ctx.db, memNs1A, b.id);
    const result = mergeEntitiesInNamespace(ctx.db, 'ns1');
    expect(result.merged).toBe(1);
    expect(result.proposed[0]?.reason).toBe('prefix_extension');
  });
});
