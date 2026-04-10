/**
 * Unit tests for explain mode — the transparency layer on search results.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { explainMemory } from '../../src/cognitive/explain.js';
import type { MemoryWithScore, TrustLevel, MemorySource } from '../../src/types.js';

describe('explainMemory', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  function makeMemory(overrides: Partial<MemoryWithScore> = {}): MemoryWithScore {
    const id = insertTestMemory(ctx, {
      content: overrides.content ?? 'test memory content',
      source: overrides.source as string ?? 'user',
      source_trust: overrides.source_trust as string ?? 'high',
      category: overrides.category ?? 'general',
    });

    const row = ctx.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryWithScore;
    return { ...row, similarity_score: overrides.similarity_score ?? 0.016 };
  }

  it('returns correct trust reason for user source', () => {
    const memory = makeMemory({ source: 'user' as MemorySource, source_trust: 'high' as TrustLevel });
    const explain = explainMemory(ctx.db, memory);

    expect(explain.source_trust.level).toBe('high');
    expect(explain.source_trust.reason).toContain('user');
  });

  it('returns correct trust reason for hook source', () => {
    const memory = makeMemory({ source: 'hook' as MemorySource, source_trust: 'medium' as TrustLevel });
    const explain = explainMemory(ctx.db, memory);

    expect(explain.source_trust.level).toBe('medium');
    expect(explain.source_trust.reason).toContain('hook');
  });

  it('reports currently_valid for active memory', () => {
    const memory = makeMemory();
    const explain = explainMemory(ctx.db, memory);

    expect(explain.temporal_validity.currently_valid).toBe(true);
    expect(explain.temporal_validity.superseded_by).toBeNull();
  });

  it('reports not valid for superseded memory', () => {
    const memory = makeMemory();
    // Supersede it
    const now = new Date().toISOString();
    ctx.db.prepare(
      'UPDATE memories SET valid_to = ?, superseded_by_id = ? WHERE id = ?',
    ).run(now, 'new-memory-id', memory.id);

    const updated = ctx.db.prepare('SELECT * FROM memories WHERE id = ?').get(memory.id) as MemoryWithScore;
    const explain = explainMemory(ctx.db, { ...updated, similarity_score: 0.016 });

    expect(explain.temporal_validity.currently_valid).toBe(false);
    expect(explain.temporal_validity.superseded_by).toBe('new-memory-id');
  });

  it('includes confidence breakdown', () => {
    const memory = makeMemory();
    const explain = explainMemory(ctx.db, memory);

    expect(explain.confidence.retrieval_score).toBe(0.016);
    expect(explain.confidence.source_trust_score).toBe(1.0); // high trust
    expect(explain.confidence.temporal_valid).toBe(true);
    expect(explain.confidence.has_contradictions).toBe(false);
    expect(explain.confidence.overall).toBeTypeOf('number');
    expect(explain.confidence.overall).toBeGreaterThan(0);
    expect(explain.confidence.overall).toBeLessThanOrEqual(1);
  });

  it('returns empty contradictions when none exist', () => {
    const memory = makeMemory();
    const explain = explainMemory(ctx.db, memory);

    expect(explain.contradictions).toEqual([]);
  });

  it('returns empty claims when none extracted', () => {
    const memory = makeMemory();
    const explain = explainMemory(ctx.db, memory);

    expect(explain.claims).toEqual([]);
  });

  it('returns claims when they exist', () => {
    const memory = makeMemory({ content: 'neuromcp has 231 tests' });
    // Insert a claim manually
    ctx.db.prepare(
      'INSERT INTO claims (id, memory_id, content, subject, predicate, object, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('claim-1', memory.id, 'neuromcp has 231 tests', 'neuromcp', 'has', '231 tests', 0.9);

    const explain = explainMemory(ctx.db, memory);

    expect(explain.claims.length).toBe(1);
    expect(explain.claims[0]!.subject).toBe('neuromcp');
    expect(explain.claims[0]!.predicate).toBe('has');
    expect(explain.claims[0]!.object).toBe('231 tests');
    expect(explain.claims[0]!.confidence).toBe(0.9);
  });
});
