import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { storeVerbatim, searchVerbatim, verbatimStats } from '../../src/tools/verbatim.js';

describe('verbatim', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestDb();
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  describe('storeVerbatim', () => {
    it('stores raw text and returns id', () => {
      const result = storeVerbatim(
        { content: 'User said hello world' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );

      expect(result.id).toBeDefined();
      expect(result.deduplicated).toBe(false);

      const row = ctx.db.prepare('SELECT * FROM verbatim WHERE id = ?').get(result.id) as { content: string };
      expect(row.content).toBe('User said hello world');
    });

    it('deduplicates by content hash', () => {
      const r1 = storeVerbatim(
        { content: 'same text' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );
      const r2 = storeVerbatim(
        { content: 'same text' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );

      expect(r2.id).toBe(r1.id);
      expect(r2.deduplicated).toBe(true);
    });

    it('stores with episode and agent association', () => {
      // Create an episode first
      ctx.db.prepare("INSERT INTO episodes (id, title, namespace) VALUES ('ep1', 'test episode', 'default')").run();

      const result = storeVerbatim(
        { content: 'conversation chunk', agent_id: 'agent-1', episode_id: 'ep1' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );

      const row = ctx.db.prepare('SELECT agent_id, episode_id FROM verbatim WHERE id = ?').get(result.id) as {
        agent_id: string; episode_id: string;
      };
      expect(row.agent_id).toBe('agent-1');
      expect(row.episode_id).toBe('ep1');
    });

    it('stores metadata as JSON', () => {
      const result = storeVerbatim(
        { content: 'with meta', metadata: { role: 'user', turn: 3 } },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );

      const row = ctx.db.prepare('SELECT metadata FROM verbatim WHERE id = ?').get(result.id) as { metadata: string };
      expect(JSON.parse(row.metadata)).toEqual({ role: 'user', turn: 3 });
    });
  });

  describe('searchVerbatim', () => {
    it('finds text via FTS', () => {
      storeVerbatim(
        { content: 'The quick brown fox jumps over the lazy dog' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );
      storeVerbatim(
        { content: 'A different sentence about cats' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );

      const results = searchVerbatim(
        { query: 'quick brown fox' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.content).toContain('quick brown fox');
      expect(results[0]!.source).toBe('verbatim');
    });

    it('filters by namespace', () => {
      storeVerbatim(
        { content: 'hello from project A', namespace: 'projA' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );
      storeVerbatim(
        { content: 'hello from project B', namespace: 'projB' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );

      const results = searchVerbatim(
        { query: 'hello', namespace: 'projA' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );

      expect(results.length).toBe(1);
      expect(results[0]!.namespace).toBe('projA');
    });

    it('filters by episode_id', () => {
      ctx.db.prepare("INSERT INTO episodes (id, title) VALUES ('ep1', 'test')").run();
      ctx.db.prepare("INSERT INTO episodes (id, title) VALUES ('ep2', 'test2')").run();

      storeVerbatim(
        { content: 'episode one talk', episode_id: 'ep1' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );
      storeVerbatim(
        { content: 'episode two talk', episode_id: 'ep2' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );

      const results = searchVerbatim(
        { query: 'talk', episode_id: 'ep1' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );

      expect(results.length).toBe(1);
      expect(results[0]!.episode_id).toBe('ep1');
    });

    it('returns empty for no matches', () => {
      storeVerbatim(
        { content: 'something about databases' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );

      const results = searchVerbatim(
        { query: 'xyzzynonexistent' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );

      expect(results.length).toBe(0);
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        storeVerbatim(
          { content: `test entry number ${i} about coding` },
          ctx.db, ctx.config, ctx.logger, ctx.metrics,
        );
      }

      const results = searchVerbatim(
        { query: 'coding', limit: 3 },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );

      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  describe('verbatimStats', () => {
    it('returns correct counts', () => {
      storeVerbatim({ content: 'one' }, ctx.db, ctx.config, ctx.logger, ctx.metrics);
      storeVerbatim({ content: 'two' }, ctx.db, ctx.config, ctx.logger, ctx.metrics);
      storeVerbatim({ content: 'three', namespace: 'other' }, ctx.db, ctx.config, ctx.logger, ctx.metrics);

      const stats = verbatimStats(ctx.db, ctx.config, '*');
      expect(stats.total).toBe(3);
      expect(stats.by_namespace['default']).toBe(2);
      expect(stats.by_namespace['other']).toBe(1);
      expect(stats.total_size_bytes).toBeGreaterThan(0);
    });

    it('filters by namespace', () => {
      storeVerbatim({ content: 'ns1 entry' }, ctx.db, ctx.config, ctx.logger, ctx.metrics);
      storeVerbatim({ content: 'ns2 entry', namespace: 'other' }, ctx.db, ctx.config, ctx.logger, ctx.metrics);

      const stats = verbatimStats(ctx.db, ctx.config, 'default');
      expect(stats.total).toBe(1);
    });
  });

  describe('isolation from consolidation', () => {
    it('verbatim entries are not in memories table', () => {
      storeVerbatim(
        { content: 'this should only be in verbatim table' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );

      const memoryCount = (ctx.db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
      const verbatimCount = (ctx.db.prepare('SELECT COUNT(*) as c FROM verbatim').get() as { c: number }).c;

      expect(memoryCount).toBe(0);
      expect(verbatimCount).toBe(1);
    });
  });
});
