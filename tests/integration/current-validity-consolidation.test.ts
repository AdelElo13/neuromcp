import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { findDuplicates } from '../../src/consolidation/dedup.js';
import { findExpired, findStale } from '../../src/consolidation/sweep.js';
import { computeDecay } from '../../src/consolidation/decay.js';
import { searchMemory } from '../../src/tools/search.js';

/**
 * Consolidation must not slop live history (v0.29, Codex Task1 #2).
 *
 * Superseded rows are historical: keep them. They must be excluded from
 * dedup-merge and sweep/stale-prune candidate selection so valid_at recall
 * and the supersession chain stay intact.
 */

const PAST = '2000-01-01T00:00:00.000Z';
const OLD_CREATED = '2020-01-01T00:00:00.000Z';

describe('consolidation — preserves superseded history', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  async function seedVec(id: string, content: string, overrides: Record<string, unknown> = {}): Promise<void> {
    insertTestMemory(ctx, { id, content, namespace: 'default', ...overrides });
    const e = await ctx.embedder.embed(content);
    ctx.vecStore.upsert(id, e);
    const row = ctx.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
    ctx.db
      .prepare('INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, ?, ?)')
      .run(row.rowid, content, '[]', 'general');
  }

  it('findDuplicates never proposes merging a superseded row', async () => {
    // old superseded by new, near-identical content.
    await seedVec('old', 'the primary database is postgres 14 primary node', { superseded_by_id: 'new' });
    await seedVec('new', 'the primary database is postgres 16 primary node');

    const merges = findDuplicates(ctx.db, ctx.vecStore, 'default', 0.5);
    const touched = merges.flatMap((m) => [m.keep_id, m.tombstone_id]);
    expect(touched).not.toContain('old');
  });

  it('findExpired ignores a superseded row even if its expires_at passed', () => {
    insertTestMemory(ctx, {
      id: 'old', content: 'x', namespace: 'default', superseded_by_id: 'new', expires_at: PAST,
    });
    const expired = findExpired(ctx.db, 'default').map((e) => e.id);
    expect(expired).not.toContain('old');
  });

  it('findStale ignores a superseded row even if old and low-importance', () => {
    insertTestMemory(ctx, {
      id: 'old', content: 'x', namespace: 'default', superseded_by_id: 'new',
      importance: 0.1, created_at: OLD_CREATED, last_accessed_at: OLD_CREATED,
    });
    const stale = findStale(ctx.db, 'default', 90, 0.3).map((s) => s.id);
    expect(stale).not.toContain('old');
  });

  it('computeDecay does not propose pruning a superseded row', () => {
    insertTestMemory(ctx, {
      id: 'old', content: 'x', namespace: 'default', superseded_by_id: 'new',
      importance: 0.05, access_count: 0, source: 'auto', source_trust: 'low',
      created_at: OLD_CREATED, last_accessed_at: OLD_CREATED,
    });
    const { prunes } = computeDecay(ctx.db, 'default', 0.01, 0.2);
    expect(prunes.map((p) => p.id)).not.toContain('old');
  });

  it('a superseded row remains valid_at-queryable after consolidation candidate selection', async () => {
    await seedVec('old', 'server port was 8080 originally', {
      superseded_by_id: 'new',
      valid_from: '2026-01-01T00:00:00.000Z',
      valid_to: '2026-06-01T00:00:00.000Z',
    });
    await seedVec('new', 'server port is 9090 now', { valid_from: '2026-06-01T00:00:00.000Z' });

    // Consolidation selection must not have flagged 'old'.
    const merges = findDuplicates(ctx.db, ctx.vecStore, 'default', 0.5);
    expect(merges.flatMap((m) => [m.keep_id, m.tombstone_id])).not.toContain('old');

    // And valid_at recall still returns it.
    const historical = await searchMemory(
      { query: 'server port', valid_at: '2026-03-01T00:00:00.000Z', limit: 10 },
      { db: ctx.db, vecStore: ctx.vecStore, embedder: ctx.embedder, logger: ctx.logger, metrics: ctx.metrics, config: ctx.config },
    );
    expect(historical.map((r) => r.id)).toContain('old');
  });
});
