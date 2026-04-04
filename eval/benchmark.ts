import { readFileSync } from 'node:fs';
import { setupTestDb, teardownTestDb, insertTestMemory } from '../tests/helpers/index.js';
import { searchMemory } from '../src/tools/search.js';
import type { TestContext } from '../tests/helpers/index.js';
import type { TrustLevel } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixture Types
// ---------------------------------------------------------------------------

interface FixtureMemory {
  readonly id: string;
  readonly content: string;
  readonly namespace?: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly source_trust?: TrustLevel;
  readonly is_tombstoned?: boolean;
}

interface FixtureQuery {
  readonly query: string;
  readonly namespace?: string;
  readonly min_trust?: TrustLevel | null;
  readonly expected_ids: readonly string[];
  readonly excluded_ids?: readonly string[];
  readonly description?: string;
}

interface Fixture {
  readonly memories: readonly FixtureMemory[];
  readonly queries: readonly FixtureQuery[];
}

// ---------------------------------------------------------------------------
// Metric Types
// ---------------------------------------------------------------------------

export interface QueryResult {
  readonly query: string;
  readonly expectedIds: readonly string[];
  readonly returnedIds: readonly string[];
  readonly excludedIds: readonly string[];
  readonly recall5: number;
  readonly recall10: number;
  readonly mrr: number;
  readonly hit: boolean;
  readonly exclusionViolations: readonly string[];
  readonly latencyMs: number;
}

export interface BenchmarkResult {
  readonly fixture: string;
  readonly queryResults: readonly QueryResult[];
  readonly recall5: number;
  readonly recall10: number;
  readonly mrr: number;
  readonly hitRate: number;
  readonly searchP95Ms: number;
  readonly exclusionPassRate: number;
}

// ---------------------------------------------------------------------------
// Metric Computation
// ---------------------------------------------------------------------------

function computeRecallAtK(
  expectedIds: readonly string[],
  returnedIds: readonly string[],
  k: number,
): number {
  if (expectedIds.length === 0) return 1.0;
  const topK = returnedIds.slice(0, k);
  const found = expectedIds.filter((id) => topK.includes(id)).length;
  return found / expectedIds.length;
}

function computeMRR(
  expectedIds: readonly string[],
  returnedIds: readonly string[],
): number {
  if (expectedIds.length === 0) return 1.0;
  for (let i = 0; i < returnedIds.length; i++) {
    if (expectedIds.includes(returnedIds[i]!)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

// ---------------------------------------------------------------------------
// Benchmark Runner
// ---------------------------------------------------------------------------

export async function runBenchmark(fixturePath: string): Promise<BenchmarkResult> {
  const raw = readFileSync(fixturePath, 'utf-8');
  const fixture: Fixture = JSON.parse(raw);

  // Set up a fresh database
  const ctx = setupTestDb();

  try {
    // Seed memories — insert directly and upsert embeddings
    for (const mem of fixture.memories) {
      const id = insertTestMemory(ctx, {
        id: mem.id,
        content: mem.content,
        namespace: mem.namespace ?? 'default',
        category: mem.category ?? 'general',
        tags: mem.tags ? [...mem.tags] : [],
        source_trust: mem.source_trust ?? 'medium',
        is_deleted: mem.is_tombstoned ? 1 : 0,
        tombstoned_at: mem.is_tombstoned ? new Date().toISOString() : null,
      });

      // Generate embedding and insert into vec store
      const embedding = await ctx.embedder.embed(mem.content);
      ctx.vecStore.upsert(id, embedding);

      // Sync to FTS
      const row = ctx.db
        .prepare('SELECT rowid FROM memories WHERE id = ?')
        .get(id) as { rowid: number };

      const tags = JSON.stringify(mem.tags ?? []);
      const category = mem.category ?? 'general';
      ctx.db
        .prepare(
          'INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, ?, ?)',
        )
        .run(row.rowid, mem.content, tags, category);
    }

    // Run queries
    const queryResults: QueryResult[] = [];

    for (const q of fixture.queries) {
      const start = performance.now();
      const results = await searchMemory(
        {
          query: q.query,
          namespace: q.namespace,
          limit: 10,
          min_trust: q.min_trust === null ? undefined : q.min_trust,
        },
        {
          db: ctx.db,
          vecStore: ctx.vecStore,
          embedder: ctx.embedder,
          logger: ctx.logger,
          metrics: ctx.metrics,
          config: ctx.config,
        },
      );
      const latencyMs = performance.now() - start;

      const returnedIds = results.map((r) => r.id);
      const excludedIds = q.excluded_ids ?? [];
      const exclusionViolations = excludedIds.filter((id) => returnedIds.includes(id));

      queryResults.push({
        query: q.query,
        expectedIds: [...q.expected_ids],
        returnedIds,
        excludedIds: [...excludedIds],
        recall5: computeRecallAtK(q.expected_ids, returnedIds, 5),
        recall10: computeRecallAtK(q.expected_ids, returnedIds, 10),
        mrr: computeMRR(q.expected_ids, returnedIds),
        hit: q.expected_ids.length === 0 || q.expected_ids.some((id) => returnedIds.includes(id)),
        exclusionViolations,
        latencyMs,
      });
    }

    // Aggregate metrics
    const queriesWithExpected = queryResults.filter((q) => q.expectedIds.length > 0);
    const allQueries = queryResults;

    const avgRecall5 =
      queriesWithExpected.length > 0
        ? queriesWithExpected.reduce((s, q) => s + q.recall5, 0) / queriesWithExpected.length
        : 1.0;
    const avgRecall10 =
      queriesWithExpected.length > 0
        ? queriesWithExpected.reduce((s, q) => s + q.recall10, 0) / queriesWithExpected.length
        : 1.0;
    const avgMrr =
      queriesWithExpected.length > 0
        ? queriesWithExpected.reduce((s, q) => s + q.mrr, 0) / queriesWithExpected.length
        : 1.0;
    const hitRate =
      allQueries.length > 0
        ? allQueries.filter((q) => q.hit).length / allQueries.length
        : 1.0;

    const latencies = queryResults.map((q) => q.latencyMs);
    const searchP95Ms = percentile(latencies, 95);

    const totalExclusions = queryResults.reduce((s, q) => s + q.excludedIds.length, 0);
    const violations = queryResults.reduce((s, q) => s + q.exclusionViolations.length, 0);
    const exclusionPassRate = totalExclusions > 0 ? 1 - violations / totalExclusions : 1.0;

    return {
      fixture: fixturePath,
      queryResults,
      recall5: avgRecall5,
      recall10: avgRecall10,
      mrr: avgMrr,
      hitRate,
      searchP95Ms,
      exclusionPassRate,
    };
  } finally {
    teardownTestDb(ctx);
  }
}
