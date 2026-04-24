import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { queryGraph, createRelation } from '../../src/tools/graph.js';
import { upsertEntity } from '../../src/graph/entities.js';
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

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      upsertEntity(ctx.db, `Person${i}`, 'person', 'default');
    }
    const result = queryGraph({ limit: 3 }, ctx.db, ctx.config, noopLogger, noopMetrics);
    expect(result.nodes).toHaveLength(3);
  });
});
