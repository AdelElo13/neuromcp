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
  search(query: Float32Array, k: number): VectorSearchResult[];
  remove(id: string): void;
  clear(): void;
  count(): number;
}
