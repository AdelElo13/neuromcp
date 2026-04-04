import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, insertTestMemory } from '../helpers/index.js';
import type { TestContext } from '../helpers/index.js';
import { findExpired } from '../../src/consolidation/sweep.js';

describe('findExpired', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestDb();
  });

  afterEach(() => {
    teardownTestDb(ctx);
  });

  it('finds memories past expires_at', () => {
    const pastDate = new Date(Date.now() - 86_400_000).toISOString();
    const id = insertTestMemory(ctx, {
      content: 'expired',
      expires_at: pastDate,
    });

    const expired = findExpired(ctx.db, 'default');

    expect(expired.length).toBe(1);
    expect(expired[0]!.id).toBe(id);
    expect(expired[0]!.expired_at).toBe(pastDate);
  });

  it('does not include memories without expires_at', () => {
    insertTestMemory(ctx, { content: 'no expiry', expires_at: null });

    const expired = findExpired(ctx.db, 'default');

    expect(expired.length).toBe(0);
  });

  it('does not include memories with future expires_at', () => {
    const futureDate = new Date(Date.now() + 86_400_000).toISOString();
    insertTestMemory(ctx, { content: 'not yet', expires_at: futureDate });

    const expired = findExpired(ctx.db, 'default');

    expect(expired.length).toBe(0);
  });

  it('does not include already deleted memories', () => {
    const pastDate = new Date(Date.now() - 86_400_000).toISOString();
    insertTestMemory(ctx, {
      content: 'already dead',
      expires_at: pastDate,
      is_deleted: 1,
    });

    const expired = findExpired(ctx.db, 'default');

    expect(expired.length).toBe(0);
  });

  it('respects namespace filter', () => {
    const pastDate = new Date(Date.now() - 86_400_000).toISOString();
    insertTestMemory(ctx, {
      content: 'ns-a expired',
      namespace: 'ns-a',
      expires_at: pastDate,
    });
    insertTestMemory(ctx, {
      content: 'ns-b expired',
      namespace: 'ns-b',
      expires_at: pastDate,
    });

    const expired = findExpired(ctx.db, 'ns-a');

    expect(expired.length).toBe(1);
  });

  it('returns all namespaces with wildcard', () => {
    const pastDate = new Date(Date.now() - 86_400_000).toISOString();
    insertTestMemory(ctx, {
      namespace: 'ns-a',
      expires_at: pastDate,
    });
    insertTestMemory(ctx, {
      namespace: 'ns-b',
      expires_at: pastDate,
    });

    const expired = findExpired(ctx.db, '*');

    expect(expired.length).toBe(2);
  });
});
