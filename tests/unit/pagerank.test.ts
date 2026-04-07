import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { computePageRank, persistCentrality } from '../../src/graph/pagerank.js';
import { upsertEntity } from '../../src/graph/entities.js';
import { createRelation } from '../../src/graph/relations.js';

describe('pagerank', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('returns empty for no entities', () => {
    const result = computePageRank(ctx.db, 'default');
    expect(result).toHaveLength(0);
  });

  it('ranks connected entities higher', () => {
    const a = upsertEntity(ctx.db, 'Hub', 'concept', 'default');
    const b = upsertEntity(ctx.db, 'Spoke1', 'concept', 'default');
    const c = upsertEntity(ctx.db, 'Spoke2', 'concept', 'default');
    const d = upsertEntity(ctx.db, 'Isolated', 'concept', 'default');

    createRelation(ctx.db, a.id, b.id, 'relates_to', 'default');
    createRelation(ctx.db, a.id, c.id, 'relates_to', 'default');

    const results = computePageRank(ctx.db, 'default');
    expect(results.length).toBe(4);

    // Hub should have highest centrality (most connections)
    const hub = results.find(r => r.name === 'Hub');
    const isolated = results.find(r => r.name === 'Isolated');
    expect(hub!.centrality).toBeGreaterThan(isolated!.centrality);
  });

  it('persists centrality to entity metadata', () => {
    upsertEntity(ctx.db, 'TestEntity', 'concept', 'default');
    const results = computePageRank(ctx.db, 'default');
    const updated = persistCentrality(ctx.db, results);
    expect(updated).toBe(1);

    const row = ctx.db.prepare("SELECT json_extract(metadata, '$.centrality') as c FROM entities WHERE name = 'TestEntity'").get() as { c: number };
    expect(row.c).toBeGreaterThan(0);
  });
});
