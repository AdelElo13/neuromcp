import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { NeuromcpConfig } from '../config.js';
import type { Memory, MemoryWithScore, TrustLevel } from '../types.js';
import { namespaceFilter } from '../governance/namespace.js';
import { meetsMinTrust } from '../governance/trust.js';

export interface SearchInput {
  readonly query: string;
  readonly namespace?: string;
  readonly limit?: number;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly min_importance?: number;
  readonly min_trust?: TrustLevel;
  readonly after?: string;
  readonly before?: string;
  readonly hybrid?: boolean;
}

export interface SearchDeps {
  readonly db: Database.Database;
  readonly vecStore: VectorStore;
  readonly embedder: EmbeddingProvider;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly config: NeuromcpConfig;
}

const RRF_K = 60;

function sanitizeFtsQuery(query: string): string {
  // Wrap in double quotes for phrase matching, escaping internal quotes
  return '"' + query.replace(/"/g, '""') + '"';
}

export async function searchMemory(
  input: SearchInput,
  deps: SearchDeps,
): Promise<readonly MemoryWithScore[]> {
  const { db, vecStore, embedder, logger, metrics, config } = deps;
  const start = Date.now();

  const limit = input.limit ?? 10;
  const hybrid = input.hybrid !== false; // default true
  const namespace = input.namespace ?? config.defaultNamespace;
  const minTrust = input.min_trust ?? 'low';

  // Step 1: Generate query embedding
  const embedding = await embedder.embed(input.query);

  // Step 2: Vector search — over-fetch for post-filtering
  const vecResults = vecStore.search(embedding, limit * 3);

  // Build vector rank map (id -> rank, 1-indexed)
  const vecRanks = new Map<string, number>();
  vecResults.forEach((r, i) => {
    vecRanks.set(r.id, i + 1);
  });

  // Step 3: FTS search (best-effort)
  const ftsRanks = new Map<string, number>();
  if (hybrid) {
    try {
      const ftsQuery = sanitizeFtsQuery(input.query);
      const ftsRows = db
        .prepare(
          `SELECT m.id FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ? AND m.is_deleted = 0
           ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuery, limit * 3) as Array<{ id: string }>;

      ftsRows.forEach((row, i) => {
        ftsRanks.set(row.id, i + 1);
      });
    } catch {
      // FTS5 is best-effort; if query fails, proceed with vector-only
      logger.warn('search', 'FTS5 query failed, falling back to vector-only', {
        query: input.query,
      });
    }
  }

  // Step 4: Merge with RRF scoring
  const allIds = new Set([...vecRanks.keys(), ...ftsRanks.keys()]);
  const scored: Array<{ id: string; score: number }> = [];

  for (const id of allIds) {
    const vecRank = vecRanks.get(id);
    const ftsRank = ftsRanks.get(id);
    let score = 0;
    if (vecRank !== undefined) {
      score += 1 / (RRF_K + vecRank);
    }
    if (ftsRank !== undefined) {
      score += 1 / (RRF_K + ftsRank);
    }
    scored.push({ id, score });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Step 5: Fetch full rows, apply post-filters
  const nsFilter = namespaceFilter(input.namespace, config.defaultNamespace);
  const results: MemoryWithScore[] = [];

  for (const candidate of scored) {
    if (results.length >= limit) break;

    const memory = db
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(candidate.id) as Memory | undefined;

    if (memory === undefined) continue;
    if (memory.is_deleted === 1) continue;

    // Namespace filter
    if (nsFilter.params.length > 0 && memory.namespace !== nsFilter.params[0]) {
      continue;
    }

    // Trust filter — exclude unverified unless explicitly requested
    if (!meetsMinTrust(memory.source_trust as TrustLevel, minTrust)) {
      continue;
    }

    // Category filter
    if (input.category !== undefined && memory.category !== input.category) {
      continue;
    }

    // Tags filter — all requested tags must be present
    if (input.tags !== undefined && input.tags.length > 0) {
      const memTags: string[] = JSON.parse(memory.tags);
      const hasAll = input.tags.every((t) => memTags.includes(t));
      if (!hasAll) continue;
    }

    // Importance filter
    if (
      input.min_importance !== undefined &&
      memory.importance < input.min_importance
    ) {
      continue;
    }

    // Date range filters
    if (input.after !== undefined && memory.created_at < input.after) {
      continue;
    }
    if (input.before !== undefined && memory.created_at > input.before) {
      continue;
    }

    results.push({ ...memory, similarity_score: candidate.score });
  }

  // Step 6: Bump access counts in a transaction
  if (results.length > 0) {
    const bumpStmt = db.prepare(
      "UPDATE memories SET access_count = access_count + 1, last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    );
    const bumpAll = db.transaction(() => {
      for (const r of results) {
        bumpStmt.run(r.id);
      }
    });
    bumpAll();
  }

  logger.info('search', 'search complete', {
    query: input.query,
    results: results.length,
    hybrid,
    namespace,
  });
  metrics.increment('search.queries');
  metrics.record('search.results', results.length);
  metrics.record('search.duration_ms', Date.now() - start);

  return results;
}
