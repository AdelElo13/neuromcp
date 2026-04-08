#!/usr/bin/env tsx
/**
 * LongMemEval benchmark runner for neuromcp.
 *
 * Tests both verbatim and extracted memory retrieval against the
 * official LongMemEval 500-question dataset (oracle split).
 *
 * Metrics: Recall@5, Recall@10, Hit Rate — per question type and overall.
 *
 * Usage:
 *   npx tsx eval/longmemeval-runner.ts [--limit N] [--type TYPE]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupTestDb, teardownTestDb, type TestContext } from '../tests/helpers/index.js';
import { storeVerbatim, searchVerbatim } from '../src/tools/verbatim.js';
import { storeMemory } from '../src/tools/store.js';
import { searchMemory } from '../src/tools/search.js';

// ─── Types ─────────────────────────────────────────────────────────

interface Turn {
  readonly role: string;
  readonly content: string;
  readonly has_answer?: boolean;
}

interface LongMemQuestion {
  readonly question_id: string;
  readonly question_type: string;
  readonly question: string;
  readonly answer: string;
  readonly question_date: string;
  readonly haystack_dates: readonly string[];
  readonly haystack_session_ids: readonly string[];
  readonly haystack_sessions: readonly (readonly Turn[])[];
  readonly answer_session_ids: readonly string[];
}

interface QuestionResult {
  readonly question_id: string;
  readonly question_type: string;
  readonly verbatim_recall5: number;
  readonly verbatim_recall10: number;
  readonly verbatim_hit: boolean;
  readonly extracted_recall5: number;
  readonly extracted_recall10: number;
  readonly extracted_hit: boolean;
}

interface TypeMetrics {
  readonly type: string;
  readonly count: number;
  readonly verbatim_recall5: number;
  readonly verbatim_recall10: number;
  readonly verbatim_hit_rate: number;
  readonly extracted_recall5: number;
  readonly extracted_recall10: number;
  readonly extracted_hit_rate: number;
}

// ─── Helpers ───────────────────────────────────────────────────────

function recallAtK(answerSessionIds: readonly string[], returnedSessionIds: readonly string[], k: number): number {
  if (answerSessionIds.length === 0) return 1.0;
  const topK = returnedSessionIds.slice(0, k);
  const found = answerSessionIds.filter((id) => topK.includes(id)).length;
  return found / answerSessionIds.length;
}

function avg(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ─── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]!, 10) : undefined;
  const typeIdx = args.indexOf('--type');
  const filterType = typeIdx >= 0 ? args[typeIdx + 1] : undefined;

  const dataPath = resolve(import.meta.dirname, 'longmemeval/oracle.json');
  const raw = readFileSync(dataPath, 'utf-8');
  let questions: LongMemQuestion[] = JSON.parse(raw);

  if (filterType) {
    questions = questions.filter((q) => q.question_type === filterType);
  }
  if (limit) {
    questions = questions.slice(0, limit);
  }

  console.log(`\n=== LongMemEval Benchmark for neuromcp ===`);
  console.log(`Questions: ${questions.length}${filterType ? ` (type: ${filterType})` : ''}\n`);

  const results: QuestionResult[] = [];
  let processed = 0;

  for (const q of questions) {
    // Fresh DB per question to avoid cross-contamination
    const ctx = setupTestDb();

    try {
      // Ingest all sessions
      const sessionIdMap = new Map<string, string>(); // verbatim_id -> session_id

      for (let sIdx = 0; sIdx < q.haystack_sessions.length; sIdx++) {
        const session = q.haystack_sessions[sIdx]!;
        const sessionId = q.haystack_session_ids[sIdx]!;

        // Combine all turns into one chunk per session (verbatim approach)
        const fullText = session
          .map((t) => `[${t.role}]: ${t.content}`)
          .join('\n');

        // Store as verbatim
        const vResult = storeVerbatim(
          { content: fullText, metadata: { session_id: sessionId } },
          ctx.db, ctx.config, ctx.logger, ctx.metrics,
        );
        sessionIdMap.set(vResult.id, sessionId);

        // Store as extracted memory (just the content, let the pipeline process it)
        await storeMemory(
          { content: fullText, metadata: { session_id: sessionId } },
          { db: ctx.db, vecStore: ctx.vecStore, embedder: ctx.embedder, logger: ctx.logger, metrics: ctx.metrics, config: ctx.config },
        );
      }

      // Search verbatim
      const verbatimResults = searchVerbatim(
        { query: q.question, limit: 10, namespace: '*' },
        ctx.db, ctx.config, ctx.logger, ctx.metrics,
      );

      // Map verbatim result IDs back to session IDs
      const verbatimSessionIds = verbatimResults
        .map((r) => {
          const meta = JSON.parse(r.metadata);
          return meta.session_id as string;
        })
        .filter(Boolean);

      // Search extracted
      const extractedResults = await searchMemory(
        { query: q.question, limit: 10 },
        { db: ctx.db, vecStore: ctx.vecStore, embedder: ctx.embedder, logger: ctx.logger, metrics: ctx.metrics, config: ctx.config },
      );

      const extractedSessionIds = extractedResults
        .map((r) => {
          try {
            const meta = JSON.parse(r.metadata);
            return meta.session_id as string;
          } catch {
            return undefined;
          }
        })
        .filter((id): id is string => id !== undefined);

      // Score
      const result: QuestionResult = {
        question_id: q.question_id,
        question_type: q.question_type,
        verbatim_recall5: recallAtK(q.answer_session_ids, verbatimSessionIds, 5),
        verbatim_recall10: recallAtK(q.answer_session_ids, verbatimSessionIds, 10),
        verbatim_hit: q.answer_session_ids.some((id) => verbatimSessionIds.includes(id)),
        extracted_recall5: recallAtK(q.answer_session_ids, extractedSessionIds, 5),
        extracted_recall10: recallAtK(q.answer_session_ids, extractedSessionIds, 10),
        extracted_hit: q.answer_session_ids.some((id) => extractedSessionIds.includes(id)),
      };

      results.push(result);
    } finally {
      teardownTestDb(ctx);
    }

    processed++;
    if (processed % 10 === 0 || processed === questions.length) {
      process.stdout.write(`\r  Progress: ${processed}/${questions.length}`);
    }
  }

  console.log('\n');

  // ─── Aggregate by type ────────────────────────────────────────────

  const types = [...new Set(results.map((r) => r.question_type))].sort();
  const typeMetrics: TypeMetrics[] = [];

  for (const type of types) {
    const typeResults = results.filter((r) => r.question_type === type);
    typeMetrics.push({
      type,
      count: typeResults.length,
      verbatim_recall5: avg(typeResults.map((r) => r.verbatim_recall5)),
      verbatim_recall10: avg(typeResults.map((r) => r.verbatim_recall10)),
      verbatim_hit_rate: avg(typeResults.map((r) => (r.verbatim_hit ? 1 : 0))),
      extracted_recall5: avg(typeResults.map((r) => r.extracted_recall5)),
      extracted_recall10: avg(typeResults.map((r) => r.extracted_recall10)),
      extracted_hit_rate: avg(typeResults.map((r) => (r.extracted_hit ? 1 : 0))),
    });
  }

  // Overall
  const overall: TypeMetrics = {
    type: 'OVERALL',
    count: results.length,
    verbatim_recall5: avg(results.map((r) => r.verbatim_recall5)),
    verbatim_recall10: avg(results.map((r) => r.verbatim_recall10)),
    verbatim_hit_rate: avg(results.map((r) => (r.verbatim_hit ? 1 : 0))),
    extracted_recall5: avg(results.map((r) => r.extracted_recall5)),
    extracted_recall10: avg(results.map((r) => r.extracted_recall10)),
    extracted_hit_rate: avg(results.map((r) => (r.extracted_hit ? 1 : 0))),
  };

  // ─── Print Report ─────────────────────────────────────────────────

  console.log('## LongMemEval Results — neuromcp v0.8.0\n');
  console.log('### Verbatim Mode (FTS5)\n');
  console.log('| Type | N | R@5 | R@10 | Hit Rate |');
  console.log('|------|---|-----|------|----------|');
  for (const m of typeMetrics) {
    console.log(`| ${m.type} | ${m.count} | ${(m.verbatim_recall5 * 100).toFixed(1)}% | ${(m.verbatim_recall10 * 100).toFixed(1)}% | ${(m.verbatim_hit_rate * 100).toFixed(1)}% |`);
  }
  console.log(`| **${overall.type}** | **${overall.count}** | **${(overall.verbatim_recall5 * 100).toFixed(1)}%** | **${(overall.verbatim_recall10 * 100).toFixed(1)}%** | **${(overall.verbatim_hit_rate * 100).toFixed(1)}%** |`);

  console.log('\n### Extracted Mode (Hybrid Vector + FTS + Graph)\n');
  console.log('| Type | N | R@5 | R@10 | Hit Rate |');
  console.log('|------|---|-----|------|----------|');
  for (const m of typeMetrics) {
    console.log(`| ${m.type} | ${m.count} | ${(m.extracted_recall5 * 100).toFixed(1)}% | ${(m.extracted_recall10 * 100).toFixed(1)}% | ${(m.extracted_hit_rate * 100).toFixed(1)}% |`);
  }
  console.log(`| **${overall.type}** | **${overall.count}** | **${(overall.extracted_recall5 * 100).toFixed(1)}%** | **${(overall.extracted_recall10 * 100).toFixed(1)}%** | **${(overall.extracted_hit_rate * 100).toFixed(1)}%** |`);

  // ─── Comparison with MemPalace ────────────────────────────────────

  console.log('\n### Comparison\n');
  console.log('| System | R@5 | R@10 | Hit Rate |');
  console.log('|--------|-----|------|----------|');
  console.log(`| MemPalace (claimed) | 96.6% | — | — |`);
  console.log(`| neuromcp verbatim | ${(overall.verbatim_recall5 * 100).toFixed(1)}% | ${(overall.verbatim_recall10 * 100).toFixed(1)}% | ${(overall.verbatim_hit_rate * 100).toFixed(1)}% |`);
  console.log(`| neuromcp extracted | ${(overall.extracted_recall5 * 100).toFixed(1)}% | ${(overall.extracted_recall10 * 100).toFixed(1)}% | ${(overall.extracted_hit_rate * 100).toFixed(1)}% |`);

  // Save results
  const outputPath = resolve(import.meta.dirname, 'longmemeval/results.json');
  writeFileSync(outputPath, JSON.stringify({ overall, typeMetrics, results }, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
