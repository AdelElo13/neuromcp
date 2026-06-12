import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { NeuromcpConfig } from '../config.js';
import type { Memory, MemoryWithScore, TrustLevel } from '../types.js';
import type { MemoryWithExplanation } from '../cognitive/explain.js';
import { explainMemory } from '../cognitive/explain.js';
import { namespaceFilter } from '../governance/namespace.js';
import { meetsMinTrust } from '../governance/trust.js';
import { computePrimingBoosts, getRecentlyAccessed } from '../cognitive/priming.js';
import { computeAdaptiveImportance } from '../cognitive/importance.js';
import { computeAttentionScores, computeBlockAttentionScores, recordCoRetrieval } from '../cognitive/attention.js';
import { getUsefulnessCounts, sampleUsefulness } from './attribution.js';
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
  readonly explain?: boolean;
  // sprint4 reviewer-remediation: output verbosity was 14.8× too high
  // (37 fields per result, most of them DB internals). `compact` trims the
  // payload to the 7 fields an agent actually needs.
  readonly compact?: boolean;
}

/** The 7 fields a consuming agent typically needs. Reduces payload ~10×. */
export interface CompactMemory {
  readonly id: string;
  readonly content: string;
  readonly similarity_score: number;
  readonly category: string | null;
  readonly tags: string;
  readonly importance: number;
  readonly created_at: string;
}

/**
 * Strip a MemoryWithScore / MemoryWithExplanation down to the compact
 * projection. Keeps `explain` intact when present (it was explicitly
 * requested by the caller).
 */
