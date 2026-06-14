/**
 * synthesize.ts — deterministic, LLM-free answer synthesis with citations and
 * gap-analysis. This is the "GBrain-style" recall the audit flagged as
 * missing: instead of returning raw chunks, return a cited extractive answer
 * PLUS an explicit statement of what memory does NOT contain and the
 * staleness boundary — and say "not in memory" rather than fabricate when
 * nothing matched.
 *
 * The synthesis is EXTRACTIVE (selects real sentences from real memories), so
 * every claim traces to a stored memory id — no hallucination surface. The
 * calling agent can render the prose; the structured citations + gaps let it
 * (and the user) verify and see the boundaries.
 */
import type { MemoryWithScore } from '../types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';

export interface Citation {
  readonly text: string;
  readonly memory_id: string;
  readonly created_at: string;
}

export interface SynthesisResult {
  readonly status: 'answered' | 'not_in_memory';
  /** Extractive prose answer, or null when nothing matched. */
  readonly answer: string | null;
  /** One entry per answer sentence → the memory it came from. */
  readonly citations: readonly Citation[];
  /** The source memories that backed the answer, best-scored first. */
  readonly sources: ReadonlyArray<{ id: string; created_at: string; score: number }>;
  /** Explicit "what this does NOT cover" notes — never fabricate; flag gaps. */
  readonly gaps: readonly string[];
  /** Most recent source date — the freshness boundary ("nothing newer than this"). */
  readonly stale_since: string | null;
}

interface Sentence {
  readonly text: string;
  readonly memoryId: string;
  readonly createdAt: string;
}

const MS_PER_DAY = 86_400_000;

function splitSentences(content: string): string[] {
  return content
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15 && !s.startsWith('[session') && !s.startsWith('[meta]'));
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

/**
 * @param now millisecond timestamp for "today" — injectable for deterministic tests.
 */
