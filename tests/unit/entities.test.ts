import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { upsertEntity, linkMemoryEntity, getEntitiesForMemory, searchEntities } from '../../src/graph/entities.js';
import { insertTestMemory } from '../helpers/index.js';

describe('entities', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('creates a new entity', () => {
    const e = upsertEntity(ctx.db, 'TypeScript', 'language', 'default');
    expect(e.name).toBe('TypeScript');
    expect(e.entity_type).toBe('language');
  });

  it('returns existing entity on duplicate (case-insensitive)', () => {
    const e1 = upsertEntity(ctx.db, 'TypeScript', 'language', 'default');
    const e2 = upsertEntity(ctx.db, 'typescript', 'language', 'default');
    expect(e1.id).toBe(e2.id);
  });

  it('links memory to entity', () => {
    const memId = insertTestMemory(ctx, { content: 'test' });
    const entity = upsertEntity(ctx.db, 'Vitest', 'tool', 'default');
    linkMemoryEntity(ctx.db, memId, entity.id);

    const linked = getEntitiesForMemory(ctx.db, memId);
    expect(linked).toHaveLength(1);
    expect(linked[0]!.name).toBe('Vitest');
  });

  it('searchEntities finds by name', () => {
    upsertEntity(ctx.db, 'GoAmanah', 'project', 'default');
    upsertEntity(ctx.db, 'DakDeel', 'project', 'default');

    const results = searchEntities(ctx.db, 'GoAmanah', 'default', 5);
    expect(results.some(e => e.name === 'GoAmanah')).toBe(true);
  });
});
