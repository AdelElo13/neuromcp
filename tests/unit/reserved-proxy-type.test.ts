import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { upsertEntity } from '../../src/graph/entities.js';
import { extractEntitiesDispatch } from '../../src/graph/extract.js';
import { MEMORY_PROXY_TYPE } from '../../src/graph/memory-proxy.js';

vi.mock('../../src/graph/llm-extract.js', () => ({
  extractWithLLM: vi.fn(async () => ({
    entities: [
      { name: 'Working memory', type: MEMORY_PROXY_TYPE },
      { name: 'Atlas API', type: 'project' },
    ],
    relations: [],
  })),
}));

/**
 * v0.29.5 — the reserved proxy type is enforced at the single write path.
 * Round 5 (Codex PR-18): the Ollama extractor accepted any type a model
 * emitted and wrote it straight through upsertEntity, so a model answer
 * {type: "memory_proxy"} produced a hidden entity with no proxy reference.
 */
describe('reserved memory_proxy type', () => {
  let ctx: TestContext;
  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('upsertEntity refuses the reserved type unless the internal caller opts in', () => {
    expect(() => upsertEntity(ctx.db, 'sneaky', MEMORY_PROXY_TYPE, 'default')).toThrow(/reserved/);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM entities WHERE name = 'sneaky'").get()).toEqual({ n: 0 });
    const proxy = upsertEntity(ctx.db, 'memory:x #id', MEMORY_PROXY_TYPE, 'default', {}, { allowReservedType: true });
    expect(proxy.entity_type).toBe(MEMORY_PROXY_TYPE);
  });

  it('the LLM extraction path drops a reserved-type entity instead of writing it', async () => {
    const memoryId = insertTestMemory(ctx, { content: 'Atlas API is the backend' });
    const extracted = await extractEntitiesDispatch(
      ctx.db, memoryId, 'Atlas API is the backend', 'default',
      { entityExtractionMode: 'llm', ollamaHost: 'http://127.0.0.1:1', ollamaChatModel: 'stub' },
      { debug: () => {} },
    );
    expect(extracted.map((e) => e.name)).toEqual(['Atlas API']);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM entities WHERE entity_type = ?').get(MEMORY_PROXY_TYPE)).toEqual({ n: 0 });
  });
});
