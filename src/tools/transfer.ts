import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { VectorStore } from '../vectors/types.js';
import type { Memory } from '../types.js';

export interface TransferableMemory {
  readonly memory: Memory;
  readonly transferability_score: number;
  readonly reason: string;
}

export interface TransferResult {
  readonly transferred: number;
  readonly skipped_duplicates: number;
  readonly skipped_errors: number;
  readonly target_namespace: string;
}

const TRANSFERABLE_CATEGORIES = new Set(['pattern', 'decision', 'error', 'config', 'fact', 'learning']);
const PROJECT_SPECIFIC_TYPES = new Set(['conversation', 'preference', 'session']);

/**
 * Find memories in source namespace that could be useful in target.
 * Scores each memory for transferability (universal vs project-specific).
 */
export async function findTransferable(
  db: Database.Database,
  embedder: EmbeddingProvider,
  vecStore: VectorStore,
  input: {
    source_namespace: string;
    target_namespace: string;
    min_importance?: number;
    categories?: string[];
    limit?: number;
  },
): Promise<readonly TransferableMemory[]> {
  const minImportance = input.min_importance ?? 0.5;
  const categories = input.categories ?? [...TRANSFERABLE_CATEGORIES];
  const limit = input.limit ?? 20;

  const placeholders = categories.map(() => '?').join(',');
  const sourceMemories = db.prepare(`
    SELECT * FROM memories
    WHERE namespace = ? AND is_deleted = 0
      AND importance >= ?
      AND category IN (${placeholders})
    ORDER BY importance DESC
    LIMIT ?
  `).all(input.source_namespace, minImportance, ...categories, limit * 3) as Memory[];

  // Check for duplicates in target namespace
  const targetMemories = db.prepare(`
    SELECT content_hash FROM memories WHERE namespace = ? AND is_deleted = 0
  `).all(input.target_namespace) as Array<{ content_hash: string }>;
  const targetHashes = new Set(targetMemories.map(m => m.content_hash));

  const results: TransferableMemory[] = [];

  for (const mem of sourceMemories) {
    if (results.length >= limit) break;

    // Skip if already exists in target
    if (targetHashes.has(mem.content_hash)) continue;

    // Score transferability
    let score = 0;
    let reason = '';

    // Category bonus
    if (TRANSFERABLE_CATEGORIES.has(mem.category)) {
      score += 0.3;
      reason = `${mem.category} knowledge`;
    }
    if (PROJECT_SPECIFIC_TYPES.has(mem.category)) {
      score -= 0.5;
      reason = 'project-specific';
    }

    // Importance bonus
    score += mem.importance * 0.3;

    // Access count bonus (well-used knowledge)
    score += Math.min(0.2, Math.log(1 + mem.access_count) * 0.05);

    // Content analysis: penalize project-specific references
    const content = mem.content.toLowerCase();
    const hasProjectPaths = /\/users\/|localhost|127\.0\.0\.1/.test(content);
    const hasUniversalPatterns = /pattern|best practice|always|never|tip|rule|convention/.test(content);

    if (hasProjectPaths) score -= 0.2;
    if (hasUniversalPatterns) score += 0.15;

    if (score > 0.2) {
      results.push({ memory: mem, transferability_score: Math.min(1, score), reason });
    }
  }

  results.sort((a, b) => b.transferability_score - a.transferability_score);
  return results.slice(0, limit);
}

/**
 * Transfer memories from source to target namespace.
 */
export async function transferMemories(
  db: Database.Database,
  embedder: EmbeddingProvider,
  vecStore: VectorStore,
  input: {
    memory_ids: string[];
    target_namespace: string;
    adapt?: boolean;
  },
): Promise<TransferResult> {
  const adapt = input.adapt !== false;
  let transferred = 0;
  let skippedDuplicates = 0;
  let skippedErrors = 0;

  const targetHashes = new Set(
    (db.prepare('SELECT content_hash FROM memories WHERE namespace = ? AND is_deleted = 0')
      .all(input.target_namespace) as Array<{ content_hash: string }>)
      .map(m => m.content_hash),
  );

  const now = new Date().toISOString();

  // Per-memory: adapt → dedup on the hash of the content that will actually
  // be stored → embed (async, outside the transaction) → write memories +
  // vec + FTS atomically. Dedup used to check the source's ORIGINAL hash
  // while storing the ADAPTED content's hash, so adapted transfers were
  // re-inserted on every call; and the embed pass ran after the commit with
  // no error handling, leaving committed rows invisible to vector search
  // when the embedder failed.
  const insertOne = db.transaction(
    (row: {
      newId: string;
      contentHash: string;
      content: string;
      sourceTrust: string;
      category: string;
      tags: string;
      importance: number;
      embeddingModel: string;
      embeddingDim: number;
      sourceId: string;
      embedding: Float32Array;
    }) => {
      db.prepare(`
        INSERT INTO memories (id, content_hash, content, namespace, source, source_trust,
          category, tags, importance, created_at, updated_at, schema_version,
          embedding_model, embedding_dim, metadata)
        VALUES (?, ?, ?, ?, 'consolidation', ?, ?, ?, ?, ?, ?, 2, ?, ?,
          json_set('{}', '$.transferred_from', ?))
      `).run(
        row.newId, row.contentHash, row.content, input.target_namespace,
        row.sourceTrust, row.category, row.tags, row.importance,
        now, now, row.embeddingModel, row.embeddingDim, row.sourceId,
      );

      vecStore.upsert(row.newId, row.embedding);

      const inserted = db
        .prepare('SELECT rowid FROM memories WHERE id = ?')
        .get(row.newId) as { rowid: number };
      db.prepare(
        'INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, ?, ?)',
      ).run(inserted.rowid, row.content, row.tags, row.category);
    },
  );

  for (const memId of input.memory_ids) {
    const source = db.prepare('SELECT * FROM memories WHERE id = ?').get(memId) as Memory | undefined;
    if (!source) continue;

    let content = source.content;
    if (adapt) {
      // Strip project-specific paths but keep the knowledge
      content = content.replace(/\/Users\/\w+\/[^\s,)]+/g, '<path>');
      content = content.replace(/localhost:\d+/g, '<host>');
    }

    const contentHash = createHash('sha256').update(content).digest('hex');

    // Skip duplicates — keyed on the hash of the stored (possibly adapted)
    // content, so re-running the same transfer is idempotent.
    if (targetHashes.has(contentHash)) {
      skippedDuplicates++;
      continue;
    }

    let embedding: Float32Array;
    try {
      embedding = await embedder.embed(content);
    } catch {
      // Embedder failure: skip this memory entirely rather than committing
      // a row that vector search can never find.
      skippedErrors++;
      continue;
    }

    const newId = createHash('sha256')
      .update('transfer-' + Date.now() + '-' + Math.random())
      .digest('hex').slice(0, 32);

    insertOne({
      newId,
      contentHash,
      content,
      sourceTrust: source.source_trust,
      category: source.category,
      tags: source.tags,
      importance: source.importance * 0.9, // slightly reduce importance for transfers
      embeddingModel: embedder.name,
      embeddingDim: embedder.dimensions,
      sourceId: source.id,
      embedding,
    });

    targetHashes.add(contentHash);
    transferred++;
  }

  return {
    transferred,
    skipped_duplicates: skippedDuplicates,
    skipped_errors: skippedErrors,
    target_namespace: input.target_namespace,
  };
}