export async function synthesizeAnswer(
  query: string,
  memories: readonly MemoryWithScore[],
  embedder: EmbeddingProvider,
  options: {
    maxSentences?: number;
    maxLength?: number;
    staleDays?: number;
    now?: number;
    relevanceFloor?: number;
  } = {},
): Promise<SynthesisResult> {
  const maxSentences = options.maxSentences ?? 5;
  const maxLength = options.maxLength ?? 700;
  const staleDays = options.staleDays ?? 30;
  const now = options.now ?? Date.now();
  // Minimum query↔sentence cosine for a match to count as an answer. Below
  // this the retrieved memories are off-topic noise — return not_in_memory
  // rather than synthesize a confident-but-irrelevant answer.
  const relevanceFloor = options.relevanceFloor ?? 0.3;

  const notInMemory = (reason: string): SynthesisResult => ({
    status: 'not_in_memory',
    answer: null,
    citations: [],
    sources: [],
    gaps: [reason],
    stale_since: null,
  });

  if (memories.length === 0) {
    return notInMemory(
      `No stored memory matched "${query}". It may never have been recorded, or may be phrased differently than the query.`,
    );
  }

  const sources = memories.map((m) => ({
    id: m.id,
    created_at: m.created_at,
    score: m.similarity_score,
  }));
  const staleSince = memories.reduce(
    (latest, m) => (m.created_at > latest ? m.created_at : latest),
    memories[0]!.created_at,
  );

  // Sentence inventory with citations preserved. `memories` arrives already
  // ordered by search relevance, so record each memory's rank to bias
  // sentence selection toward better-matched memories (a local embedder's
  // sentence-level cosine alone separates topics poorly).
  const memoryRank = new Map<string, number>();
  memories.forEach((m, i) => memoryRank.set(m.id, i));
  const sentences: Sentence[] = [];
  for (const mem of memories) {
    for (const text of splitSentences(mem.content)) {
      sentences.push({ text, memoryId: mem.id, createdAt: mem.created_at });
    }
  }

  const gaps: string[] = [];
  if (memories.length < 3) {
    gaps.push(`Thin coverage — only ${memories.length} memory(ies) matched; the answer may be incomplete.`);
  }
  const newestAgeDays = (now - new Date(staleSince).getTime()) / MS_PER_DAY;
  if (newestAgeDays > staleDays) {
    gaps.push(
      `Most recent matching memory is from ${staleSince.slice(0, 10)} (~${Math.round(newestAgeDays)} days ago) — newer information may not be captured.`,
    );
  }
  gaps.push(`Boundary: nothing is stored about this topic after ${staleSince.slice(0, 10)}.`);

  const queryEmbedding = await embedder.embed(query);

  if (sentences.length === 0) {
    // Memories matched but have no extractable sentences (very short content).
    // The content cosine is the only relevance signal here. Gate AND select on
    // PER-MEMORY content cosine — only memories whose own content clears the
    // floor are eligible to be cited. (Gating on the best cosine but then
    // slicing memories in retrieval order let a below-floor short memory get
    // cited when a different, above-floor memory opened the gate — the round-5
    // fallback mismatch. Same one-contract rule as the sentence path below.)
    const contentEmbeddings = await embedder.embedBatch(memories.map((m) => m.content));
    const contentCosines = contentEmbeddings.map((e) => cosine(queryEmbedding, e));
    const eligibleMemories = memories.filter((_, i) => contentCosines[i]! >= relevanceFloor);
    if (eligibleMemories.length === 0) {
      const best = contentCosines.reduce((m, c) => Math.max(m, c), 0);
      return notInMemory(
        `Nothing in memory is relevant enough to answer "${query}" (best match scored ${best.toFixed(2)} < ${relevanceFloor}). The topic may not have been recorded.`,
      );
    }
    // Cite the eligible memories (already in retrieval-relevance order).
    const cites: Citation[] = eligibleMemories.slice(0, maxSentences).map((m) => ({
      text: m.content.trim(),
      memory_id: m.id,
      created_at: m.created_at,
    }));
    const answer = cites.map((c) => c.text).join(' ');
    return {
      status: 'answered',
      answer: answer.length > maxLength ? answer.slice(0, maxLength - 3) + '...' : answer,
      citations: cites,
      sources,
      gaps,
      stale_since: staleSince,
    };
  }

  // Rank sentences by relevance to the QUERY (a question wants query-relevant
  // sentences, not corpus-central ones), then embedding-dedup. `queryEmbedding`
  // is already computed above — reuse it.
  const sentenceEmbeddings = await embedder.embedBatch(sentences.map((s) => s.text));
  const scored = sentences.map((s, i) => {
    const rank = memoryRank.get(s.memoryId) ?? 0;
    // Gentle decay: nudges sentences from lower-ranked (less relevant)
    // memories down without nuking genuinely-relevant ones.
    const memWeight = 1 / (1 + 0.25 * rank); // rank 0 → 1.0, rank 3 → 0.57
    const rawCosine = cosine(queryEmbedding, sentenceEmbeddings[i]!);
    return {
      ...s,
      embedding: sentenceEmbeddings[i]!,
      rawCosine,
      score: rawCosine * memWeight,
    };
  });

  // Relevance gate AND answer selection share ONE contract on the sentence
  // path: a sentence is eligible to appear in the answer iff its OWN query
  // cosine clears the relevanceFloor. `eligible` is that set.
  //
  // Why a single contract: the gate used to open on the single best sentence
  // (or the whole-content cosine), but selection then ranked by
  // rawCosine·memWeight and always kept the top candidate — so a DIFFERENT,
  // below-floor off-topic sentence with a higher memWeight could win and be
  // returned (the round-4 fabrication). Filtering to `eligible` first makes
  // that impossible: nothing below the floor can ever be selected.
  //
  // A long mixed memory whose one relevant sentence clears the floor is still
  // answered (that sentence is eligible). The whole-content cosine is NOT used
  // to rescue the sentence path — it only gates the no-sentence fallback above,
  // where there are no sentences to score. If no single sentence clears the
  // floor here, we conservatively say not_in_memory rather than answer from a
  // below-floor sentence.
  const bestSentenceCosine = scored.reduce((m, s) => Math.max(m, s.rawCosine), 0);
  const eligible = scored.filter((s) => s.rawCosine >= relevanceFloor);
  if (eligible.length === 0) {
    return notInMemory(
      `Nothing in memory is relevant enough to answer "${query}" (best match scored ${bestSentenceCosine.toFixed(2)} < ${relevanceFloor}). The topic may not have been recorded.`,
    );
  }

  eligible.sort((a, b) => b.score - a.score);

  // Among the eligible sentences, drop those far below the most-relevant one
  // (relative 0.45× the top score, small absolute guard) for answer focus.
  const topScore = eligible[0]!.score;
  const floor = Math.max(0.1, 0.45 * topScore);

  const selected: typeof eligible = [];
  for (const cand of eligible) {
    if (selected.length >= maxSentences) break;
    if (cand.score < floor && selected.length > 0) break; // keep at least the best one
    const dup = selected.some((s) => cosine(s.embedding, cand.embedding) > 0.9);
    if (!dup) selected.push(cand);
  }

  const citations: Citation[] = selected.map((s) => ({
    text: s.text,
    memory_id: s.memoryId,
    created_at: s.createdAt,
  }));
  let answer = citations.map((c) => c.text).join(' ');
  if (answer.length > maxLength) answer = answer.slice(0, maxLength - 3) + '...';

  return {
    status: 'answered',
    answer,
    citations,
    sources,
    gaps,
    stale_since: staleSince,
  };
}
