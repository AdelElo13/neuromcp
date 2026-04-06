import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync } from 'node:fs';
import { openDatabase, closeDatabase } from '../../src/storage/database.js';
import { applySchema } from '../../src/storage/schema.js';
import { SqliteVecStore } from '../../src/vectors/sqlite-vec.js';
import { createLogger } from '../../src/observability/logger.js';
import { createMetrics } from '../../src/observability/metrics.js';
import { loadConfig } from '../../src/config.js';
import type { EmbeddingProvider } from '../../src/embeddings/types.js';
import type { StoreDeps } from '../../src/tools/store.js';
import { storeMemory } from '../../src/tools/store.js';

const DIMS = 384;

class FakeEmbedder implements EmbeddingProvider {
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

describe('storeMemory', () => {
  const testDb = join(tmpdir(), `neuromcp-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  let deps: StoreDeps;

  beforeEach(() => {
    const db = openDatabase(testDb);
    applySchema(db);
    const vecStore = new SqliteVecStore(DIMS);
    vecStore.initialize(db);
    const logger = createLogger({ level: 'error', format: 'text' });
    const metrics = createMetrics();
    const config = loadConfig();

    deps = { db, vecStore, embedder: new FakeEmbedder(), logger, metrics, config };
  });

  afterEach(() => {
    closeDatabase();
    try {
      unlinkSync(testDb);
      unlinkSync(testDb + '-wal');
      unlinkSync(testDb + '-shm');
    } catch {
      // ignore missing files
    }
  });

  it('stores a new memory and returns id', async () => {
    const result = await storeMemory({ content: 'hello world' }, deps);

    expect(result.id).toBeDefined();
    expect(result.id.length).toBe(32);
    expect(result.matched).toBe(false);
    expect(result.similarity).toBeUndefined();

    // Verify row in database
    const row = deps.db
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(result.id) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row['content']).toBe('hello world');
    expect(row['namespace']).toBe('default');
    expect(row['is_deleted']).toBe(0);
  });

  it('deduplicates exact same content (same hash)', async () => {
    const first = await storeMemory({ content: 'duplicate me' }, deps);
    const second = await storeMemory({ content: 'duplicate me' }, deps);

    expect(second.matched).toBe(true);
    expect(second.similarity).toBe(1.0);
    expect(second.id).toBe(first.id);

    // Only one row in DB
    const count = deps.db
      .prepare('SELECT COUNT(*) as cnt FROM memories')
      .get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('respects namespace isolation (same content, different namespace = not deduped)', async () => {
    const first = await storeMemory(
      { content: 'same content', namespace: 'ns-a' },
      deps,
    );
    const second = await storeMemory(
      { content: 'same content', namespace: 'ns-b' },
      deps,
    );

    expect(second.matched).toBe(false);
    expect(second.id).not.toBe(first.id);

    const count = deps.db
      .prepare('SELECT COUNT(*) as cnt FROM memories')
      .get() as { cnt: number };
    expect(count.cnt).toBe(2);
  });

  it('stores with all governance fields', async () => {
    const result = await storeMemory(
      {
        content: 'governed memory',
        source: 'claude-code',
        source_trust: 'high',
        project_id: 'proj-1',
        agent_id: 'agent-1',
        category: 'code',
        tags: ['typescript', 'mcp'],
        importance: 0.9,
        metadata: { key: 'value' },
        expires_at: '2030-01-01T00:00:00Z',
      },
      deps,
    );

    const row = deps.db
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(result.id) as Record<string, unknown>;

    expect(row['source']).toBe('claude-code');
    expect(row['source_trust']).toBe('high');
    expect(row['project_id']).toBe('proj-1');
    expect(row['agent_id']).toBe('agent-1');
    expect(row['category']).toBe('code');
    expect(JSON.parse(row['tags'] as string)).toEqual(['typescript', 'mcp']);
    // importance is adjusted by surprise score: min(0.9 + surprise*0.2, 1.0)
    // In a near-empty DB, surprise ≈ 1.0, so adjusted ≈ 1.0
    expect(row['importance']).toBeGreaterThanOrEqual(0.9);
    expect(JSON.parse(row['metadata'] as string)).toEqual({ key: 'value' });
    expect(row['expires_at']).toBe('2030-01-01T00:00:00Z');
  });

  it('merges tags on exact dedup match', async () => {
    await storeMemory(
      { content: 'tag merge test', tags: ['alpha', 'beta'] },
      deps,
    );
    await storeMemory(
      { content: 'tag merge test', tags: ['beta', 'gamma'] },
      deps,
    );

    const rows = deps.db
      .prepare('SELECT tags FROM memories WHERE is_deleted = 0')
      .all() as Array<{ tags: string }>;

    expect(rows.length).toBe(1);
    const tags = JSON.parse(rows[0]!.tags);
    expect(tags).toContain('alpha');
    expect(tags).toContain('beta');
    expect(tags).toContain('gamma');
  });

  it('bumps importance on exact dedup to max of both', async () => {
    await storeMemory(
      { content: 'importance test', importance: 0.3 },
      deps,
    );
    await storeMemory(
      { content: 'importance test', importance: 0.8 },
      deps,
    );

    const row = deps.db
      .prepare('SELECT importance FROM memories WHERE is_deleted = 0')
      .get() as { importance: number };
    expect(row.importance).toBe(0.8);
  });

  it('inserts into FTS on new memory', async () => {
    const result = await storeMemory(
      { content: 'fts indexed content', category: 'test', tags: ['fts'] },
      deps,
    );

    const ftsRow = deps.db
      .prepare(
        "SELECT * FROM memories_fts WHERE memories_fts MATCH '\"fts indexed content\"'",
      )
      .get() as Record<string, unknown> | undefined;

    expect(ftsRow).toBeDefined();
  });
});
