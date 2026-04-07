import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { extractEntities } from '../../src/graph/extract.js';

describe('extractEntities (regex)', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('extracts bracketed type markers', () => {
    const memId = insertTestMemory(ctx, { content: '[project] GoAmanah is a zakat platform' });
    const entities = extractEntities(ctx.db, memId, '[project] GoAmanah is a zakat platform', 'default');
    expect(entities.some(e => e.name.includes('GoAmanah'))).toBe(true);
  });

  it('extracts file paths', () => {
    const memId = insertTestMemory(ctx, { content: 'Config at /Users/adel/projects/neuromcp/config.ts' });
    const entities = extractEntities(ctx.db, memId, 'Config at /Users/adel/projects/neuromcp/config.ts', 'default');
    expect(entities.some(e => e.entity_type === 'path')).toBe(true);
  });

  it('extracts scoped packages', () => {
    const memId = insertTestMemory(ctx, { content: 'Using @anthropic-ai/sdk for API calls' });
    const entities = extractEntities(ctx.db, memId, 'Using @anthropic-ai/sdk for API calls', 'default');
    expect(entities.some(e => e.entity_type === 'package')).toBe(true);
  });

  it('extracts URLs', () => {
    const memId = insertTestMemory(ctx, { content: 'Deployed at https://agentproofs.io' });
    const entities = extractEntities(ctx.db, memId, 'Deployed at https://agentproofs.io', 'default');
    expect(entities.some(e => e.entity_type === 'url')).toBe(true);
  });

  it('persists entities in database', () => {
    const memId = insertTestMemory(ctx, { content: '[tool] Playwright is used for testing' });
    extractEntities(ctx.db, memId, '[tool] Playwright is used for testing', 'default');

    const count = ctx.db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number };
    expect(count.c).toBeGreaterThan(0);
  });
});
