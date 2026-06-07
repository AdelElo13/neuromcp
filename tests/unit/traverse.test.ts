import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { upsertEntity } from '../../src/graph/entities.js';
import { createRelation } from '../../src/graph/relations.js';
import { traverseGraph } from '../../src/graph/traverse.js';

describe('traverseGraph', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  // Regression test for Bug #5 (v0.21.0):
  //   BFS traversal added edges to the result list once per visited node.
  //   In a cycle A→B→C→A, the same edge was added twice (once when A is
  //   visited and we look at A→B, again when B is visited and we look at
  //   the back-pointer of A→B from B's side via direction='both').
  //   The fix is a `seenEdges` Set keyed on relation id.
  it('does NOT duplicate edges in a triangle cycle (A->B->C->A)', () => {
    const a = upsertEntity(ctx.db, 'A', 'concept', 'default');
    const b = upsertEntity(ctx.db, 'B', 'concept', 'default');
    const c = upsertEntity(ctx.db, 'C', 'concept', 'default');

    const ab = createRelation(ctx.db, a.id, b.id, 'relates_to', 'default');
    const bc = createRelation(ctx.db, b.id, c.id, 'relates_to', 'default');
    const ca = createRelation(ctx.db, c.id, a.id, 'relates_to', 'default');

    const result = traverseGraph(ctx.db, a.id, { maxDepth: 3 });

    // 3 unique edges, not 6 (each edge was previously added from both
    // endpoints during BFS).
    const edgeIds = result.edges.map((e) => e.relation.id);
    const uniqueEdgeIds = new Set(edgeIds);

    expect(edgeIds.length).toBe(uniqueEdgeIds.size);
    expect(uniqueEdgeIds.size).toBe(3);
    expect(uniqueEdgeIds.has(ab.id)).toBe(true);
    expect(uniqueEdgeIds.has(bc.id)).toBe(true);
    expect(uniqueEdgeIds.has(ca.id)).toBe(true);
  });

  it('does NOT duplicate edges in a star (A connected to B,C,D)', () => {
    const a = upsertEntity(ctx.db, 'A-star', 'concept', 'default');
    const b = upsertEntity(ctx.db, 'B-star', 'concept', 'default');
    const c = upsertEntity(ctx.db, 'C-star', 'concept', 'default');
    const d = upsertEntity(ctx.db, 'D-star', 'concept', 'default');

    createRelation(ctx.db, a.id, b.id, 'relates_to', 'default');
    createRelation(ctx.db, a.id, c.id, 'relates_to', 'default');
    createRelation(ctx.db, a.id, d.id, 'relates_to', 'default');

    const result = traverseGraph(ctx.db, a.id, { maxDepth: 2 });

    const edgeIds = result.edges.map((e) => e.relation.id);
    const uniqueEdgeIds = new Set(edgeIds);
    expect(edgeIds.length).toBe(uniqueEdgeIds.size);
    expect(uniqueEdgeIds.size).toBe(3);
  });

  it('still returns nodes correctly without edge dup affecting node list', () => {
    const a = upsertEntity(ctx.db, 'NodeA', 'concept', 'default');
    const b = upsertEntity(ctx.db, 'NodeB', 'concept', 'default');
    createRelation(ctx.db, a.id, b.id, 'relates_to', 'default');

    const result = traverseGraph(ctx.db, a.id, { maxDepth: 2 });

    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
  });
});
