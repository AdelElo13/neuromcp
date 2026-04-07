import { describe, it, expect } from 'vitest';
import { mmrRerank } from '../../src/cognitive/mmr.js';
import type { MemoryWithScore } from '../../src/types.js';

function makeMemory(id: string, content: string, score: number): MemoryWithScore {
  return {
    id, content, similarity_score: score, summary: null, content_hash: '', embedding_model: 'fake',
    embedding_dim: 384, namespace: 'default', project_id: null, agent_id: null, source: 'user',
    source_trust: 'medium', visibility: 'namespace', schema_version: 1, category: 'general',
    tags: '[]', importance: 0.5, access_count: 0, created_at: '', updated_at: '',
    last_accessed_at: null, expires_at: null, is_deleted: 0, tombstoned_at: null,
    supersedes_id: null, superseded_by_id: null, metadata: '{}', valid_from: null, valid_to: null,
    surprise_score: 0, episode_id: null, cluster_id: null, review_interval_days: null,
    ease_factor: 2.5, next_review_at: null, review_count: 0,
  };
}

describe('mmrRerank', () => {
  it('returns empty for empty input', () => {
    expect(mmrRerank([], 0.7, 10)).toEqual([]);
  });

  it('returns single item unchanged', () => {
    const items = [makeMemory('a', 'hello world', 1.0)];
    expect(mmrRerank(items, 0.7, 10)).toHaveLength(1);
  });

  it('keeps first item as most relevant', () => {
    const items = [
      makeMemory('a', 'database optimization query', 0.9),
      makeMemory('b', 'database optimization tips', 0.8),
      makeMemory('c', 'machine learning pipeline', 0.7),
    ];
    const result = mmrRerank(items, 0.7, 10);
    expect(result[0]!.id).toBe('a');
  });

  it('diversifies near-duplicate content', () => {
    const items = [
      makeMemory('a', 'the quick brown fox jumps over the lazy dog', 0.9),
      makeMemory('b', 'the quick brown fox jumps over the lazy cat', 0.85),
      makeMemory('c', 'machine learning is transforming industries worldwide', 0.7),
    ];
    const result = mmrRerank(items, 0.5, 3);
    // 'c' should be promoted because it's diverse from 'a'
    expect(result[1]!.id).toBe('c');
  });

  it('respects limit', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeMemory(`m${i}`, `unique content number ${i}`, 1 - i * 0.1),
    );
    const result = mmrRerank(items, 0.7, 3);
    expect(result).toHaveLength(3);
  });
});
