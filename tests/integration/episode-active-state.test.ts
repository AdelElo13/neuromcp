import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { startEpisode, endEpisode, ensureAmbientEpisode, getEpisode } from '../../src/tools/episode.js';
import {
  setActiveStateDir,
  readActive,
  activeEpisodeForNamespace,
} from '../../src/episode/active-state.js';

/**
 * Bug #7 regression suite (v0.21.0): start_episode must mark itself as
 * the active per-process episode so subsequent store_memory calls
 * without explicit episode_id attach to it instead of to ambient.
 *
 * The store-pipeline integration is tested at the registration layer
 * (registerCoreTools); here we verify the lower-level state machine
 * + the resolution helper used by that hook (activeEpisodeForNamespace).
 */
describe('episode active-state (Bug #7)', () => {
  let ctx: TestContext;
  let stateDir: string;

  beforeEach(() => {
    ctx = setupTestDb();
    stateDir = mkdtempSync(join(tmpdir(), 'neuromcp-active-state-'));
    setActiveStateDir(stateDir);
  });

  afterEach(() => {
    setActiveStateDir(null);
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
    teardownTestDb(ctx);
  });

  it('startEpisode writes the active-episode marker', () => {
    const ep = startEpisode(ctx.db, { title: 'test-active' }, 'default');

    const active = readActive();
    expect(active).not.toBeNull();
    expect(active!.episode_id).toBe(ep.id);
    expect(active!.namespace).toBe('default');
    expect(active!.pid).toBe(process.pid);
  });

  it('activeEpisodeForNamespace returns id when namespace matches', () => {
    const ep = startEpisode(ctx.db, { title: 'X', namespace: 'ns-A' }, 'default');

    expect(activeEpisodeForNamespace('ns-A')).toBe(ep.id);
  });

  it('activeEpisodeForNamespace returns null on namespace mismatch', () => {
    startEpisode(ctx.db, { title: 'X', namespace: 'ns-A' }, 'default');

    expect(activeEpisodeForNamespace('ns-B')).toBeNull();
  });

  it('endEpisode clears the active marker when ending the active id', () => {
    const ep = startEpisode(ctx.db, { title: 'to-end' }, 'default');
    expect(activeEpisodeForNamespace('default')).toBe(ep.id);

    endEpisode(ctx.db, { episode_id: ep.id, summary: 'done' });

    expect(activeEpisodeForNamespace('default')).toBeNull();
  });

  it('endEpisode does NOT clear the marker if a different episode is ended', () => {
    const epA = startEpisode(ctx.db, { title: 'A' }, 'default');
    // Pretend epB was started elsewhere — DB record only, no marker
    // overwrite. We end epB and expect epA's marker to survive.
    const epB = startEpisode(ctx.db, { title: 'B' }, 'default'); // overwrites marker to epB
    endEpisode(ctx.db, { episode_id: epA.id, summary: 'a-done' });

    // Marker still points at epB (most recently started)
    expect(activeEpisodeForNamespace('default')).toBe(epB.id);
  });

  it('start_episode then ensureAmbientEpisode chooses the active id via the resolver, not ambient', () => {
    // This mirrors the registration-layer hook order: prefer active over ambient.
    const ep = startEpisode(ctx.db, { title: 'should-attach-here' }, 'default');

    const activeId = activeEpisodeForNamespace('default');
    const fallback = activeId ?? ensureAmbientEpisode(ctx.db, 'default');

    expect(fallback).toBe(ep.id);

    // Sanity: an unrelated ambient call would yield a different id
    const ambientId = ensureAmbientEpisode(ctx.db, 'default');
    expect(ambientId).not.toBe(ep.id);
  });

  it('starting a new episode overwrites the previous active marker', () => {
    const epA = startEpisode(ctx.db, { title: 'A' }, 'default');
    expect(readActive()!.episode_id).toBe(epA.id);

    const epB = startEpisode(ctx.db, { title: 'B' }, 'default');
    expect(readActive()!.episode_id).toBe(epB.id);
    expect(epA.id).not.toBe(epB.id);
  });

  it('memory_count of started episode is 1 when one memory is attached via active resolution', () => {
    // Full-loop assertion the user asked for in the bug brief:
    //   start_episode({title:"X"}) → store without episode_id →
    //   get_episode(X.id).memory_count === 1
    const ep = startEpisode(ctx.db, { title: 'X' }, 'default');

    // Resolve like the store-pipeline does
    const resolvedId = activeEpisodeForNamespace('default') ?? ensureAmbientEpisode(ctx.db, 'default');
    expect(resolvedId).toBe(ep.id);

    // Insert a memory directly with that episode_id (simulating store)
    const memId = 'mem-bug7-1';
    ctx.db.prepare(
      `INSERT INTO memories (
        id, content_hash, content, summary, embedding_model, embedding_dim,
        namespace, project_id, agent_id, source, source_trust, visibility,
        schema_version, category, tags, importance, access_count,
        created_at, updated_at, last_accessed_at, expires_at,
        is_deleted, tombstoned_at, supersedes_id, superseded_by_id, metadata,
        episode_id
      ) VALUES (
        ?, ?, ?, NULL, 'fake', 384,
        'default', NULL, NULL, 'auto', 'medium', 'namespace', 1, 'general', '[]', 0.5, 0,
        ?, ?, NULL, NULL, 0, NULL, NULL, NULL, '{}',
        ?
      )`,
    ).run(memId, 'hash-bug7-1', 'content for bug 7', new Date().toISOString(), new Date().toISOString(), resolvedId);

    const stats = getEpisode(ctx.db, ep.id);
    expect(stats).not.toBeNull();
    expect(stats!.memory_count).toBe(1);
  });
});
