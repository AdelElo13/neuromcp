/**
 * Unit tests for contradiction edge creation in the knowledge graph.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { createContradictionEdge } from '../../src/graph/contradiction-edges.js';

describe('createContradictionEdge', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('creates a contradicts relation between two memories', () => {
    const id1 = insertTestMemory(ctx, { content: 'neuromcp has 8 tools' });
    const id2 = insertTestMemory(ctx, { content: 'neuromcp has 40 tools' });

    createContradictionEdge(ctx.db, id1, id2, 'default', {
      resolution: 'supersede',
      similarity: 0.95,
    });

    // Check relation was created
    const relations = ctx.db.prepare(
      "SELECT * FROM relations WHERE relation_type = 'contradicts' AND is_deleted = 0",
    ).all() as Array<{ relation_type: string; weight: number; metadata: string }>;

    expect(relations.length).toBe(1);
    expect(relations[0]!.relation_type).toBe('contradicts');
    expect(relations[0]!.weight).toBe(0.95);

    const meta = JSON.parse(relations[0]!.metadata);
    expect(meta.resolution).toBe('supersede');
    expect(meta.auto).toBe(true);
  });

  it('creates entity representations for both memories', () => {
    const id1 = insertTestMemory(ctx, { content: 'The server runs on port 3000' });
    const id2 = insertTestMemory(ctx, { content: 'The server runs on port 8080' });

    createContradictionEdge(ctx.db, id1, id2, 'default', {
      resolution: 'coexist',
      similarity: 0.88,
    });

    // Both memories should have entity links
    const links1 = ctx.db.prepare(
      'SELECT * FROM memory_entities WHERE memory_id = ?',
    ).all(id1);
    const links2 = ctx.db.prepare(
      'SELECT * FROM memory_entities WHERE memory_id = ?',
    ).all(id2);

    expect(links1.length).toBeGreaterThan(0);
    expect(links2.length).toBeGreaterThan(0);
  });

  it('handles missing memory gracefully', () => {
    const id1 = insertTestMemory(ctx, { content: 'real memory' });

    // Should not throw for non-existent memory
    expect(() => {
      createContradictionEdge(ctx.db, id1, 'nonexistent-id', 'default', {
        resolution: 'flag',
        similarity: 0.5,
      });
    }).not.toThrow();
  });

  it('stores coexist resolution metadata', () => {
    const id1 = insertTestMemory(ctx, { content: 'deadline is Friday' });
    const id2 = insertTestMemory(ctx, { content: 'deadline is Monday' });

    createContradictionEdge(ctx.db, id1, id2, 'default', {
      resolution: 'coexist',
      similarity: 0.82,
    });

    const relation = ctx.db.prepare(
      "SELECT metadata FROM relations WHERE relation_type = 'contradicts' LIMIT 1",
    ).get() as { metadata: string };

    const meta = JSON.parse(relation.metadata);
    expect(meta.resolution).toBe('coexist');
  });
});
