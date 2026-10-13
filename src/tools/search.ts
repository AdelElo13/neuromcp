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
import type { RerankProvider } from '../rerank/types.js';
import { currentValiditySql, isCurrent } from '../governance/validity.js';

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
  /**
   * v0.29: include superseded / window-closed rows. Default false — only
   * current facts. A `valid_at` point-in-time query overrides this (history
   * is exactly what valid_at asks for).
   */
  readonly include_superseded?: boolean;
  /**
   * Relevance floor: drop candidates whose cosine similarity is below this
   * and that have no FTS or graph hit. Defaults to config.minSimilarity, else the
   * calibrated default for the active embedder (DEFAULT_MIN_SIMILARITY), else 0.
   */
  readonly min_similarity?: number;
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
  /**
   * Optional relevance reranker. When present, search fetches a wider
   * candidate pool (config.rerankPool), scores each candidate against the
   * query, and orders by that score before MMR. Absent/null → plain RRF
   * order (default). Constructed once at startup from config.reranker.
   */
  readonly reranker?: RerankProvider | null;
}

const RRF_K = 60;

/**
 * Weight of the raw cosine similarity added on top of the RRF terms. RRF
 * alone keeps only the rank, so a 0.58 vs 0.43 similarity gap counted the
 * same as 0.58 vs 0.57. 0.02 is the same order as one RRF term (1/61 ≈ 0.016),
 * so a large similarity gap survives fusion while an FTS hit still matters.
 */
const COSINE_WEIGHT = 0.02;

/**
 * Calibrated relevance floor per embedder, used when neither the call nor
 * NEUROMCP_MIN_SIMILARITY sets one. bge-m3, measured on 2402 real memories
 * with 40 Dutch paraphrase queries + 15 off-topic queries: 0.45 keeps 98% of
 * true targets and returns nothing for 73% of off-topic queries. Embedders
 * without a measured value (incl. nomic-embed-text, whose off-topic matches
 * score HIGHER than true ones on Dutch) get no default floor.
 */
const DEFAULT_MIN_SIMILARITY: Readonly<Record<string, number>> = {
  'bge-m3': 0.45,
};

/** Calibrated floor for an embedder; an Ollama tag (":latest") is ignored. */
export function defaultMinSimilarity(embedderName: string): number {
  return DEFAULT_MIN_SIMILARITY[embedderName.split(':')[0] ?? embedderName] ?? 0;
}

/** Only the top result of a search counts as a "use" for access_count. */
const ACCESS_BUMP_TOP_N = 1;

const MAX_FTS_TOKENS = 32;

/** Dutch + English function words of 3+ chars (shorter tokens are dropped anyway). */
const FTS_STOPWORDS: ReadonlySet<string> = new Set([
  // nl
  'het', 'een', 'van', 'dat', 'die', 'voor', 'met', 'aan', 'niet', 'zijn', 'ook', 'als', 'dan', 'maar',
  'bij', 'naar', 'uit', 'wat', 'wel', 'nog', 'hoe', 'waar', 'wie', 'deze', 'dit', 'heb', 'heeft', 'was',
  'wordt', 'worden', 'kan', 'moet', 'zou', 'over', 'tot', 'onder', 'door', 'mijn', 'jij', 'hij', 'zij',
  'wij', 'ons', 'hun', 'welke',
  // en
  'the', 'and', 'for', 'are', 'was', 'with', 'this', 'that', 'from', 'but', 'not', 'you', 'all', 'can',
  'has', 'have', 'had', 'its', 'our', 'what', 'which', 'who', 'how', 'when', 'where', 'into', 'about',
]);

export type SearchStage =
  | 'embedder'
  | 'fts'
  | 'graph'
  | 'priming'
  | 'attention'
  | 'usefulness'
  | 'importance'
  | 'rerank';

export interface SearchDiagnostics {
  /** Scoring stages that failed and were skipped for this query. */
  readonly degraded: readonly SearchStage[];
  /** Candidates removed by the min_similarity relevance floor. */
  readonly below_threshold_dropped: number;
}

export interface SearchDetailedResult {
  readonly results: readonly (MemoryWithScore | MemoryWithExplanation)[];
  readonly diagnostics: SearchDiagnostics;
}

