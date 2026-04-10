import type Database from 'better-sqlite3';
import type { MemoryWithScore, TrustLevel } from '../types.js';

/**
 * Explanation payload attached to each search result.
 * Answers: why was this returned? How confident should you be? What contradicts it?
 */
export interface MemoryExplanation {
  /** Why this trust level was assigned */
  readonly source_trust: {
    readonly level: TrustLevel;
    readonly reason: string;
  };
  /** Is this memory currently temporally valid? */
  readonly temporal_validity: {
    readonly currently_valid: boolean;
    readonly valid_from: string | null;
    readonly valid_to: string | null;
    readonly superseded_by: string | null;
  };
  /** Contradicting memories (via knowledge graph 'contradicts' edges) */
  readonly contradictions: readonly {
    readonly memory_id: string;
    readonly content_preview: string;
    readonly resolution: string;
  }[];
  /** Atomic claims extracted from this memory */
  readonly claims: readonly {
    readonly subject: string;
    readonly predicate: string;
    readonly object: string;
    readonly confidence: number;
  }[];
  /** Breakdown of the retrieval score */
  readonly confidence: {
    readonly retrieval_score: number;
    readonly source_trust_score: number;
    readonly temporal_valid: boolean;
    readonly has_contradictions: boolean;
    readonly claim_count: number;
    /** Overall confidence: combined signal */
    readonly overall: number;
  };
}

export interface MemoryWithExplanation extends MemoryWithScore {
  readonly explain: MemoryExplanation;
}

const TRUST_REASONS: Record<string, string> = {
  user: 'Directly provided by user — highest confidence',
  'claude-code': 'Stored by Claude Code agent — verified at write time',
  hook: 'Auto-captured by session hook — medium confidence, verify if critical',
  auto: 'Automatically generated — medium confidence',
  consolidation: 'Product of memory consolidation — derived from multiple sources',
  error: 'Stored from error context — low confidence, may be outdated',
};

const TRUST_SCORES: Record<string, number> = {
  high: 1.0,
  medium: 0.7,
  low: 0.4,
  unverified: 0.2,
};

/**
 * Enrich a search result with explanation metadata.
 */
export function explainMemory(
  db: Database.Database,
  memory: MemoryWithScore,
): MemoryExplanation {
  const now = new Date().toISOString();

  // 1. Trust explanation
  const source_trust = {
    level: memory.source_trust as TrustLevel,
    reason: TRUST_REASONS[memory.source] ?? `Source: ${memory.source}`,
  };

  // 2. Temporal validity
  const validFrom = memory.valid_from;
  const validTo = memory.valid_to;
  const supersededBy = memory.superseded_by_id;
  const currentlyValid =
    supersededBy === null &&
    (validFrom === null || validFrom <= now) &&
    (validTo === null || validTo > now);

  const temporal_validity = {
    currently_valid: currentlyValid,
    valid_from: validFrom,
    valid_to: validTo,
    superseded_by: supersededBy,
  };

  // 3. Find contradictions via knowledge graph
  const contradictions = findContradictions(db, memory.id);

  // 4. Find claims
  const claims = findClaims(db, memory.id);

  // 5. Confidence breakdown
  const trustScore = TRUST_SCORES[memory.source_trust] ?? 0.5;
  const hasContradictions = contradictions.length > 0;

  // Overall confidence: weighted combination
  // Retrieval score is already 0-1ish from RRF
  // Normalize: high trust + temporal valid + no contradictions + claims = high confidence
  const overall = Math.min(1.0,
    (memory.similarity_score * 30) +  // retrieval relevance (RRF scores are small)
    (trustScore * 0.3) +
    (currentlyValid ? 0.2 : 0) +
    (hasContradictions ? -0.15 : 0.1) +
    (claims.length > 0 ? 0.1 : 0),
  );

  const confidence = {
    retrieval_score: memory.similarity_score,
    source_trust_score: trustScore,
    temporal_valid: currentlyValid,
    has_contradictions: hasContradictions,
    claim_count: claims.length,
    overall: Math.round(overall * 100) / 100,
  };

  return { source_trust, temporal_validity, contradictions, claims, confidence };
}

function findContradictions(
  db: Database.Database,
  memoryId: string,
): MemoryExplanation['contradictions'] {
  // Find via memory_entities → relations (contradicts) → memory_entities
  try {
    const rows = db.prepare(`
      SELECT DISTINCT m2.id, substr(m2.content, 1, 120) as preview, r.metadata
      FROM memory_entities me1
      JOIN relations r ON (
        (r.source_entity_id = me1.entity_id OR r.target_entity_id = me1.entity_id)
        AND r.relation_type = 'contradicts'
        AND r.is_deleted = 0
      )
      JOIN memory_entities me2 ON (
        me2.entity_id = CASE
          WHEN r.source_entity_id = me1.entity_id THEN r.target_entity_id
          ELSE r.source_entity_id
        END
      )
      JOIN memories m2 ON m2.id = me2.memory_id AND m2.is_deleted = 0
      WHERE me1.memory_id = ? AND m2.id != ?
      LIMIT 5
    `).all(memoryId, memoryId) as Array<{ id: string; preview: string; metadata: string }>;

    return rows.map(row => {
      let resolution = 'unknown';
      try {
        const meta = JSON.parse(row.metadata);
        resolution = meta.resolution ?? 'unknown';
      } catch { /* ignore */ }
      return {
        memory_id: row.id,
        content_preview: row.preview,
        resolution,
      };
    });
  } catch {
    return [];
  }
}

function findClaims(
  db: Database.Database,
  memoryId: string,
): MemoryExplanation['claims'] {
  try {
    const rows = db.prepare(
      'SELECT subject, predicate, object, confidence FROM claims WHERE memory_id = ? LIMIT 10',
    ).all(memoryId) as Array<{ subject: string; predicate: string; object: string; confidence: number }>;

    return rows;
  } catch {
    return [];
  }
}
