import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { startEpisode, endEpisode, listEpisodes, getEpisode } from '../../src/tools/episode.js';

describe('episodes', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('starts an episode', () => {
    const ep = startEpisode(ctx.db, { title: 'Test session' }, 'default');
    expect(ep.id).toBeDefined();
    expect(ep.title).toBe('Test session');
    expect(ep.ended_at).toBeNull();
  });

  it('ends an episode with auto-summary', () => {
    const ep = startEpisode(ctx.db, { title: 'Deploy' }, 'default');
    // Add memories to the episode
    ctx.db.prepare('UPDATE memories SET episode_id = ? WHERE id = ?').run(
      ep.id,
      insertTestMemory(ctx, { content: 'Deployed agentproofs-io with dark theme' }),
    );

    const result = endEpisode(ctx.db, { episode_id: ep.id });
    expect(result.ended_at).toBeDefined();
    expect(result.memory_count).toBe(1);
    expect(result.summary).toContain('Deployed');
  });

  it('throws when ending already-ended episode', () => {
    const ep = startEpisode(ctx.db, { title: 'Test' }, 'default');
    endEpisode(ctx.db, { episode_id: ep.id });
    expect(() => endEpisode(ctx.db, { episode_id: ep.id })).toThrow('already ended');
  });

  it('lists episodes with memory counts', () => {
    startEpisode(ctx.db, { title: 'Ep 1' }, 'default');
    startEpisode(ctx.db, { title: 'Ep 2' }, 'default');

    const list = listEpisodes(ctx.db, {}, 'default');
    expect(list).toHaveLength(2);
  });

  it('lists only active episodes', () => {
    const ep = startEpisode(ctx.db, { title: 'Done' }, 'default');
    endEpisode(ctx.db, { episode_id: ep.id });
    startEpisode(ctx.db, { title: 'Active' }, 'default');

    const active = listEpisodes(ctx.db, { active_only: true }, 'default');
    expect(active).toHaveLength(1);
    expect(active[0]!.title).toBe('Active');
  });

  it('gets episode by id', () => {
    const ep = startEpisode(ctx.db, { title: 'Find me' }, 'default');
    const found = getEpisode(ctx.db, ep.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Find me');
  });
});
