import type Database from 'better-sqlite3';

export interface VectorSearchResult {
  readonly id: string;
  readonly distance: number;
}

export interface VectorStore {
  readonly name: string;
  readonly dimensions: number;
  initialize(db: Database.Database): void;
  upsert(id: string, embedding: Float32Array): void;
  upsertBatch(entries: ReadonlyArray<{ readonly id: string; readonly embedding: Float32Array }>): void;
  /**
   * KNN search, optionally filtered by namespace.
   *
   * Caveats (sprint1):
   *  - May return FEWER than `k` results when `namespace` is given. The
   *    namespace filter is applied after a 10× over-fetch (capped at 4000
   *    by sqlite-vec's hard k-limit), so a tenant occupying < 1/10 of the
   *    index can be silently under-served. Callers that need exact `k`
   *    must compensate (re-query with larger k, or relax the filter).
   *  - `k` must be a positive integer; non-positive values throw.
   */
  search(query: Float32Array, k: number, namespace?: string): VectorSearchResult[];
  remove(id: string): void;
  clear(): void;
  count(): number;
}
