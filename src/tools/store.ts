import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { NeuromcpConfig } from '../config.js';
import type { StoreResultExtended, TrustLevel, MemorySource, Contradiction } from '../types.js';
import { defaultTrustForSource } from '../governance/trust.js';
import { computeSurprise } from '../cognitive/surprise.js';
import { detectContradictions, supersedMemory } from '../cognitive/contradiction.js';
import { extractEntitiesDispatch } from '../graph/extract.js';
import { extractClaims } from '../cognitive/claims.js';
import { createContradictionEdge } from '../graph/contradiction-edges.js';
import { eventBus } from '../transport/events.js';

export interface StoreInput {
  readonly content: string;
  readonly namespace?: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly importance?: number;
  readonly source?: MemorySource;
  readonly source_trust?: TrustLevel;
  readonly project_id?: string;
  readonly agent_id?: string;
  readonly metadata?: Record<string, unknown>;
  readonly expires_at?: string;
  readonly valid_from?: string;
  readonly valid_to?: string;
  readonly episode_id?: string;
}

export interface StoreDeps {
  readonly db: Database.Database;
  readonly vecStore: VectorStore;
  readonly embedder: EmbeddingProvider;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly config: NeuromcpConfig;
}

function generateId(): string {
  return createHash('sha256')
    .update(Date.now() + '-' + Math.random())
    .digest('hex')
    .slice(0, 32);
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Check if two near-duplicate texts have factual differences
 * (different numbers, opposite values) that make them contradictions rather than duplicates.
 */
function hasFactualDifference(a: string, b: string): boolean {
  // Extract numbers from both
  const numsA = (a.match(/\b\d+(?:\.\d+)?\b/g) ?? []).map(Number);
  const numsB = (b.match(/\b\d+(?:\.\d+)?\b/g) ?? []).map(Number);

  // If both have numbers but they differ, it's a factual difference
  if (numsA.length > 0 && numsB.length > 0) {
    const setA = new Set(numsA);
    const setB = new Set(numsB);
    const onlyInA = numsA.filter((n) => !setB.has(n));
    const onlyInB = numsB.filter((n) => !setA.has(n));
    if (onlyInA.length > 0 && onlyInB.length > 0) return true;
  }

  // Check for opposite boolean/state words
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  const opposites: Array<[string, string]> = [
    ['true', 'false'], ['yes', 'no'], ['enabled', 'disabled'],
    ['active', 'inactive'], ['valid', 'invalid'], ['open', 'closed'],
    ['allow', 'deny'], ['success', 'failure'],
  ];
  for (const [x, y] of opposites) {
    if ((aLower.includes(x) && bLower.includes(y)) || (aLower.includes(y) && bLower.includes(x))) {
      return true;
    }
  }

  return false;
}

function mergeTags(existing: string, incoming: readonly string[]): string {
  const existingTags: string[] = JSON.parse(existing);
  const merged = [...new Set([...existingTags, ...incoming])];
  return JSON.stringify(merged);
}

export async function storeMemory(
  input: StoreInput,
  deps: StoreDeps,
): Promise<StoreResultExtended> {
  const { db, vecStore, embedder, logger, metrics, config } = deps;
  const start = Date.now();

  const namespace = input.namespace ?? config.defaultNamespace;
  const source = input.source ?? 'user';
  const sourceTrust = input.source_trust ?? defaultTrustForSource(source);
  const category = input.category ?? 'general';
  const tags = input.tags ?? [];
  const importance = input.importance ?? 0.5;
  const metadata = input.metadata ?? {};
  const tagsJson = JSON.stringify([...tags]);
  const metadataJson = JSON.stringify(metadata);

  const hash = contentHash(input.content);

  // Step 1: Exact dedup — same hash + same namespace + not deleted
  const exactMatch = db
    .prepare(
      'SELECT id, importance, tags FROM memories WHERE content_hash = ? AND namespace = ? AND is_deleted = 0 LIMIT 1',
    )
    .get(hash, namespace) as
    | { id: string; importance: number; tags: string }
    | undefined;

  if (exactMatch !== undefined) {
    const newImportance = Math.max(exactMatch.importance, importance);
    const mergedTags = mergeTags(exactMatch.tags, [...tags]);
    db.prepare(
      "UPDATE memories SET importance = ?, tags = ?, access_count = access_count + 1, last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    ).run(newImportance, mergedTags, exactMatch.id);

    logger.info('store', 'exact dedup match', { id: exactMatch.id, namespace });
    metrics.increment('store.dedup_exact');
    metrics.record('store.duration_ms', Date.now() - start);

    eventBus.updated({ id: exactMatch.id, reason: 'exact_dedup', similarity: 1.0 });
    return { id: exactMatch.id, matched: true, similarity: 1.0 };
  }

  // Step 2: Generate embedding
  const embedding = await embedder.embed(input.content);

  // Step 3: Semantic dedup — search for nearest neighbors
  // But check for contradictions first: if content has factual differences
  // (numbers, opposites) despite high similarity, it's a contradiction, not a duplicate
  const neighbors = vecStore.search(embedding, 5);

  for (const neighbor of neighbors) {
    const similarity = 1 - neighbor.distance;
    if (similarity > config.dedupThreshold) {
      const existing = db
        .prepare(
          'SELECT id, content, importance, tags FROM memories WHERE id = ? AND namespace = ? AND is_deleted = 0 LIMIT 1',
        )
        .get(neighbor.id, namespace) as
        | { id: string; content: string; importance: number; tags: string }
        | undefined;

      if (existing !== undefined) {
        // Check if this is actually a contradiction disguised as a near-duplicate
        if (hasFactualDifference(input.content, existing.content)) {
          logger.info('store', 'Near-duplicate has factual differences — treating as new memory, not dedup', {
            existingId: existing.id,
            similarity,
          });
          // Don't dedup — fall through to store as new memory with contradiction detection
          break;
        }

        const newImportance = Math.max(existing.importance, importance);
        const mergedTags = mergeTags(existing.tags, [...tags]);
        db.prepare(
          "UPDATE memories SET importance = ?, tags = ?, access_count = access_count + 1, last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
        ).run(newImportance, mergedTags, existing.id);

        logger.info('store', 'semantic dedup match', {
          id: existing.id,
          similarity,
          namespace,
        });
        metrics.increment('store.dedup_semantic');
        metrics.record('store.duration_ms', Date.now() - start);

        eventBus.updated({ id: existing.id, reason: 'semantic_dedup', similarity });
        return { id: existing.id, matched: true, similarity };
      }
    }
  }

  // Step 4: Contradiction detection (Phase 3)
  let contradictions: readonly Contradiction[] = [];
  try {
    contradictions = await detectContradictions(
      input.content, namespace, db, vecStore, embedder, config.contradictionThreshold,
    );
    if (contradictions.length > 0) {
      logger.info('store', 'Contradictions detected', {
        count: contradictions.length,
        resolutions: contradictions.map((c) => c.resolution),
      });
      metrics.increment('store.contradictions_detected', contradictions.length);
    }
  } catch (err: unknown) {
    logger.warn('store', 'Contradiction detection failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 5: Surprise scoring (Phase 4)
  let surpriseScore = 0;
  try {
    surpriseScore = await computeSurprise(input.content, namespace, db, vecStore, embedder);
    metrics.record('store.surprise_score', surpriseScore);
  } catch (err: unknown) {
    logger.warn('store', 'Surprise scoring failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Boost importance based on surprise (novel info is more valuable)
  const adjustedImportance = Math.min(
    importance + (surpriseScore * 0.2),
    1.0,
  );

  // Step 6: Insert new memory
  const id = generateId();
  const now = new Date().toISOString();
  const validFrom = input.valid_from ?? now;

  // The memories row, its vector, and its FTS row must land atomically: a
  // crash or vec/FTS failure between separate statements used to leave a
  // committed memory that hybrid search can never find (or a vector for a
  // row that does not exist). The embedding is computed above, so the
  // transaction body is fully synchronous.
  const insertAtomically = db.transaction(() => {
    db.prepare(
      `INSERT INTO memories (
        id, content_hash, content, summary, embedding_model, embedding_dim,
        namespace, project_id, agent_id, source, source_trust, visibility,
        schema_version, category, tags, importance, access_count,
        created_at, updated_at, last_accessed_at, expires_at,
        is_deleted, tombstoned_at, supersedes_id, superseded_by_id, metadata,
        valid_from, valid_to, surprise_score, episode_id
      ) VALUES (
        ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'namespace', 2, ?, ?, ?, 0,
        ?, ?, NULL, ?, 0, NULL, NULL, NULL, ?,
        ?, ?, ?, ?
      )`,
    ).run(
      id,
      hash,
      input.content,
      embedder.name,
      embedder.dimensions,
      namespace,
      input.project_id ?? null,
      input.agent_id ?? null,
      source,
      sourceTrust,
      category,
      tagsJson,
      adjustedImportance,
      now,
      now,
      input.expires_at ?? null,
      metadataJson,
      validFrom,
      input.valid_to ?? null,
      surpriseScore,
      input.episode_id ?? null,
    );

    vecStore.upsert(id, embedding);

    const row = db
      .prepare('SELECT rowid FROM memories WHERE id = ?')
      .get(id) as { rowid: number };

    db.prepare(
      'INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, ?, ?)',
    ).run(row.rowid, input.content, tagsJson, category);
  });
  insertAtomically();

  // Step 7: Entity extraction — LLM (Ollama) with regex fallback
  let entitiesExtracted: readonly string[] = [];
  try {
    const entities = await extractEntitiesDispatch(db, id, input.content, namespace, {
      entityExtractionMode: config.entityExtractionMode,
      ollamaHost: config.ollamaHost,
      ollamaChatModel: config.ollamaChatModel,
    }, logger);
    entitiesExtracted = entities.map((e) => e.name);
    if (entities.length > 0) {
      logger.debug('store', 'Entities extracted', {
        count: entities.length,
        names: entitiesExtracted,
      });
      metrics.increment('store.entities_extracted', entities.length);
    }
  } catch (err: unknown) {
    logger.warn('store', 'Entity extraction failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 8: Claim extraction
  try {
    const claimResult = extractClaims(db, id, input.content);
    if (claimResult.claims.length > 0) {
      logger.debug('store', 'Claims extracted', {
        count: claimResult.claims.length,
        sentences: claimResult.raw_sentences,
        filtered: claimResult.filtered,
      });
      metrics.increment('store.claims_extracted', claimResult.claims.length);
    }
  } catch (err: unknown) {
    logger.warn('store', 'Claim extraction failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Step 9: Apply contradiction resolutions + create graph edges
  for (const contradiction of contradictions) {
    if (contradiction.resolution === 'supersede') {
      supersedMemory(db, contradiction.existing_id, id);
      logger.info('store', 'Memory superseded', {
        oldId: contradiction.existing_id,
        newId: id,
      });
    }
    // For all resolutions (supersede, coexist, flag): create a 'contradicts' edge
    // This enables later queries like "what contradicts this memory?"
    try {
      createContradictionEdge(db, id, contradiction.existing_id, namespace, {
        resolution: contradiction.resolution,
        similarity: contradiction.similarity,
      });
    } catch (err: unknown) {
      logger.warn('store', 'Failed to create contradiction edge', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('store', 'new memory stored', {
    id, namespace, category,
    surprise: surpriseScore.toFixed(3),
    contradictions: contradictions.length,
    entities: entitiesExtracted.length,
  });
  metrics.increment('store.new');
  metrics.record('store.duration_ms', Date.now() - start);

  eventBus.stored({
    id,
    namespace,
    category,
    surprise_score: surpriseScore,
    contradictions: contradictions.length,
    entities_extracted: entitiesExtracted.length,
  });

  return {
    id,
    matched: false,
    contradictions: contradictions.length > 0 ? contradictions : undefined,
    surprise_score: surpriseScore,
    entities_extracted: entitiesExtracted.length > 0 ? entitiesExtracted : undefined,
  };
}
