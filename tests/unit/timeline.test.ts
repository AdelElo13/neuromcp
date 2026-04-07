import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { memoryTimeline } from '../../src/tools/timeline.js';

describe('memoryTimeline', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('returns empty for no matches', () => {
    const result = memoryTimeline(ctx.db, { query: 'nonexistent' }, 'default');
    expect(result.entries).toHaveLength(0);
  });

  it('finds memories matching query', () => {
    insertTestMemory(ctx, { content: 'GoAmanah uses Next.js 16 for the frontend' });
    insertTestMemory(ctx, { content: 'DakDeel uses React for matching' });

    // Add to FTS
    const rows = ctx.db.prepare('SELECT id, rowid, content, category FROM memories').all() as Array<{ id: string; rowid: number; content: string; category: string }>;
    for (const row of rows) {
      try {
        ctx.db.prepare('INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, ?, ?)').run(row.rowid, row.content, '[]', row.category);
      } catch { /* skip if exists */ }
    }

    const result = memoryTimeline(ctx.db, { query: 'GoAmanah' }, 'default');
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('follows supersession chains', () => {
    const id1 = insertTestMemory(ctx, { content: 'neuromcp version is 0.3.0' });
    const id2 = insertTestMemory(ctx, { content: 'neuromcp version is 0.5.0' });
    ctx.db.prepare('UPDATE memories SET superseded_by_id = ? WHERE id = ?').run(id2, id1);
    ctx.db.prepare('UPDATE memories SET supersedes_id = ? WHERE id = ?').run(id1, id2);

    // Add to FTS
    const rows = ctx.db.prepare('SELECT id, rowid, content, category FROM memories').all() as Array<{ id: string; rowid: number; content: string; category: string }>;
    for (const row of rows) {
      try {
        ctx.db.prepare('INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, ?, ?)').run(row.rowid, row.content, '[]', row.category);
      } catch { /* skip */ }
    }

    const result = memoryTimeline(ctx.db, { query: 'neuromcp version' }, 'default');
    expect(result.entries.length).toBe(2);
    expect(result.total_revisions).toBeGreaterThan(0);
  });
});
