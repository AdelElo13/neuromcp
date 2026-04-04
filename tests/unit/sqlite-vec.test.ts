import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteVecStore } from '../../src/vectors/sqlite-vec.js';

const DIMS = 384;

function randomVec(dims: number): Float32Array {
  const vec = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    vec[i] = Math.random() * 2 - 1;
  }
  return vec;
}

function filledVec(dims: number, value: number): Float32Array {
  const vec = new Float32Array(dims);
  vec.fill(value);
  return vec;
}

describe('SqliteVecStore', () => {
  let db: Database.Database;
  let store: SqliteVecStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteVecStore(DIMS);
    store.initialize(db);
  });

  afterEach(() => {
    db.close();
  });

  it('starts with count 0', () => {
    expect(store.count()).toBe(0);
  });

  it('upsert and count', () => {
    store.upsert('a', randomVec(DIMS));
    expect(store.count()).toBe(1);

    store.upsert('b', randomVec(DIMS));
    expect(store.count()).toBe(2);
  });

  it('upsert overwrites existing entry', () => {
    store.upsert('a', randomVec(DIMS));
    store.upsert('a', randomVec(DIMS));
    expect(store.count()).toBe(1);
  });

  it('search returns nearest neighbors', () => {
    const target = filledVec(DIMS, 1.0);
    const far = filledVec(DIMS, -1.0);
    const medium = randomVec(DIMS);

    store.upsert('target', target);
    store.upsert('far', far);
    store.upsert('medium', medium);

    const results = store.search(target, 3);

    expect(results.length).toBe(3);
    // The first result should be the target itself (distance 0 or near 0)
    expect(results[0].id).toBe('target');
    expect(results[0].distance).toBeCloseTo(0, 1);
    // The far vector should be last (greatest distance)
    expect(results[results.length - 1].id).toBe('far');
  });

  it('search respects k limit', () => {
    store.upsert('a', randomVec(DIMS));
    store.upsert('b', randomVec(DIMS));
    store.upsert('c', randomVec(DIMS));

    const results = store.search(randomVec(DIMS), 2);
    expect(results.length).toBe(2);
  });

  it('remove deletes a vector', () => {
    store.upsert('a', randomVec(DIMS));
    store.upsert('b', randomVec(DIMS));
    expect(store.count()).toBe(2);

    store.remove('a');
    expect(store.count()).toBe(1);

    // Search should not return removed vector
    const results = store.search(randomVec(DIMS), 10);
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain('a');
    expect(ids).toContain('b');
  });

  it('clear removes all vectors', () => {
    store.upsert('a', randomVec(DIMS));
    store.upsert('b', randomVec(DIMS));
    store.upsert('c', randomVec(DIMS));
    expect(store.count()).toBe(3);

    store.clear();
    expect(store.count()).toBe(0);
  });

  it('upsertBatch inserts multiple vectors', () => {
    const entries = [
      { id: 'x', embedding: randomVec(DIMS) },
      { id: 'y', embedding: randomVec(DIMS) },
      { id: 'z', embedding: randomVec(DIMS) },
    ];

    store.upsertBatch(entries);
    expect(store.count()).toBe(3);
  });

  it('upsertBatch overwrites existing entries', () => {
    store.upsert('x', randomVec(DIMS));

    const entries = [
      { id: 'x', embedding: randomVec(DIMS) },
      { id: 'y', embedding: randomVec(DIMS) },
    ];

    store.upsertBatch(entries);
    expect(store.count()).toBe(2);
  });

  it('throws when not initialized', () => {
    const uninitStore = new SqliteVecStore(DIMS);
    expect(() => uninitStore.count()).toThrow('not initialized');
  });
});
