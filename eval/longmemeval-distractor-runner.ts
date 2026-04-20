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
  recall5: number;
  recall10: number;
  mrr: number;
  hit: boolean;
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
): Promise<QuestionResult> {
  const embedder = ctx.embedder;

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

  // Search — WITHOUT specifying namespace so distractors DO compete
  const results = await searchMemory(
    { query: q.question, limit: 10, hybrid: true },
    { db: ctx.db, vecStore: ctx.vecStore, embedder, logger: ctx.logger, metrics: ctx.metrics, config: ctx.config },
  );

  const resultIds = results.map((r) => r.id);

  // Compute metrics
  let firstHit = -1;
  for (let i = 0; i < resultIds.length; i++) {
    if (goldIds.has(resultIds[i]!)) { firstHit = i; break; }
  }

  const top5 = resultIds.slice(0, 5);
  const top10 = resultIds;
  const hit5 = top5.some((id) => goldIds.has(id));
  const hit10 = top10.some((id) => goldIds.has(id));

  return {
    question_id: q.question_id,
    question_type: q.question_type,
    recall5: hit5 ? 1 : 0,
    recall10: hit10 ? 1 : 0,
    mrr: firstHit >= 0 ? 1 / (firstHit + 1) : 0,
    hit: hit10,
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
  // Deterministic shuffle via seed so benchmark is reproducible
  const seed = 42;
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(((seed * (i + 1)) % (i + 1)));
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
  console.log('');

  const distractorPool = buildDistractorPool(questions, opts.distractors);
  console.log(`Built distractor pool: ${distractorPool.length} candidates\n`);

  const results: QuestionResult[] = [];
  for (let i = 0; i < filtered.length; i++) {
    process.stdout.write(`  Progress: ${i + 1}/${filtered.length}\r`);
    const ctx = await setupTestDb();
    try {
      const result = await runQuestion(ctx, filtered[i]!, distractorPool);
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

  console.log(`## Results with ${opts.distractors} distractors\n`);
  console.log('| Type | N | R@5 | R@10 | MRR | Hit Rate |');
  console.log('|------|---|-----|------|-----|----------|');
  for (const [type, rs] of byType.entries()) {
    const r5 = (rs.reduce((s, r) => s + r.recall5, 0) / rs.length * 100).toFixed(1);
    const r10 = (rs.reduce((s, r) => s + r.recall10, 0) / rs.length * 100).toFixed(1);
    const mrr = (rs.reduce((s, r) => s + r.mrr, 0) / rs.length * 100).toFixed(1);
    const hr = (rs.filter((r) => r.hit).length / rs.length * 100).toFixed(1);
    console.log(`| ${type} | ${rs.length} | ${r5}% | ${r10}% | ${mrr}% | ${hr}% |`);
  }
  const r5 = (results.reduce((s, r) => s + r.recall5, 0) / results.length * 100).toFixed(1);
  const r10 = (results.reduce((s, r) => s + r.recall10, 0) / results.length * 100).toFixed(1);
  const mrr = (results.reduce((s, r) => s + r.mrr, 0) / results.length * 100).toFixed(1);
  const hr = (results.filter((r) => r.hit).length / results.length * 100).toFixed(1);
  console.log(`| **OVERALL** | **${results.length}** | **${r5}%** | **${r10}%** | **${mrr}%** | **${hr}%** |`);

  const outPath = resolve(__dirname, 'longmemeval', `distractor-${opts.distractors}-results.json`);
  writeFileSync(outPath, JSON.stringify({ distractors: opts.distractors, results, overall: { r5, r10, mrr, hr } }, null, 2));
  console.log(`\nResults saved to: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
