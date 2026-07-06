import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestDb, teardownTestDb, type TestContext } from '../helpers/index.js';
import { storeMemory, type StoreDeps } from '../../src/tools/store.js';
import { detectContradictions } from '../../src/cognitive/contradiction.js';
import type { VectorStore, VectorSearchResult } from '../../src/vectors/types.js';

/**
 * store-time dedup/contradiction namespace pushdown (v0.29 Fase 1B, Codex
 * [MEDIUM]).
 *
 * The vec search for dedup + contradiction ran without namespace pushdown and
 * filtered later. In a multi-namespace DB, other namespaces' near-duplicates
 * fill the global top-k, so the target namespace's real duplicate/contradiction
 * is never seen. The search must push the namespace into the vec query, as
 * searchMemory already does.
 */

/** Records the namespace argument passed to every vec `search`. */
function recordingVec(inner: VectorStore): { store: VectorStore; namespaces: Array<string | undefined> } {
  const namespaces: Array<string | undefined> = [];
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'search') {
        return (query: Float32Array, k: number, namespace?: string): VectorSearchResult[] => {
          namespaces.push(namespace);
          return inner.search(query, k, namespace);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as VectorStore;
  return { store, namespaces };
}

describe('storeMemory / detectContradictions — namespace pushdown', () => {
  let ctx: TestContext;

  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { teardownTestDb(ctx); });

  it('semantic-dedup vec search pushes the namespace down', async () => {
    const { store, namespaces } = recordingVec(ctx.vecStore);
    const deps: StoreDeps = {
      db: ctx.db, vecStore: store, embedder: ctx.embedder,
      logger: ctx.logger, metrics: ctx.metrics, config: ctx.config,
    };

    await storeMemory({ content: 'first fact in project alpha', namespace: 'alpha' }, deps);
    namespaces.length = 0; // reset before the call under test
    await storeMemory({ content: 'second distinct fact in project alpha', namespace: 'alpha' }, deps);

    // Every vec search performed during the store must be scoped to 'alpha',
    // never a global (undefined) search that other namespaces could dominate.
    expect(namespaces.length).toBeGreaterThan(0);
    expect(namespaces.every((ns) => ns === 'alpha')).toBe(true);
  });

  it('detectContradictions pushes the namespace down', async () => {
    const { store, namespaces } = recordingVec(ctx.vecStore);
    await storeMemory(
      { content: 'the port is 8080', namespace: 'beta' },
      { db: ctx.db, vecStore: ctx.vecStore, embedder: ctx.embedder, logger: ctx.logger, metrics: ctx.metrics, config: ctx.config },
    );
    namespaces.length = 0;
    await detectContradictions('the port is 9090', 'beta', ctx.db, store, ctx.embedder, 0.5);
    expect(namespaces.length).toBeGreaterThan(0);
    expect(namespaces.every((ns) => ns === 'beta')).toBe(true);
  });
});