/**
 * Build an FTS5 MATCH expression: each word quoted (so FTS5 operators in user
 * text are inert) and OR-ed. The previous version quoted the WHOLE query,
 * which made every multi-word query an exact adjacent-phrase match — "groene
 * plank" never matched "groene filamentrol op de plank". BM25 still ranks rows
 * matching more terms higher. Returns null when the query has no word tokens.
 */
export function buildFtsQuery(query: string): string | null {
  const tokens = ftsQueryTokens(query);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

/**
 * Tokenize like FTS5's default unicode61 tokenizer: diacritics folded
 * ("café" = "cafe", also for NFD-stored text) and "_" as a separator. A
 * mismatch would give a real FTS hit coverage 0 — no keyword bonus and no
 * exemption from the relevance floor.
 */
function wordTokens(text: string): string[] {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * The words a query is matched on. With OR semantics a single stopword
 * ("de", "the") would match most rows, so only content words are kept;
 * stopword-only queries fall back to all tokens.
 */
export function ftsQueryTokens(query: string): string[] {
  const all = [...new Set(wordTokens(query))];
  const content = all.filter((t) => t.length >= 3 && !FTS_STOPWORDS.has(t));
  return (content.length > 0 ? content : all).slice(0, MAX_FTS_TOKENS);
}

/**
 * Share of the query's match words that occur in `content` (0..1). OR
 * matching means one ordinary word ("beste", "trein") already makes a row a
 * keyword hit; coverage turns that into a graded signal.
 */
export function keywordCoverage(queryTokens: readonly string[], content: string): number {
  if (queryTokens.length === 0) return 0;
  const words = new Set(wordTokens(content));
  return queryTokens.filter((t) => words.has(t)).length / queryTokens.length;
}

/** Minimum keyword coverage for an FTS hit to count as direct relevance. */
const MIN_KEYWORD_COVERAGE = 0.5;

/** FTS rows (by rank) for which keyword coverage is computed. */
const MAX_COVERAGE_ROWS = 300;

/**
 * VectorStore.search returns cosine DISTANCE (sqlite-vec.ts converts L2 on
 * unit vectors to L2²/2), so similarity = 1 - distance — the same convention
 * as store.ts, contradiction.ts and surprise.ts.
 */
function cosineFromDistance(distance: number): number {
  return Math.max(-1, Math.min(1, 1 - distance));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  currentOnlyNow?: string,
): Array<{ id: string }> {
  // v0.29: when currentOnlyNow is set, push the current-validity predicate
  // into the candidate SQL so superseded/window-closed rows never consume
  // the FTS candidate budget (the keyword-side twin of vec starvation).
  const validity =
    currentOnlyNow !== undefined ? currentValiditySql(currentOnlyNow, 'm') : null;
  const validityClause = validity !== null ? ` AND (${validity.clause})` : '';
  const validityParams = validity !== null ? validity.params : [];

  if (namespace === undefined) {
    return db
      .prepare(
        `SELECT m.id FROM memories_fts f
         JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? AND m.is_deleted = 0${validityClause}
         ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, ...validityParams, k) as Array<{ id: string }>;
  }
  return db
    .prepare(
      `SELECT m.id FROM memories_fts f
       JOIN memories m ON m.rowid = f.rowid
       WHERE memories_fts MATCH ? AND m.is_deleted = 0 AND m.namespace = ?${validityClause}
       ORDER BY rank LIMIT ?`,
    )
    .all(ftsQuery, namespace, ...validityParams, k) as Array<{ id: string }>;
}

export async function searchMemory(
  input: SearchInput,
  deps: SearchDeps,
): Promise<readonly (MemoryWithScore | MemoryWithExplanation)[]> {
  return (await searchMemoryDetailed(input, deps)).results;
}

/**
 * searchMemory plus diagnostics: which scoring stages degraded and how many
 * candidates the relevance floor dropped. Callers that surface results to an
 * agent should use this so silent quality loss becomes visible.
 */
export async function searchMemoryDetailed(
  input: SearchInput,
  deps: SearchDeps,
): Promise<SearchDetailedResult> {
  const { db, vecStore, embedder, logger, metrics, config } = deps;
  const start = Date.now();
  const degraded = new Set<SearchStage>();
  const markDegraded = (stage: SearchStage, message: string, err: unknown, extra: Record<string, unknown> = {}): void => {
    degraded.add(stage);
    metrics.increment(`search.degraded_${stage}`);
    logger.warn('search', message, { ...extra, error: errorMessage(err) });
  };

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

  // v0.29 current-validity invariant: default reads hide superseded /
  // window-closed rows. A `valid_at` point-in-time query overrides this
  // (history is exactly what it asks for); `include_superseded` also opts
  // back into everything.
  const nowIso = new Date().toISOString();
  const currentOnly = input.valid_at === undefined && input.include_superseded !== true;

  // Candidate budget per leg. When a reranker is active it needs at least
  // rerankPool candidates to choose from — fetch enough up front, otherwise
  // (e.g. limit=5 → limit*3=15 < pool=30) the reranker can never see the
  // wider pool the Step-7 truncation promises.
  //
  // When the current-validity filter is active, superseded/window-closed
  // rows are filtered inside the FTS candidate SQL, but sqlite-vec cannot
  // push the predicate into its MATCH. To stop hidden rows from starving the
  // vec leg's top-k (a run of superseded near-duplicates would otherwise
  // crowd the current row out before Step 7 ever fetches it), widen the vec
  // candidate budget substantially when filtering is on.
  const reranker = deps.reranker ?? null;
  const baseCandidateK = reranker !== null ? Math.max(limit * 3, config.rerankPool) : limit * 3;
  const candidateK = baseCandidateK;
  // sqlite-vec hard-caps k at 4096; stay comfortably below.
  const vecCandidateK = currentOnly ? Math.min(Math.max(baseCandidateK * 8, 200), 4000) : baseCandidateK;

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
    degraded.add('embedder');
  }

  // Step 2: Vector search — push namespace into the vec query so we don't
  // waste the top-k budget on other tenants' data (see sqlite-vec.ts for
  // the recall-collapse story).
  const vecResults = embedding !== null ? vecStore.search(embedding, vecCandidateK, scopedNamespace) : [];

  const vecRanks = new Map<string, number>();
  const cosines = new Map<string, number>();
  vecResults.forEach((r, i) => {
    vecRanks.set(r.id, i + 1);
    cosines.set(r.id, cosineFromDistance(r.distance));
  });

  // Step 3: FTS search (best-effort), namespace pushed down like the vec leg
  const ftsRanks = new Map<string, number>();
  const ftsCoverage = new Map<string, number>();
  const queryTokens = ftsQueryTokens(input.query);
  const ftsQuery = hybrid ? buildFtsQuery(input.query) : null;
  if (ftsQuery !== null) {
    try {
      const ftsRows = ftsCandidates(
        db,
        ftsQuery,
        currentOnly ? vecCandidateK : candidateK,
        scopedNamespace,
        currentOnly ? nowIso : undefined,
      );

      ftsRows.forEach((row, i) => {
        ftsRanks.set(row.id, i + 1);
      });
      // Coverage needs the indexed text (FTS indexes content, summary and
      // tags). Fetched for the top rows only: with OR matching the candidate
      // list can run into the thousands, and a hit ranked beyond this adds at
      // most 1/(60+300) — rows past it get coverage 0.
      const covered = ftsRows.slice(0, MAX_COVERAGE_ROWS).map((r) => r.id);
      if (covered.length > 0) {
        const texts = db
          .prepare(
            `SELECT id, content, COALESCE(summary, '') AS summary, COALESCE(tags, '') AS tags
               FROM memories WHERE id IN (${covered.map(() => '?').join(',')})`,
          )
          .all(...covered) as Array<{ id: string; content: string; summary: string; tags: string }>;
        for (const t of texts) {
          ftsCoverage.set(t.id, keywordCoverage(queryTokens, `${t.content} ${t.summary} ${t.tags}`));
        }
      }
    } catch (err: unknown) {
      markDegraded('fts', 'FTS5 query failed, falling back to vector-only', err, { query: input.query });
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
    } catch (err: unknown) {
      markDegraded('graph', 'Graph boost failed, proceeding without', err);
    }
  }

  // Step 5: Priming boost — recently accessed memories boost related ones
  let primingScores = new Map<string, number>();
  try {
    const recentIds = getRecentlyAccessed(db, 30, 10);
    if (recentIds.length > 0) {
      primingScores = computePrimingBoosts(db, recentIds, config.primingBoost);
    }
  } catch (err: unknown) {
    markDegraded('priming', 'Priming boost failed, proceeding without', err);
  }

  // Step 6: Merge with RRF scoring + cosine magnitude + graph boost + priming.
  // Relevance floor: with min_similarity > 0 a candidate needs either an FTS
  // hit or cosine >= floor. Without a floor every query returns `limit` rows
  // (the vec leg covers the whole store), relevant or not. The floor is not
  // applied when the embedder is down — FTS is then the only signal.
  const minSimilarity =
    input.min_similarity ?? config.minSimilarity ?? defaultMinSimilarity(embedder.name);
  const floorActive = minSimilarity > 0 && embedding !== null;
  let belowThresholdDropped = 0;
  const allIds = new Set([...vecRanks.keys(), ...ftsRanks.keys(), ...graphScores.keys()]);
  const scored: Array<{ id: string; score: number }> = [];

  for (const id of allIds) {
    const vecRank = vecRanks.get(id);
    const ftsRank = ftsRanks.get(id);
    const coverage = ftsCoverage.get(id) ?? 0;
    const cosine = cosines.get(id);
    const graphScore = graphScores.get(id) ?? 0;
    const primingScore = primingScores.get(id) ?? 0;

    // Direct relevance: a keyword hit covering at least half of the query's
    // content words, or a graph hit (an entity named in the query). A hit on
    // one ordinary word of a longer query is not enough — on real data that
    // let most off-topic results through the floor.
    const strongKeywordHit = ftsRank !== undefined && coverage >= MIN_KEYWORD_COVERAGE;
    const hasDirectSignal = strongKeywordHit || graphScore > 0;
    if (floorActive && !hasDirectSignal && (cosine === undefined || cosine < minSimilarity)) {
      belowThresholdDropped++;
      continue;
    }

    let score = 0;
    if (vecRank !== undefined) {
      score += 1 / (RRF_K + vecRank);
    }
    if (cosine !== undefined) {
      score += COSINE_WEIGHT * Math.max(0, cosine);
    }
    if (ftsRank !== undefined) {
      // Keyword bonus scaled by how much of the query the row covers. sqrt
      // keeps a strong partial match (3 of 4 words ≈ 0.87) close to a full
      // one while a 1-of-5 word hit drops to ≈ 0.45. Linear scaling scored
      // marginally better on real Dutch data but cost 14 pts Recall@5 on the
      // keyword-driven verbatim-recall eval; sqrt regresses neither.
      score += Math.sqrt(coverage) / (RRF_K + ftsRank);
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
  } catch (err: unknown) {
    markDegraded('attention', 'Attention scoring failed, proceeding without', err);
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
  } catch (err: unknown) {
    markDegraded('usefulness', 'Usefulness prior failed, proceeding without', err);
  }

  scored.sort((a, b) => b.score - a.score);

  // Step 7: Fetch full rows, apply post-filters. When a reranker is active
  // we fetch a WIDER pool (rerankPool) so the reranker can promote a
  // candidate that RRF ranked outside the top `limit` — truncating to
  // `limit` here first would make the reranker a no-op (it could only
  // reorder within the top-`limit`, never pull #11 into the top-10).
  const pool = reranker !== null ? Math.max(limit, config.rerankPool) : limit;
  const nsFilter = namespaceFilter(input.namespace, config.defaultNamespace);
  const results: MemoryWithScore[] = [];

  for (const candidate of scored) {
    if (results.length >= pool) break;

    const memory = db
      .prepare('SELECT * FROM memories WHERE id = ?')
      .get(candidate.id) as Memory | undefined;

    if (memory === undefined) continue;
    if (memory.is_deleted === 1) continue;

    // v0.29 current-validity invariant: hide superseded / window-closed rows
    // on default reads. valid_at (below) and include_superseded opt back in.
    if (currentOnly && !isCurrent(memory, nowIso)) continue;

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

    // Importance filter — on the computed value (v14 split), falling back
    // to the user value for pre-migration rows.
    const memEffective = memory.effective_importance ?? memory.importance;
    if (input.min_importance !== undefined && memEffective < input.min_importance) {
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

    // Adaptive importance (access + recency + centrality) as a TIE-BREAKER:
    // multiplier ∈ [1 - w, 1] with w = config.importanceWeight (0.1). The old
    // fixed [0.7, 1.0] range outweighed relevance ~10×, so popular unrelated
    // memories beat the actual best match. A failing lookup (e.g. centrality
    // over a broken entities table) falls back to the stored importance
    // instead of failing the whole search.
    let adjustedImportance: number;
    try {
      adjustedImportance = computeAdaptiveImportance(db, memory.id, {
        accessBoost: config.accessBoost,
        recencyBoost: config.recencyBoost,
        centralityBoost: config.centralityBoost,
      }).adjusted;
    } catch (err: unknown) {
      if (!degraded.has('importance')) {
        markDegraded('importance', 'Adaptive importance failed, using stored importance', err);
      }
      adjustedImportance = memEffective;
    }
    const importanceWeight = config.importanceWeight;
    const adaptiveMultiplier = 1 - importanceWeight + importanceWeight * adjustedImportance;
    const finalScore = candidate.score * adaptiveMultiplier;

    results.push({ ...memory, similarity_score: finalScore });
  }

  // Step 8: Re-sort by final score. The adaptive multiplier in Step 7 can
  // reorder candidates relative to the RRF order, and MMR assumes its input
  // is sorted by relevance.
  results.sort((a, b) => b.similarity_score - a.similarity_score);

  // Step 8.5: Cross-encoder rerank (v0.26). Score each candidate against the
  // query, store a normalized rerank_score (sigmoid of the raw logit, so
  // MMR's relevance ratio stays positive) WITHOUT touching similarity_score,
  // then order by it. Best-effort: any reranker failure falls back to the
  // RRF order, consistent with every other boost stage.
  let ranked: MemoryWithScore[] = results;
  let mmrScoreOf: (m: MemoryWithScore) => number = (m) => m.similarity_score;
  if (reranker !== null && results.length > 1) {
    try {
      const rerankStart = Date.now();
      const rawScores = await reranker.rerank(input.query, results.map((r) => r.content));
      ranked = results
        .map((r, i) => {
          const logit = rawScores[i] ?? 0;
          const rerankScore = 1 / (1 + Math.exp(-logit)); // sigmoid → (0,1)
          return { ...r, rerank_score: rerankScore };
        })
        .sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0));
      mmrScoreOf = (m) => m.rerank_score ?? m.similarity_score;
      metrics.increment('search.reranked');
      metrics.record('search.rerank_ms', Date.now() - rerankStart);
    } catch (err: unknown) {
      markDegraded('rerank', 'Reranker failed, falling back to RRF order', err);
      ranked = results;
    }
  }

  // Step 9: MMR re-ranking for diversity, over the (possibly reranked) pool.
  const mmrResults = mmrRerank(ranked, config.mmrLambda, limit, mmrScoreOf);
  const finalResults = [...mmrResults];

  // Step 10: Record co-retrieval patterns for attention learning
  if (finalResults.length >= 2) {
    try {
      recordCoRetrieval(db, finalResults.map((r) => r.id));
    } catch (err: unknown) {
      logger.warn('search', 'Co-retrieval recording failed', { error: errorMessage(err) });
    }
  }

  // Step 11: Bump access counts — only the top result counts as a use.
  // Bumping every returned row fed a rich-get-richer loop: rows returned for
  // every query (because importance dominated) gained access_count, which
  // raised their adaptive importance, which kept them on top. recall_memory
  // (fetch by id) still counts as a use.
  const used = finalResults.slice(0, ACCESS_BUMP_TOP_N);
  if (used.length > 0) {
    const bumpStmt = db.prepare(
      "UPDATE memories SET access_count = access_count + 1, last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    );
    const bumpAll = db.transaction(() => {
      for (const r of used) {
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
    degraded: [...degraded],
    belowThresholdDropped,
  });
  metrics.increment('search.queries');
  metrics.record('search.results', finalResults.length);
  metrics.record('search.duration_ms', Date.now() - start);

  return {
    results: enrichedResults,
    diagnostics: { degraded: [...degraded], below_threshold_dropped: belowThresholdDropped },
  };
}
