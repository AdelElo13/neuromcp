import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { queryGraph, createRelation, createEntity } from '../../src/tools/graph.js';
import { upsertEntity } from '../../src/graph/entities.js';
import { MEMORY_PROXY_TYPE } from '../../src/graph/memory-proxy.js';
import type { Logger } from '../../src/observability/logger.js';
import type { Metrics } from '../../src/observability/metrics.js';

const noopLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
};
const noopMetrics: Metrics = {
  increment: () => {}, record: () => {}, gauge: () => {}, snapshot: () => ({}),
};

describe('queryGraph — overview mode (Sprint 4 reviewer fix)', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('returns overview when no entity_id/entity_name is given', () => {
    upsertEntity(ctx.db, 'Alice', 'person', 'default');
    upsertEntity(ctx.db, 'Bob', 'person', 'default');
    upsertEntity(ctx.db, 'NYC', 'place', 'default');

    const result = queryGraph({}, ctx.db, ctx.config, noopLogger, noopMetrics);
    expect(result.mode).toBe('overview');
    expect(result.nodes).toHaveLength(3);
    expect(result.traversal_depth).toBe(0);
  });

  it('orders nodes by degree (highest first)', () => {
    const a = upsertEntity(ctx.db, 'Alice', 'person', 'default');
    const b = upsertEntity(ctx.db, 'Bob', 'person', 'default');
    const c = upsertEntity(ctx.db, 'NYC', 'place', 'default');
    // A connected to B and C (degree=2), B connected to A (degree=1), C connected to A (degree=1)
    createRelation({
      source_entity_id: a.id, target_entity_id: b.id,
      relation_type: 'knows', namespace: 'default',
    }, ctx.db, ctx.config, noopLogger, noopMetrics);
    createRelation({
      source_entity_id: a.id, target_entity_id: c.id,
      relation_type: 'visited', namespace: 'default',
    }, ctx.db, ctx.config, noopLogger, noopMetrics);

    const result = queryGraph({}, ctx.db, ctx.config, noopLogger, noopMetrics);
    expect(result.nodes[0]?.entity.id).toBe(a.id);
    expect(result.edges).toHaveLength(2);
  });

  it('scopes by namespace — does not leak across tenants', () => {
    upsertEntity(ctx.db, 'Alice', 'person', 'tenant1');
    upsertEntity(ctx.db, 'Bob', 'person', 'tenant2');

    const r1 = queryGraph({ namespace: 'tenant1' }, ctx.db, ctx.config, noopLogger, noopMetrics);
    expect(r1.nodes).toHaveLength(1);
    expect(r1.nodes[0]?.entity.name).toBe('Alice');

    const r2 = queryGraph({ namespace: 'tenant2' }, ctx.db, ctx.config, noopLogger, noopMetrics);
    expect(r2.nodes).toHaveLength(1);
    expect(r2.nodes[0]?.entity.name).toBe('Bob');
  });

  it('still returns empty when entity_name is given but not found', () => {
    upsertEntity(ctx.db, 'Alice', 'person', 'default');
    const result = queryGraph(
      { entity_name: 'Zelda' },
      ctx.db, ctx.config, noopLogger, noopMetrics,
    );
    expect(result.nodes).toEqual([]);
    expect(result.mode).toBeUndefined();
  });

  // v0.29.5 graph hygiene. On a real DB 68/137 entities were synthetic
  // proxies manufactured by createContradictionEdge, carrying 183/194
  // relations — all 'contradicts'. Ranking by raw degree let those proxies
  // push every real entity out of the top-N, so the web UI graph showed
  // nothing but "memory:Consolidation…". Proxies now carry the RESERVED
  // type memory_proxy; that is the only thing the overview filters on.
  it('excludes reserved memory_proxy entities from the overview', () => {
    upsertEntity(ctx.db, 'Alice', 'person', 'default');
    upsertEntity(ctx.db, 'memory:Consolidation run on 2026-09-13 merged 258', MEMORY_PROXY_TYPE, 'default');
    upsertEntity(ctx.db, 'memory:Consolidation run on 2026-09-14 merged 260', MEMORY_PROXY_TYPE, 'default');

    const result = queryGraph({}, ctx.db, ctx.config, noopLogger, noopMetrics);
    expect(result.nodes.map((n) => n.entity.name)).toEqual(['Alice']);
  });

  it('keeps user entities that merely LOOK like proxies (Codex PR-18 P2, rounds 1+2)', () => {
    // Both a free-form type 'memory' and a 'memory:' name prefix are things
    // a user may legitimately choose; neither may hide their entity.
    upsertEntity(ctx.db, 'Working memory', 'memory', 'default');
    upsertEntity(ctx.db, 'memory:working', 'memory', 'default');
    upsertEntity(ctx.db, 'memory:Consolidation run on 2026-09-13 merged 258', MEMORY_PROXY_TYPE, 'default');

    const result = queryGraph({}, ctx.db, ctx.config, noopLogger, noopMetrics);
    expect(result.nodes.map((n) => n.entity.name).sort()).toEqual(['Working memory', 'memory:working']);
  });

  it('create_entity rejects the reserved memory_proxy type', () => {
    expect(() =>
      createEntity({ name: 'sneaky', entity_type: MEMORY_PROXY_TYPE }, ctx.db, ctx.config, noopLogger, noopMetrics),
    ).toThrow(/reserved/);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM entities WHERE name = 'sneaky'").get()).toEqual({ n: 0 });
  });

  it('does not count contradicts edges toward the degree ranking', () => {
    const a = upsertEntity(ctx.db, 'Alice', 'person', 'default');
    const b = upsertEntity(ctx.db, 'Bob', 'person', 'default');
    const c = upsertEntity(ctx.db, 'Carol', 'person', 'default');
    const d = upsertEntity(ctx.db, 'Dave', 'person', 'default');
    // Bob: one real edge (knows Carol) → degree 1.
    createRelation({
      source_entity_id: b.id, target_entity_id: c.id,
      relation_type: 'knows', namespace: 'default',
    }, ctx.db, ctx.config, noopLogger, noopMetrics);
    // Alice: two edges, but both 'contradicts' → degree 0 for ranking.
    createRelation({
      source_entity_id: a.id, target_entity_id: c.id,
      relation_type: 'contradicts', namespace: 'default',
    }, ctx.db, ctx.config, noopLogger, noopMetrics);
    createRelation({
      source_entity_id: a.id, target_entity_id: d.id,
      relation_type: 'contradicts', namespace: 'default',
    }, ctx.db, ctx.config, noopLogger, noopMetrics);

    const result = queryGraph({ limit: 2 }, ctx.db, ctx.config, noopLogger, noopMetrics);
    const names = result.nodes.map((n) => n.entity.name);
    expect(names).toContain('Bob');
    expect(names).toContain('Carol');
    expect(names).not.toContain('Alice');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      upsertEntity(ctx.db, `Person${i}`, 'person', 'default');
    }
    const result = queryGraph({ limit: 3 }, ctx.db, ctx.config, noopLogger, noopMetrics);
    expect(result.nodes).toHaveLength(3);
  });
});
