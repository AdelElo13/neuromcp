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

  const targetHashes = new Set(
    (db.prepare('SELECT content_hash FROM memories WHERE namespace = ? AND is_deleted = 0')
      .all(input.target_namespace) as Array<{ content_hash: string }>)
      .map(m => m.content_hash),
  );

  const now = new Date().toISOString();

  const transaction = db.transaction(() => {
    for (const memId of input.memory_ids) {
      const source = db.prepare('SELECT * FROM memories WHERE id = ?').get(memId) as Memory | undefined;
      if (!source) continue;

      // Skip duplicates
      if (targetHashes.has(source.content_hash)) {
        skippedDuplicates++;
        continue;
      }

      let content = source.content;
      if (adapt) {
        // Strip project-specific paths but keep the knowledge
        content = content.replace(/\/Users\/\w+\/[^\s,)]+/g, '<path>');
        content = content.replace(/localhost:\d+/g, '<host>');
      }

      const newId = createHash('sha256')
        .update('transfer-' + Date.now() + '-' + Math.random())
        .digest('hex').slice(0, 32);
      const contentHash = createHash('sha256').update(content).digest('hex');

      db.prepare(`
        INSERT INTO memories (id, content_hash, content, namespace, source, source_trust,
          category, tags, importance, created_at, updated_at, schema_version,
          embedding_model, embedding_dim, metadata)
        VALUES (?, ?, ?, ?, 'consolidation', ?, ?, ?, ?, ?, ?, 2, ?, ?,
          json_set('{}', '$.transferred_from', ?))
      `).run(
        newId, contentHash, content, input.target_namespace,
        source.source_trust, source.category, source.tags,
        source.importance * 0.9, // slightly reduce importance for transfers
        now, now, source.embedding_model, source.embedding_dim,
        source.id,
      );

      transferred++;
    }
  });

  transaction();

  // Embed transferred memories so they appear in vector search
  const transferredMems = db.prepare(`
    SELECT id, content FROM memories
    WHERE namespace = ? AND source = 'consolidation' AND is_deleted = 0
      AND json_extract(metadata, '$.transferred_from') IS NOT NULL
      AND created_at = ?
  `).all(input.target_namespace, now) as Array<{ id: string; content: string }>;

  for (const mem of transferredMems) {
    const embedding = await embedder.embed(mem.content);
    vecStore.upsert(mem.id, embedding);
  }

  return { transferred, skipped_duplicates: skippedDuplicates, target_namespace: input.target_namespace };
}
