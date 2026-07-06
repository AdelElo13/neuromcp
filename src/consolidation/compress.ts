import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { VectorStore } from '../vectors/types.js';
import { createHash } from 'node:crypto';
import { summarizeMemories } from '../cognitive/summarize.js';

export interface CompressionResult {
  readonly digests_created: number;
  readonly memories_compressed: number;
  readonly memories_hard_deleted: number;
}

/**
 * Compress old memories by merging similar ones into digest memories.
 *
 * Algorithm:
 * 1. Find memories older than ageDays
 * 2. Embed and cluster by similarity (threshold)
 * 3. For clusters of minCluster+ memories: merge into a digest
 * 4. Hard-delete ancient zero-access memories
 */
export async function compressMemories(
  db: Database.Database,
  embedder: EmbeddingProvider,
  vecStore: VectorStore,
  namespace: string,
  options: { ageDays?: number; minCluster?: number; threshold?: number; hardDeleteDays?: number } = {},
): Promise<CompressionResult> {
  const ageDays = options.ageDays ?? 30;
  const minCluster = options.minCluster ?? 3;
  const threshold = options.threshold ?? 0.80;
  const hardDeleteDays = options.hardDeleteDays ?? 60;

  const cutoff = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000).toISOString();
  const hardDeleteCutoff = new Date(Date.now() - hardDeleteDays * 24 * 60 * 60 * 1000).toISOString();

  // Step 1: Get old memories
  const oldMemories = db.prepare(`
    SELECT id, content, importance, tags, category, created_at
    FROM memories
    WHERE namespace = ? AND is_deleted = 0 AND created_at < ?
    ORDER BY created_at ASC
  `).all(namespace, cutoff) as Array<{
    id: string; content: string; importance: number; tags: string; category: string; created_at: string;
  }>;

  if (oldMemories.length < minCluster) {
    // Not enough to compress, just handle hard deletes
    const hardDeleted = hardDeleteStale(db, namespace, hardDeleteCutoff);
    return { digests_created: 0, memories_compressed: 0, memories_hard_deleted: hardDeleted };
  }

  // Step 2: Embed all old memories
  const texts = oldMemories.map(m => m.content);
  const embeddings = await embedder.embedBatch(texts);

  // Step 3: Greedy clustering by similarity
  const assigned = new Set<number>();
  const clusters: number[][] = [];

  for (let i = 0; i < oldMemories.length; i++) {
    if (assigned.has(i)) continue;
    const cluster = [i];
    assigned.add(i);

    for (let j = i + 1; j < oldMemories.length; j++) {
      if (assigned.has(j)) continue;
      const sim = cosine(embeddings[i]!, embeddings[j]!);
      if (sim >= threshold) {
        cluster.push(j);
        assigned.add(j);
      }
    }

    if (cluster.length >= minCluster) {
      clusters.push(cluster);
    }
  }

  // Step 4: Create digest memories
  let digestsCreated = 0;
  let memoriesCompressed = 0;
  const now = new Date().toISOString();

  // v0.29 Fase 1B (Codex [HIGH] atomicity): everything that mutates state for
  // a cluster — inserting the digest, indexing its vector + FTS, tombstoning
  // the originals, dropping their vectors — must land in ONE transaction.
  // Previously the digest embed+vec+FTS ran AFTER the commit, so a crash in
  // between left the originals tombstoned/de-vectored while the digest was
  // not searchable (data loss). All async work (summaries + digest
  // embeddings) is precomputed here, OUTSIDE the sync transaction; if any of
  // it throws, no state has changed yet.
  interface PreparedDigest {
    readonly digestId: string;
    readonly contentHash: string;
    readonly content: string;
    readonly category: string;
    readonly tags: readonly string[];
    readonly importance: number;
    readonly sourceCount: number;
    readonly embedding: Float32Array;
    readonly memberIds: readonly string[];
  }
  const prepared: PreparedDigest[] = [];
  for (const cluster of clusters) {
    const members = cluster.map(i => oldMemories[i]!);
    const memberIds = members.map(m => m.id);
    const summaryResult = await summarizeMemories(db, embedder, memberIds, {
      maxSentences: Math.min(5, members.length),
      maxLength: 600,
    });
    const mergedContent = summaryResult.summary
      ? `[digest] Compressed from ${members.length} memories: ${summaryResult.summary}`
      : `[digest] Compressed from ${members.length} memories (no extractable sentences)`;

    const allTags = new Set<string>();
    for (const mem of members) {
      const tags: string[] = JSON.parse(mem.tags);
      tags.forEach(t => allTags.add(t));
    }

    const digestId = createHash('sha256')
      .update('digest-' + Date.now() + '-' + Math.random())
      .digest('hex').slice(0, 32);
    const contentHash = createHash('sha256').update(mergedContent).digest('hex');

    // Embed the digest NOW (async), before the transaction. If this throws,
    // we bail before any originals are touched.
    const embedding = await embedder.embed(mergedContent);

    prepared.push({
      digestId,
      contentHash,
      content: mergedContent,
      category: members[0]!.category,
      tags: [...allTags],
      importance: Math.max(...members.map(m => m.importance)),
      sourceCount: members.length,
      embedding,
      memberIds,
    });
  }

  const transaction = db.transaction(() => {
    for (const p of prepared) {
      // Insert digest
      db.prepare(`
        INSERT INTO memories (id, content_hash, content, namespace, source, source_trust,
          category, tags, importance, created_at, updated_at, schema_version,
          embedding_model, embedding_dim, valid_from, metadata)
        VALUES (?, ?, ?, ?, 'consolidation', 'high', ?, ?, ?, ?, ?, 2, ?, ?, ?, ?)
      `).run(
        p.digestId, p.contentHash, p.content, namespace,
        p.category, JSON.stringify(p.tags),
        p.importance, now, now,
        embedder.name, embedder.dimensions, now,
        JSON.stringify({ type: 'digest', source_count: p.sourceCount }),
      );

      // Index the digest's vector + FTS INSIDE the transaction, so the digest
      // is searchable the instant its originals disappear.
      vecStore.upsert(p.digestId, p.embedding);
      const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(p.digestId) as { rowid: number } | undefined;
      if (row) {
        try {
          db.prepare('INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, ?, ?)').run(
            row.rowid, p.content, '[]', 'general',
          );
        } catch { /* FTS entry may already exist */ }
      }

      // Tombstone originals. Also drop their vectors: the KNN index has no
      // notion of is_deleted, so compressed members would keep consuming
      // top-k candidate slots that searchMemory then discards post-fetch.
      const tombstoneStmt = db.prepare(
        'UPDATE memories SET is_deleted = 1, tombstoned_at = ?, superseded_by_id = ? WHERE id = ?',
      );
      for (const memId of p.memberIds) {
        tombstoneStmt.run(now, p.digestId, memId);
        vecStore.remove(memId);
      }

      digestsCreated++;
      memoriesCompressed += p.sourceCount;
    }
  });

  transaction();

  // Step 5: Hard delete ancient zero-access memories
  const hardDeleted = hardDeleteStale(db, namespace, hardDeleteCutoff);

  return { digests_created: digestsCreated, memories_compressed: memoriesCompressed, memories_hard_deleted: hardDeleted };
}

function hardDeleteStale(db: Database.Database, namespace: string, cutoff: string): number {
  // Hard delete: memories with 0 access, low importance, very old, already tombstoned
  const result = db.prepare(`
    DELETE FROM memories
    WHERE namespace = ? AND is_deleted = 1 AND tombstoned_at < ? AND access_count = 0 AND importance < 0.1
  `).run(namespace, cutoff);
  return result.changes;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}