export function toCompact(
  m: MemoryWithScore | MemoryWithExplanation,
): CompactMemory | (CompactMemory & { explain: unknown }) {
  const base: CompactMemory = {
    id: m.id,
    content: m.content,
    similarity_score: m.similarity_score,
    category: m.category ?? null,
    tags: m.tags,
    importance: m.importance,
    created_at: m.created_at,
  };
  if ('explain' in m) {
    return { ...base, explain: (m as { explain: unknown }).explain };
  }
  return base;
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

/**
 * FTS5 candidate lookup with namespace pushdown. Without the pushdown the
 * limit*3 candidate budget is consumed by other namespaces' rows (which the
 * post-filter then discards), starving the FTS leg in multi-tenant DBs —
 * the keyword-side twin of the vec-side recall collapse fixed in
 * sqlite-vec.ts. `namespace === undefined` (or '*' resolved by the caller)
 * searches all namespaces.
 */
export function ftsCandidates(
  db: Database.Database,
  ftsQuery: string,
  k: number,
  namespace?: string,
): Array<{ id: string }> {
  if (namespace === undefined) {
    return db
      .prepare(
        `SELECT m.id FROM memories_fts f
         JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? AND m.is_deleted = 0
         ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, k) as Array<{ id: string }>;
  }
  return db
    .prepare(
      `SELECT m.id FROM memories_fts f
       JOIN memories m ON m.rowid = f.rowid
       WHERE memories_fts MATCH ? AND m.is_deleted = 0 AND m.namespace = ?
       ORDER BY rank LIMIT ?`,
    )
    .all(ftsQuery, namespace, k) as Array<{ id: string }>;
}

export async function searchMemory(
  input: SearchInput,
  deps: SearchDeps,
): Promise<readonly (MemoryWithScore | MemoryWithExplanation)[]> {
  const { db, vecStore, embedder, logger, metrics, config } = deps;
  const start = Date.now();

  const limit = input.limit ?? 10;
  const hybrid = input.hybrid !== false;
  const namespace = input.namespace ?? config.defaultNamespace;
  const minTrust = input.min_trust ?? 'low';
  const graphBoost = input.graph_boost !== false;
  const explain = input.explain !== false; // default: true

  // '*' means "all namespaces": the vec store and FTS leg express that as
  // "no namespace filter" (undefined). Passing the literal '*' through would
  // hit `namespace = '*'` equality filters and silently return zero rows.
  const scopedNamespace = namespace === '*' ? undefined : namespace;

  // Step 1: Generate query embedding. When the embedder is down (Ollama not
  // running, network timeout) a hybrid search degrades LOUDLY to FTS-only
  // instead of failing the whole call — the user still gets keyword recall,
  // and the warn + metric make the degradation visible. Vector-only search
  // (hybrid=false) cannot degrade and keeps failing loudly.
  let embedding: Float32Array | null = null;
  try {
    embedding = await embedder.embed(input.query);
  } catch (err: unknown) {
    if (!hybrid) throw err;
    logger.warn('search', 'Embedder unavailable — DEGRADED to FTS-only results', {
      error: err instanceof Error ? err.message : String(err),
      query: input.query,
    });
    metrics.increment('search.degraded_fts_only');
  }

  // Step 2: Vector search — push namespace into the vec query so we don't
  // waste the top-k budget on other tenants' data (see sqlite-vec.ts for
  // the recall-collapse story).
  const vecResults = embedding !== null ? vecStore.search(embedding, limit * 3, scopedNamespace) : [];

  const vecRanks = new Map<string, number>();
  vecResults.forEach((r, i) => {
    vecRanks.set(r.id, i + 1);
  });

  // Step 3: FTS search (best-effort), namespace pushed down like the vec leg
  const ftsRanks = new Map<string, number>();
  if (hybrid) {
    try {
      const ftsQuery = sanitizeFtsQuery(input.query);
      const ftsRows = ftsCandidates(db, ftsQuery, limit * 3, scopedNamespace);

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

  // Step 6.5: Attention-based co-retrieval boost (AttnRes-inspired)
  try {
    const attentionScores = computeAttentionScores(db, scored, {
      attentionWeight: config.attentionWeight,
    });
    const blockScores = computeBlockAttentionScores(db, scored, {
      blockWeight: config.blockAttentionWeight,
    });
    for (const s of scored) {
      s.score += attentionScores.get(s.id) ?? 0;
      s.score += blockScores.get(s.id) ?? 0;
    }
    if (attentionScores.size > 0) {
      metrics.record('search.attention_boost_candidates', attentionScores.size);
    }
  } catch {
    logger.warn('search', 'Attention scoring failed, proceeding without');
  }

  // Step 6.6: Usefulness prior (v0.16.0) with gated Thompson-sampling
  // exploration (v0.17.1). Only sample from Beta(helpful+1, harmful+1) when
  // we have real observations (total >= EXPLORATION_THRESHOLD). Below that,
  // apply a neutral factor of 1.0 so unobserved memories are neither helped
  // nor hurt by randomness. This preserves MRR on fresh corpora while still
  // breaking rich-get-richer once critic signal starts accumulating.
  //
  // v0.17.0 sampled even for total=0 (Beta(1,1) = Uniform) which made the
  // factor range [0.5, 1.5] apply to EVERY candidate — tanking MRR by
  // ~3% on oracle splits because rank-1 answers lost coin flips.
  // Config-driven gate + range. Default threshold 3, range 0.5 (factor
  // ∈ [0.75, 1.25]). Override via NEUROMCP_USEFULNESS_EXPLORATION_THRESHOLD
  // and NEUROMCP_USEFULNESS_FACTOR_RANGE.
  const explorationThreshold = config.usefulnessExplorationThreshold;
  const factorRange = config.usefulnessFactorRange;
  try {
    const counts = getUsefulnessCounts(db, scored.map((s) => s.id));
    for (const s of scored) {
      const c = counts.get(s.id);
      const total = (c?.helpful ?? 0) + (c?.harmful ?? 0);
      if (!c || total < explorationThreshold) {
        // No signal → neutral factor, no Thompson noise.
        continue;
      }
      const u = sampleUsefulness(c.helpful, c.harmful);
      const factor = 1 - factorRange / 2 + u * factorRange;
      s.score *= factor;
    }
  } catch {
    logger.warn('search', 'Usefulness prior failed, proceeding without');
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

    // Adaptive importance: boost score by access patterns + recency + centrality
    const factors = computeAdaptiveImportance(db, memory.id, {
      accessBoost: config.accessBoost,
      recencyBoost: config.recencyBoost,
      centralityBoost: config.centralityBoost,
    });
    const adaptiveMultiplier = 0.7 + 0.3 * factors.adjusted; // range [0.7, 1.0]
    const finalScore = candidate.score * adaptiveMultiplier;

    results.push({ ...memory, similarity_score: finalScore });
  }

  // Step 8: Re-sort by final score. The adaptive multiplier in Step 7 can
  // reorder candidates relative to the RRF order, and MMR assumes its input
  // is sorted by relevance (it seeds with candidates[0] and normalizes
  // against candidates[0].similarity_score).
  results.sort((a, b) => b.similarity_score - a.similarity_score);

  // Step 9: MMR re-ranking for diversity
  const mmrResults = mmrRerank(results, config.mmrLambda, limit);
  const finalResults = [...mmrResults];

  // Step 10: Record co-retrieval patterns for attention learning
  if (finalResults.length >= 2) {
    try {
      recordCoRetrieval(db, finalResults.map((r) => r.id));
    } catch {
      logger.warn('search', 'Co-retrieval recording failed');
    }
  }

  // Step 11: Bump access counts in a transaction
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

  // Step 11: Enrich with explanations (default: on)
  let enrichedResults: readonly (MemoryWithScore | MemoryWithExplanation)[] = finalResults;
  if (explain) {
    enrichedResults = finalResults.map((memory) => ({
      ...memory,
      explain: explainMemory(db, memory),
    }));
  }

  logger.info('search', 'search complete', {
    query: input.query,
    results: finalResults.length,
    preMMR: results.length,
    hybrid,
    graphBoost: graphScores.size > 0,
    primingBoost: primingScores.size > 0,
    explain,
    namespace,
  });
  metrics.increment('search.queries');
  metrics.record('search.results', finalResults.length);
  metrics.record('search.duration_ms', Date.now() - start);

  return enrichedResults;
}
