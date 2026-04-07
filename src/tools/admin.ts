import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { NeuromcpConfig } from '../config.js';
import type { Memory } from '../types.js';

// ─── Export ────────────────────────────────────────────────────────

export interface ExportInput {
  readonly namespace?: string;
  readonly format?: 'jsonl' | 'json';
  readonly include_tombstoned?: boolean;
}

export function exportMemories(
  input: ExportInput,
  db: Database.Database,
  config: NeuromcpConfig,
): string {
  const namespace = input.namespace ?? config.defaultNamespace;
  const format = input.format ?? 'jsonl';
  const includeTombstoned = input.include_tombstoned ?? false;

  const isAll = namespace === '*';
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!isAll) {
    conditions.push('namespace = ?');
    params.push(namespace);
  }

  if (!includeTombstoned) {
    conditions.push('is_deleted = 0');
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare(`SELECT * FROM memories ${whereClause} ORDER BY created_at ASC`)
    .all(...params) as Memory[];

  // Strip embedding-related fields from export (they are regenerated on import)
  const stripped = rows.map((row) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { embedding_model, embedding_dim, ...rest } = row;
    return rest;
  });

  if (format === 'json') {
    return JSON.stringify(stripped, null, 2);
  }

  // JSONL
  return stripped.map((r) => JSON.stringify(r)).join('\n');
}

// ─── Import ────────────────────────────────────────────────────────

export interface ImportInput {
  readonly data: string;
  readonly namespace?: string;
  readonly trust?: 'high' | 'medium' | 'low' | 'unverified';
}

export interface ImportResult {
  readonly imported: number;
  readonly skipped: number;
  readonly errors: number;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function generateId(): string {
  return randomBytes(16).toString('hex');
}

interface ImportRow {
  readonly content?: string;
  readonly namespace?: string;
  readonly category?: string;
  readonly tags?: string | string[];
  readonly importance?: number;
  readonly source?: string;
  readonly metadata?: string | Record<string, unknown>;
  readonly expires_at?: string | null;
  readonly project_id?: string | null;
  readonly agent_id?: string | null;
}

export async function importMemories(
  input: ImportInput,
  db: Database.Database,
  vecStore: VectorStore,
  embedder: EmbeddingProvider,
  config: NeuromcpConfig,
  logger: Logger,
  metrics: Metrics,
): Promise<ImportResult> {
  const trust = input.trust ?? 'unverified';
  const namespace = input.namespace ?? config.defaultNamespace;

  // Parse input data — supports JSONL or JSON array
  let records: ImportRow[];
  const trimmed = input.data.trim();
  if (trimmed.startsWith('[')) {
    records = JSON.parse(trimmed) as ImportRow[];
  } else {
    records = trimmed
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ImportRow);
  }

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const record of records) {
    try {
      if (record.content === undefined || record.content.length === 0) {
        errors++;
        continue;
      }

      const hash = contentHash(record.content);

      // Dedup via content_hash
      const existing = db
        .prepare(
          'SELECT id FROM memories WHERE content_hash = ? AND namespace = ? AND is_deleted = 0 LIMIT 1',
        )
        .get(hash, namespace) as { id: string } | undefined;

      if (existing !== undefined) {
        skipped++;
        continue;
      }

      const id = generateId();
      const now = new Date().toISOString();
      const tags =
        typeof record.tags === 'string'
          ? record.tags
          : JSON.stringify(record.tags ?? []);
      const metadata =
        typeof record.metadata === 'string'
          ? record.metadata
          : JSON.stringify(record.metadata ?? {});
      const category = record.category ?? 'general';
      const importance = record.importance ?? 0.5;

      db.prepare(
        `INSERT INTO memories (
          id, content_hash, content, summary, embedding_model, embedding_dim,
          namespace, project_id, agent_id, source, source_trust, visibility,
          schema_version, category, tags, importance, access_count,
          created_at, updated_at, last_accessed_at, expires_at,
          is_deleted, tombstoned_at, supersedes_id, superseded_by_id, metadata
        ) VALUES (
          ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'auto', ?, 'namespace', 1, ?, ?, ?, 0,
          ?, ?, NULL, ?, 0, NULL, NULL, NULL, ?
        )`,
      ).run(
        id,
        hash,
        record.content,
        embedder.name,
        embedder.dimensions,
        namespace,
        record.project_id ?? null,
        record.agent_id ?? null,
        trust,
        category,
        tags,
        importance,
        now,
        now,
        record.expires_at ?? null,
        metadata,
      );

      // Generate fresh embedding
      const embedding = await embedder.embed(record.content);
      vecStore.upsert(id, embedding);

      // FTS sync
      const row = db
        .prepare('SELECT rowid FROM memories WHERE id = ?')
        .get(id) as { rowid: number };
      db.prepare(
        'INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, ?, ?)',
      ).run(row.rowid, record.content, tags, category);

      imported++;
    } catch (err) {
      logger.error('import', 'failed to import record', {
        error: err instanceof Error ? err.message : String(err),
      });
      errors++;
    }
  }

  logger.info('import', 'import complete', { imported, skipped, errors });
  metrics.increment('import.imported', imported);
  metrics.increment('import.skipped', skipped);
  metrics.increment('import.errors', errors);

  return { imported, skipped, errors };
}
