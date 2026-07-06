import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync, statSync } from 'node:fs';
import { openDatabase, closeDatabase } from '../../src/storage/database.js';
import { applySchema } from '../../src/storage/schema.js';
import { SqliteVecStore } from '../../src/vectors/sqlite-vec.js';
import { createLogger } from '../../src/observability/logger.js';
import { createMetrics } from '../../src/observability/metrics.js';
import { loadConfig } from '../../src/config.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';
import type { Logger } from '../../src/observability/logger.js';
import type { Metrics } from '../../src/observability/metrics.js';
import type { NeuromcpConfig } from '../../src/config.js';
import type Database from 'better-sqlite3';

export const DIMS = 384;

export class FakeEmbedder implements EmbeddingProvider {
  readonly name = 'fake';
  readonly dimensions = DIMS;
  readonly maxTokens = 512;

  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(DIMS);
    for (let i = 0; i < Math.min(text.length, DIMS); i++) {
      v[i] = (text.charCodeAt(i) - 96) / 26;
    }
    let norm = 0;
    for (let i = 0; i < DIMS; i++) norm += v[i]! * v[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < DIMS; i++) v[i] /= norm;
    return v;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

export interface TestContext {
  readonly db: Database.Database;
  readonly vecStore: SqliteVecStore;
  readonly embedder: FakeEmbedder;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly config: NeuromcpConfig;
  readonly dbPath: string;
}

export function setupTestDb(opts?: { dimensions?: number }): TestContext {
  const dims = opts?.dimensions ?? DIMS;
  const dbPath = join(
    tmpdir(),
    `neuromcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const db = openDatabase(dbPath);
  applySchema(db);
  const vecStore = new SqliteVecStore(dims);
  vecStore.initialize(db);
  const logger = createLogger({ level: 'error', format: 'text' });
  const metrics = createMetrics();
  const config = { ...loadConfig(), entityExtractionMode: 'regex' as const };
  const embedder = new FakeEmbedder();

  return { db, vecStore, embedder, logger, metrics, config, dbPath };
}

export function teardownTestDb(ctx: TestContext): void {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(ctx.dbPath + suffix);
    } catch {
      // ignore missing files
    }
  }
}

/**
 * Insert a memory row directly into the database for testing.
 * Returns the id.
 */
export function insertTestMemory(
  ctx: TestContext,
  overrides: Partial<{
    id: string;
    content: string;
    namespace: string;
    category: string;
    tags: string[];
    importance: number;
    access_count: number;
    source: string;
    source_trust: string;
    created_at: string;
    last_accessed_at: string | null;
    expires_at: string | null;
    is_deleted: number;
    tombstoned_at: string | null;
    content_hash: string;
    superseded_by_id: string | null;
    supersedes_id: string | null;
    valid_from: string | null;
    valid_to: string | null;
  }> = {},
): string {
  const id =
    overrides.id ??
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const content = overrides.content ?? `test content ${id}`;
  const namespace = overrides.namespace ?? 'default';
  const category = overrides.category ?? 'general';
  const tags = JSON.stringify(overrides.tags ?? []);
  const importance = overrides.importance ?? 0.5;
  const access_count = overrides.access_count ?? 0;
  const source = overrides.source ?? 'auto';
  const source_trust = overrides.source_trust ?? 'medium';
  const now = new Date().toISOString();
  const created_at = overrides.created_at ?? now;
  const last_accessed_at = overrides.last_accessed_at ?? null;
  const expires_at = overrides.expires_at ?? null;
  const is_deleted = overrides.is_deleted ?? 0;
  const tombstoned_at = overrides.tombstoned_at ?? null;
  const superseded_by_id = overrides.superseded_by_id ?? null;
  const supersedes_id = overrides.supersedes_id ?? null;
  const valid_from = overrides.valid_from ?? null;
  const valid_to = overrides.valid_to ?? null;
  const content_hash =
    overrides.content_hash ??
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

  ctx.db
    .prepare(
      `INSERT INTO memories (
        id, content_hash, content, summary, embedding_model, embedding_dim,
        namespace, project_id, agent_id, source, source_trust, visibility,
        schema_version, category, tags, importance, access_count,
        created_at, updated_at, last_accessed_at, expires_at,
        is_deleted, tombstoned_at, supersedes_id, superseded_by_id, metadata,
        valid_from, valid_to
      ) VALUES (
        ?, ?, ?, NULL, 'fake', 384,
        ?, NULL, NULL, ?, ?, 'namespace', 1, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, '{}',
        ?, ?
      )`,
    )
    .run(
      id,
      content_hash,
      content,
      namespace,
      source,
      source_trust,
      category,
      tags,
      importance,
      access_count,
      created_at,
      created_at,
      last_accessed_at,
      expires_at,
      is_deleted,
      tombstoned_at,
      supersedes_id,
      superseded_by_id,
      valid_from,
      valid_to,
    );

  return id;
}
