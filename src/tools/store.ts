import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { NeuromcpConfig } from '../config.js';
import type { Memory, StoreResult, TrustLevel, MemorySource } from '../types.js';
import { defaultTrustForSource } from '../governance/trust.js';

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

function mergeTags(existing: string, incoming: readonly string[]): string {
  const existingTags: string[] = JSON.parse(existing);
  const merged = [...new Set([...existingTags, ...incoming])];
  return JSON.stringify(merged);
}

export async function storeMemory(
  input: StoreInput,
  deps: StoreDeps,
): Promise<StoreResult> {
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

    return { id: exactMatch.id, matched: true, similarity: 1.0 };
  }

  // Step 2: Generate embedding
  const embedding = await embedder.embed(input.content);

  // Step 3: Semantic dedup — search for nearest neighbors
  const neighbors = vecStore.search(embedding, 5);

  for (const neighbor of neighbors) {
    const similarity = 1 - neighbor.distance;
    if (similarity > config.dedupThreshold) {
      // Check that the neighbor is in the same namespace and not deleted
      const existing = db
        .prepare(
          'SELECT id, importance, tags FROM memories WHERE id = ? AND namespace = ? AND is_deleted = 0 LIMIT 1',
        )
        .get(neighbor.id, namespace) as
        | { id: string; importance: number; tags: string }
        | undefined;

      if (existing !== undefined) {
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

        return { id: existing.id, matched: true, similarity };
      }
    }
  }

  // Step 4: No match — insert new memory
  const id = generateId();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO memories (
      id, content_hash, content, summary, embedding_model, embedding_dim,
      namespace, project_id, agent_id, source, source_trust, visibility,
      schema_version, category, tags, importance, access_count,
      created_at, updated_at, last_accessed_at, expires_at,
      is_deleted, tombstoned_at, supersedes_id, superseded_by_id, metadata
    ) VALUES (
      ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'namespace', 1, ?, ?, ?, 0,
      ?, ?, NULL, ?, 0, NULL, NULL, NULL, ?
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
    importance,
    now,
    now,
    input.expires_at ?? null,
    metadataJson,
  );

  // Upsert embedding into vector store
  vecStore.upsert(id, embedding);

  // Sync to FTS
  const row = db
    .prepare('SELECT rowid FROM memories WHERE id = ?')
    .get(id) as { rowid: number };

  db.prepare(
    'INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, ?, ?)',
  ).run(row.rowid, input.content, tagsJson, category);

  logger.info('store', 'new memory stored', { id, namespace, category });
  metrics.increment('store.new');
  metrics.record('store.duration_ms', Date.now() - start);

  return { id, matched: false };
}
