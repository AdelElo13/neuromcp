import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory } from '../helpers/index.js';
import type { TestContext } from '../helpers/index.js';
import { recallAnswer } from '../../src/tools/recall-answer.js';

describe('recallAnswer — current-validity invariant', () => {
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

  async function seed(id: string, content: string): Promise<void> {
    insertTestMemory(ctx, { id, content, namespace: 'default', category: 'code' });
    const e = await ctx.embedder.embed(content);
    ctx.vecStore.upsert(id, e);
    const row = ctx.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
    ctx.db
      .prepare('INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, ?, ?)')
      .run(row.rowid, content, '[]', 'code');
  }

  // relevanceFloor:0 disables the synthesis gate so `sources` reflects exactly
  // what retrieval returned — that is where the include_superseded contract
  // lives (recall_answer forwards it to searchMemory).
  it('does not consider a superseded memory by default', async () => {
    await seed('old', 'the database password is oldsecret12345');
    await seed('new', 'the database password is newsecret67890');
    ctx.db.prepare('UPDATE memories SET superseded_by_id = ? WHERE id = ?').run('new', 'old');

    const result = await recallAnswer({ query: 'database password' }, deps, { relevanceFloor: 0 });
    const sourceIds = result.sources.map((s) => s.id);
    expect(sourceIds).not.toContain('old');
  });

  it('include_superseded lets a superseded memory be considered', async () => {
    await seed('old', 'the database password is oldsecret12345');
    await seed('new', 'the database password is newsecret67890');
    ctx.db.prepare('UPDATE memories SET superseded_by_id = ? WHERE id = ?').run('new', 'old');

    const result = await recallAnswer(
      { query: 'database password', include_superseded: true },
      deps,
      { relevanceFloor: 0 },
    );
    const sourceIds = result.sources.map((s) => s.id);
    expect(sourceIds).toContain('old');
  });
});
