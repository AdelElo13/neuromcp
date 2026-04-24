import { describe, it, expect } from 'vitest';
import { toCompact } from '../../src/tools/search.js';
import type { MemoryWithScore } from '../../src/types.js';

function sampleFullMemory(): MemoryWithScore {
  return {
    id: 'mem_abc',
    content_hash: 'hash',
    content: 'the content',
    summary: null,
    namespace: 'default',
    project_id: null,
    agent_id: null,
    source: 'user',
    source_trust: 'medium',
    category: 'test',
    tags: '["foo"]',
    importance: 0.7,
    metadata: '{}',
    created_at: '2026-04-24T10:00:00.000Z',
    updated_at: '2026-04-24T10:00:00.000Z',
    schema_version: 12,
    visibility: 'namespace',
    embedding_model: 'fake',
    embedding_dim: 384,
    access_count: 3,
    last_accessed_at: null,
    is_deleted: 0,
    surprise_score: 0,
    ease_factor: 2.5,
    interval_days: null,
    next_review_at: null,
    review_count: 0,
    last_review_at: null,
    last_review_quality: null,
    centrality_score: null,
    valid_from: null,
    valid_to: null,
    superseded_by: null,
    superseded_at: null,
    episode_id: null,
    similarity_score: 0.92,
  } as MemoryWithScore;
}

describe('toCompact', () => {
  it('reduces a 37-field MemoryWithScore to 7 fields', () => {
    const full = sampleFullMemory();
    const compact = toCompact(full);
    expect(Object.keys(compact).sort()).toEqual(
      ['category', 'content', 'created_at', 'id', 'importance', 'similarity_score', 'tags'],
    );
    expect(compact.id).toBe('mem_abc');
    expect(compact.content).toBe('the content');
    expect(compact.similarity_score).toBe(0.92);
    expect(compact.category).toBe('test');
    expect(compact.tags).toBe('["foo"]');
    expect(compact.importance).toBe(0.7);
    expect(compact.created_at).toBe('2026-04-24T10:00:00.000Z');
  });

  it('coerces missing category to null', () => {
    const full = { ...sampleFullMemory(), category: null } as unknown as MemoryWithScore;
    const compact = toCompact(full);
    expect(compact.category).toBeNull();
  });

  it('preserves the explain field when present', () => {
    const full = sampleFullMemory();
    const withExplain = { ...full, explain: { why: 'high vector score' } };
    const compact = toCompact(withExplain as unknown as Parameters<typeof toCompact>[0]);
    expect('explain' in compact).toBe(true);
    expect((compact as { explain: unknown }).explain).toEqual({ why: 'high vector score' });
  });

  it('strips internal DB fields entirely (content_hash, embedding_model, ease_factor, etc.)', () => {
    const full = sampleFullMemory();
    const compact = toCompact(full) as Record<string, unknown>;
    for (const hidden of [
      'content_hash', 'embedding_model', 'embedding_dim', 'ease_factor',
      'next_review_at', 'schema_version', 'access_count', 'metadata',
      'namespace', 'updated_at', 'is_deleted', 'source_trust',
    ]) {
      expect(compact[hidden]).toBeUndefined();
    }
  });

  it('payload size is roughly 10× smaller than the full row (sanity)', () => {
    const full = sampleFullMemory();
    const fullSize = JSON.stringify(full).length;
    const compactSize = JSON.stringify(toCompact(full)).length;
    expect(compactSize).toBeLessThan(fullSize / 3); // at least 3× smaller
  });
});
