import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { NeuromcpConfig } from '../config.js';
import type { Memory, MemoryWithScore, TrustLevel } from '../types.js';
import { namespaceFilter } from '../governance/namespace.js';
import { meetsMinTrust } from '../governance/trust.js';
import { computePrimingBoosts, getRecentlyAccessed } from '../cognitive/priming.js';
import { mmrRerank } from '../cognitive/mmr.js';
import { searchEntities } from '../graph/entities.js';
import { findConnectedMemories } from '../graph/traverse.js';

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
  // Phase 3: Temporal query
  readonly valid_at?: string;
  readonly graph_boost?: boolean;
  readonly episode_id?: string;
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
  return '"' + query.replace(/"/g, '""') + '"';
}

export async function searchMemory(
  input: SearchInput,
  deps: SearchDeps,
): Promise<readonly MemoryWithScore[]> {
  const { db, vecStore, embedder, logger, metrics, config } = deps;
  const start = Date.now();

  const limit = input.limit ?? 10;
  const hybrid = input.hybrid !== false;
  const namespace = input.namespace ?? config.defaultNamespace;
  const minTrust = input.min_trust ?? 'low';
  const graphBoost = input.graph_boost !== false;

  // Step 1: Generate query embedding
  const embedding = await embedder.embed(input.query);

  // Step 2: Vector search — over-fetch for post-filtering
  const vecResults = vecStore.search(embedding, limit * 3);

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
      logger.warn('search', 'FTS5 query failed, falling back to vector-only', {
        query: input.query,
      });
    }
  }

  // Step 4: Graph boost — find memories connected via knowledge graph
  let graphScores = new Map<string, number>();
  if (graphBoost) {
    try {
      const queryEntities = searchEntities(db, input.query, namespace, 5);
      if (queryEntities.length > 0) {
        const entityIds = queryEntities.map((e) => e.id);
        graphScores = findConnectedMemories(db, entityIds, 1);
        metrics.record('search.graph_boost_entities', queryEntities.length);
      }
    } catch {
      logger.warn('search', 'Graph boost failed, proceeding without');
    }
  }

  // Step 5: Priming boost — recently accessed memories boost related ones
  let primingScores = new Map<string, number>();
  try {
    const recentIds = getRecentlyAccessed(db, 30, 10);
    if (recentIds.length > 0) {
      primingScores = computePrimingBoosts(db, recentIds, config.primingBoost);
    }
  } catch {
    logger.warn('search', 'Priming boost failed, proceeding without');
  }

  // Step 6: Merge with RRF scoring + graph boost + priming
  const allIds = new Set([...vecRanks.keys(), ...ftsRanks.keys(), ...graphScores.keys()]);
  const scored: Array<{ id: string; score: number }> = [];

  for (const id of allIds) {
    const vecRank = vecRanks.get(id);
    const ftsRank = ftsRanks.get(id);
    const graphScore = graphScores.get(id) ?? 0;
    const primingScore = primingScores.get(id) ?? 0;

    let score = 0;
    if (vecRank !== undefined) {
      score += 1 / (RRF_K + vecRank);
    }
    if (ftsRank !== undefined) {
      score += 1 / (RRF_K + ftsRank);
    }
    // Graph boost: add scaled graph connectivity score
    score += graphScore * 0.005;
    // Priming: add priming activation
    score += primingScore * 0.003;

    scored.push({ id, score });
  }

  scored.sort((a, b) => b.score - a.score);

  // Step 7: Fetch full rows, apply post-filters
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

    // Trust filter
    if (!meetsMinTrust(memory.source_trust as TrustLevel, minTrust)) {
      continue;
    }

    // Category filter
    if (input.category !== undefined && memory.category !== input.category) {
      continue;
    }

    // Tags filter
    if (input.tags !== undefined && input.tags.length > 0) {
      const memTags: string[] = JSON.parse(memory.tags);
      const hasAll = input.tags.every((t) => memTags.includes(t));
      if (!hasAll) continue;
    }

    // Importance filter
    if (input.min_importance !== undefined && memory.importance < input.min_importance) {
      continue;
    }

    // Date range filters
    if (input.after !== undefined && memory.created_at < input.after) {
      continue;
    }
    if (input.before !== undefined && memory.created_at > input.before) {
      continue;
    }

    // Temporal validity filter (Phase 3)
    // If valid_at is specified, only return memories that were valid at that time
    if (input.valid_at !== undefined) {
      const validFrom = memory.valid_from;
      const validTo = memory.valid_to;

      // Memory must have started validity before or at valid_at
      if (validFrom !== null && validFrom > input.valid_at) continue;
      // Memory must not have ended validity before valid_at
      if (validTo !== null && validTo <= input.valid_at) continue;
    }

    // Episode filter
    if (input.episode_id !== undefined && memory.episode_id !== input.episode_id) {
      continue;
    }

    results.push({ ...memory, similarity_score: candidate.score });
  }

  // Step 9: MMR re-ranking for diversity
  const mmrResults = mmrRerank(results, config.mmrLambda, limit);
  const finalResults = [...mmrResults];

  // Step 10: Bump access counts in a transaction
  if (finalResults.length > 0) {
    const bumpStmt = db.prepare(
      "UPDATE memories SET access_count = access_count + 1, last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    );
    const bumpAll = db.transaction(() => {
      for (const r of finalResults) {
        bumpStmt.run(r.id);
      }
    });
    bumpAll();
  }

  logger.info('search', 'search complete', {
    query: input.query,
    results: finalResults.length,
    preMMR: results.length,
    hybrid,
    graphBoost: graphScores.size > 0,
    primingBoost: primingScores.size > 0,
    namespace,
  });
  metrics.increment('search.queries');
  metrics.record('search.results', finalResults.length);
  metrics.record('search.duration_ms', Date.now() - start);

  return finalResults;
}
