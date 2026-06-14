/**
 * recall-answer.ts — the synthesis recall path. Runs hybrid retrieval, then
 * produces a cited extractive answer + gap-analysis (synthesize.ts) instead
 * of returning raw chunks. Deterministic and LLM-free; local-first.
 */
import type { MemoryWithScore } from '../types.js';
import { searchMemory, type SearchDeps } from './search.js';
import { synthesizeAnswer, type SynthesisResult } from '../cognitive/synthesize.js';

export interface RecallAnswerInput {
  readonly query: string;
  readonly namespace?: string;
  /** How many memories to synthesize over (default 8). */
  readonly limit?: number;
  readonly category?: string;
  readonly after?: string;
  readonly before?: string;
  readonly valid_at?: string;
  /** Max sentences in the synthesized answer (default 5). */
  readonly max_sentences?: number;
}

export async function recallAnswer(
  input: RecallAnswerInput,
  deps: SearchDeps,
  options: { now?: number } = {},
): Promise<SynthesisResult> {
  const memories = (await searchMemory(
    {
      query: input.query,
      namespace: input.namespace,
      limit: input.limit ?? 8,
      category: input.category,
      after: input.after,
      before: input.before,
      valid_at: input.valid_at,
      hybrid: true,
      explain: false,
    },
    deps,
  )) as readonly MemoryWithScore[];

  return synthesizeAnswer(input.query, memories, deps.embedder, {
    maxSentences: input.max_sentences,
    now: options.now,
  });
}
