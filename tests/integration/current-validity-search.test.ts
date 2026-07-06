import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory } from '../helpers/index.js';
import type { TestContext } from '../helpers/index.js';
import { searchMemory } from '../../src/tools/search.js';

/**
 * Current-validity invariant (v0.29) — searchMemory (hybrid vector + FTS).
 *
 * The critical case is candidate starvation: superseded rows sit near the top
 * of the vec/FTS candidate list and, without filtering IN the candidate SQL,
 * consume the candidateK budget before the current row is ever fetched.
 */

const PAST = '2000-01-01T00:00:00.000Z';

describe('searchMemory — current-validity invariant', () => {
  let ctx: TestContext;
  let deps: {
    db: TestContext['db'];
    vecStore: TestContext['vecStore'];
    embedder: TestContext['embedder'];
    logger: TestContext['logger'];
    metrics: TestContext['metrics'];
    config: TestContext['config'];
  };

  beforeEach(() => {
    ctx = setupTestDb();
    deps = {
      db: ctx.db,
      vecStore: ctx.vecStore,
      embedder: ctx.embedder,
      logger: ctx.logger,
      metrics: ctx.metrics,
      config: ctx.config,
    };
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  // Seed a memory with a STABLE id and fully populate vec + FTS so it is a
  // real hybrid-search candidate. storeMemory generates its own id, so we
  // insert the row directly (stable id, FK-safe) and mirror the vec/FTS
  // writes storeMemory would do.
  async function seed(id: string, content: string): Promise<string> {
    insertTestMemory(ctx, { id, content, namespace: 'default', category: 'code' });
    const embedding = await ctx.embedder.embed(content);
    ctx.vecStore.upsert(id, embedding);
    const row = ctx.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
    ctx.db
      .prepare('INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, ?, ?)')
      .run(row.rowid, content, '[]', 'code');
    return id;
  }

  it('hides a superseded row from default search but keeps the current one', async () => {
    await seed('old', 'deployment uses docker compose v1 syntax');
    await seed('new', 'deployment uses docker compose v2 syntax');
    ctx.db.prepare('UPDATE memories SET superseded_by_id = ? WHERE id = ?').run('new', 'old');

    const results = await searchMemory({ query: 'deployment docker compose syntax', limit: 10 }, deps);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('new');
    expect(ids).not.toContain('old');
  });

  it('hides a window-closed (valid_to past) row by default', async () => {
    await seed('expired', 'the api key rotates every 30 days');
    await seed('live', 'the api key rotates every 90 days');
    ctx.db.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run(PAST, 'expired');

    const results = await searchMemory({ query: 'api key rotation schedule', limit: 10 }, deps);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('live');
    expect(ids).not.toContain('expired');
  });

  it('valid_at returns the historical (superseded) row', async () => {
    await seed('old', 'server runs on port 8080');
    await seed('new', 'server runs on port 9090');
    // old was valid [2026-01-01, 2026-06-01), superseded by new at 2026-06-01
    ctx.db
      .prepare('UPDATE memories SET superseded_by_id = ?, valid_from = ?, valid_to = ? WHERE id = ?')
      .run('new', '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 'old');
    ctx.db.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run('2026-06-01T00:00:00.000Z', 'new');

    const historical = await searchMemory(
      { query: 'server port', limit: 10, valid_at: '2026-03-01T00:00:00.000Z' },
      deps,
    );
    expect(historical.map((r) => r.id)).toContain('old');
  });

  it('include_superseded returns the superseded row', async () => {
    await seed('old', 'library version is 1.0');
    await seed('new', 'library version is 2.0');
    ctx.db.prepare('UPDATE memories SET superseded_by_id = ? WHERE id = ?').run('new', 'old');

    const results = await searchMemory(
      { query: 'library version', limit: 10, include_superseded: true },
      deps,
    );
    expect(results.map((r) => r.id)).toContain('old');
  });

  it('candidate starvation: many superseded near-duplicates do not push the current row out of top-k', async () => {
    // 30 superseded near-duplicates that all match the query strongly, plus one
    // current row. With a limit of 5, the current row must still surface — the
    // filter has to run IN the candidate SQL, not only post-fetch.
    for (let i = 0; i < 30; i++) {
      const id = `sup-${i}`;
      await seed(id, `the production database host is db-old-${i}.example.com primary`);
      ctx.db.prepare('UPDATE memories SET superseded_by_id = ? WHERE id = ?').run('current-db', id);
    }
    await seed('current-db', 'the production database host is db-new.example.com primary');

    const results = await searchMemory(
      { query: 'production database host primary', limit: 5 },
      deps,
    );
    const ids = results.map((r) => r.id);
    expect(ids).toContain('current-db');
    for (const r of results) {
      expect(r.id.startsWith('sup-')).toBe(false);
    }
  });

  it('coexisting current rows both remain visible', async () => {
    await seed('a', 'user prefers dark mode in the editor');
    await seed('b', 'user prefers dark mode in the terminal');

    const results = await searchMemory({ query: 'user prefers dark mode', limit: 10 }, deps);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });
});
