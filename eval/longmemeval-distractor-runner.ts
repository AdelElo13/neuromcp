#!/usr/bin/env tsx
/**
 * LongMemEval WITH DISTRACTORS — the honest benchmark.
 *
 * Oracle-split LongMemEval isolates the correct memory in a small
 * corpus, which makes retrieval easy (we scored 99.8% R@5). That
 * number is marketing, not engineering.
 *
 * This runner pre-loads the namespace with N random "distractor"
 * memories drawn from other questions' haystacks, then runs the
 * normal question-answer evaluation. The correct memory now
 * competes against real noise.
 *
 * Usage:
 *   npx tsx eval/longmemeval-distractor-runner.ts --distractors 1000 --limit 50
 *   npx tsx eval/longmemeval-distractor-runner.ts --distractors 10000
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestDb, teardownTestDb, type TestContext } from '../tests/helpers/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { storeMemory } from '../src/tools/store.js';
import { searchMemory } from '../src/tools/search.js';
import { createEmbeddingProvider } from '../src/embeddings/factory.js';
import { createRerankProvider } from '../src/rerank/factory.js';
import type { RerankProvider } from '../src/rerank/types.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/observability/logger.js';
import { computeRetrievalMetrics } from './metrics.js';

interface Turn { role: string; content: string; has_answer?: boolean }
interface LongMemQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
}

interface QuestionResult {
  question_id: string;
  question_type: string;
  // Honest metrics (see eval/metrics.ts). hit5/hit10 are "any gold in top-k";
  // recall5/recall10 are the fraction of the gold set retrieved — these
  // differ on multi-memory gold sets and used to be conflated.
  hit5: number;
  hit10: number;
  recall5: number;
  recall10: number;
  precision5: number;
  ndcg5: number;
  mrr: number;
  latency_ms: number;
}

function parseArgs(): { limit?: number; type?: string; distractors: number } {
  const args = process.argv.slice(2);
  const opts: { limit?: number; type?: string; distractors: number } = { distractors: 1000 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) opts.limit = parseInt(args[++i], 10);
    else if (args[i] === '--type' && args[i + 1]) opts.type = args[++i];
    else if (args[i] === '--distractors' && args[i + 1]) opts.distractors = parseInt(args[++i], 10);
  }
  return opts;
}

async function runQuestion(
  ctx: TestContext,
  q: LongMemQuestion,
  distractorPool: Array<{ text: string; sessionId: string }>,
  embedder: TestContext['embedder'],
  reranker: RerankProvider | null,
): Promise<QuestionResult> {

  // Pre-load distractors FIRST (they're just memories that shouldn't match)
  for (const d of distractorPool) {
    await storeMemory(
      { content: d.text, namespace: 'default', category: 'distractor', source: 'auto' },
      { db: ctx.db, vecStore: ctx.vecStore, embedder, logger: ctx.logger, metrics: ctx.metrics, config: ctx.config },
    );
  }

  // Load the oracle haystack into a separate namespace the question will search
  const sessionIdToMemoryId = new Map<string, string[]>();
  for (let i = 0; i < q.haystack_sessions.length; i++) {
    const sessionId = q.haystack_session_ids[i];
    if (!sessionId) continue;
    const session = q.haystack_sessions[i];
    if (!session) continue;
    const mids: string[] = [];
    for (const turn of session) {
      const result = await storeMemory(
        {
          content: `${turn.role}: ${turn.content}`,
          namespace: 'default',
          category: turn.has_answer ? 'answer-bearing' : 'context',
          tags: [sessionId],
          source: 'auto',
        },
        { db: ctx.db, vecStore: ctx.vecStore, embedder, logger: ctx.logger, metrics: ctx.metrics, config: ctx.config },
      );
      if (result.id) mids.push(result.id);
    }
    sessionIdToMemoryId.set(sessionId, mids);
  }

  // Collect the IDs of answer-bearing memories (ground truth)
  const goldIds = new Set<string>();
  for (const sid of q.answer_session_ids) {
    const mids = sessionIdToMemoryId.get(sid) || [];
    for (const mid of mids) goldIds.add(mid);
  }

  // Search — WITHOUT specifying namespace so distractors DO compete.
  // Latency is measured around the retrieval call only (not the seeding).
  const t0 = Date.now();
  const results = await searchMemory(
    { query: q.question, limit: 10, hybrid: true },
    { db: ctx.db, vecStore: ctx.vecStore, embedder, logger: ctx.logger, metrics: ctx.metrics, config: ctx.config, reranker },
  );
  const latencyMs = Date.now() - t0;

  const resultIds = results.map((r) => r.id);
  const m = computeRetrievalMetrics(resultIds, goldIds);

  return {
    question_id: q.question_id,
    question_type: q.question_type,
    hit5: m.hit5,
    hit10: m.hit10,
    recall5: m.recall5,
    recall10: m.recall10,
    precision5: m.precision5,
    ndcg5: m.ndcg5,
    mrr: m.mrr,
    latency_ms: latencyMs,
  };
}

function buildDistractorPool(allQuestions: LongMemQuestion[], count: number): Array<{ text: string; sessionId: string }> {
  // Flatten all haystacks into sentences, shuffle, take count.
  const pool: Array<{ text: string; sessionId: string }> = [];
  for (const q of allQuestions) {
    for (let i = 0; i < q.haystack_sessions.length; i++) {
      const sessionId = q.haystack_session_ids[i];
      if (!sessionId) continue;
      const session = q.haystack_sessions[i];
      if (!session) continue;
      for (const turn of session) {
        pool.push({ text: `${turn.role}: ${turn.content}`, sessionId });
      }
    }
  }
  // Deterministic shuffle via seeded PRNG (mulberry32) so the benchmark
  // is reproducible AND actually random. v0.18.0 shipped with a broken
  // shuffle that always mapped j=0, producing a deterministic-head-of-array
  // slice instead of random distractors.
  let state = 42 >>> 0;
  const random = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}

async function main() {
  const opts = parseArgs();
  const datasetPath = resolve(__dirname, 'longmemeval', 'oracle.json');
  const raw = readFileSync(datasetPath, 'utf8');
  const questions = JSON.parse(raw) as LongMemQuestion[];

  let filtered = questions;
  if (opts.type) filtered = filtered.filter((q) => q.question_type === opts.type);
  if (opts.limit) filtered = filtered.slice(0, opts.limit);

  console.log(`=== LongMemEval WITH DISTRACTORS — neuromcp ===`);
  console.log(`Questions: ${filtered.length}`);
  console.log(`Distractors per run: ${opts.distractors}`);

  // v0.18.1: production embedder (Ollama > OpenAI > ONNX), not the test
  // FakeEmbedder. Round-16 codex caught that v0.18.0 used a hash stub.
  const config = loadConfig();
  const logger = createLogger(config);
  const embedder = await createEmbeddingProvider(config, logger);
  const reranker = await createRerankProvider(config, logger);
  console.log(`Embedder: ${embedder.name} (dim=${embedder.dimensions})`);
  console.log(`Reranker: ${reranker ? reranker.name : 'none'}`);
  console.log('');

  const distractorPool = buildDistractorPool(questions, opts.distractors);
  console.log(`Built distractor pool: ${distractorPool.length} candidates\n`);

  const results: QuestionResult[] = [];
  for (let i = 0; i < filtered.length; i++) {
    process.stdout.write(`  Progress: ${i + 1}/${filtered.length}\r`);
    const ctx = await setupTestDb({ dimensions: embedder.dimensions });
    try {
      const result = await runQuestion(ctx, filtered[i]!, distractorPool, embedder, reranker);
      results.push(result);
    } finally {
      await teardownTestDb(ctx);
    }
  }
  console.log('');

  // Aggregate
  const byType = new Map<string, QuestionResult[]>();
  for (const r of results) {
    if (!byType.has(r.question_type)) byType.set(r.question_type, []);
    byType.get(r.question_type)!.push(r);
  }

  const pct = (xs: QuestionResult[], sel: (r: QuestionResult) => number): string =>
    (xs.reduce((s, r) => s + sel(r), 0) / xs.length * 100).toFixed(1);
  const avg = (xs: QuestionResult[], sel: (r: QuestionResult) => number): number =>
    xs.reduce((s, r) => s + sel(r), 0) / xs.length;
  const p95 = (xs: QuestionResult[]): number => {
    const sorted = xs.map((r) => r.latency_ms).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  };

  const rerankerLabel = reranker ? reranker.name : 'none';
  console.log(`## Results with ${opts.distractors} distractors (reranker=${rerankerLabel})\n`);
  console.log('| Type | N | Hit@5 | R@5(true) | P@5 | nDCG@5 | MRR | Hit@10 | lat ms (avg/p95) |');
  console.log('|------|---|-------|-----------|-----|--------|-----|--------|------------------|');
  const row = (label: string, rs: QuestionResult[]): string =>
    `| ${label} | ${rs.length} | ${pct(rs, (r) => r.hit5)}% | ${pct(rs, (r) => r.recall5)}% | ` +
    `${pct(rs, (r) => r.precision5)}% | ${pct(rs, (r) => r.ndcg5)}% | ${pct(rs, (r) => r.mrr)}% | ` +
    `${pct(rs, (r) => r.hit10)}% | ${avg(rs, (r) => r.latency_ms).toFixed(0)}/${p95(rs).toFixed(0)} |`;
  for (const [type, rs] of byType.entries()) console.log(row(type, rs));
  console.log(row('**OVERALL**', results));

  const overall = {
    reranker: rerankerLabel,
    hit5: pct(results, (r) => r.hit5),
    recall5: pct(results, (r) => r.recall5),
    precision5: pct(results, (r) => r.precision5),
    ndcg5: pct(results, (r) => r.ndcg5),
    mrr: pct(results, (r) => r.mrr),
    hit10: pct(results, (r) => r.hit10),
    latency_avg_ms: Math.round(avg(results, (r) => r.latency_ms)),
    latency_p95_ms: Math.round(p95(results)),
  };
  const suffix = reranker === null ? '' : `-rerank-${rerankerLabel}`;
  const outPath = resolve(__dirname, 'longmemeval', `distractor-${opts.distractors}${suffix}-results.json`);
  writeFileSync(outPath, JSON.stringify({ distractors: opts.distractors, results, overall }, null, 2));
  console.log(`\nResults saved to: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
