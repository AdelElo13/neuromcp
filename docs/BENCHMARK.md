# Reproducing neuromcp's benchmark numbers

Vendor-run memory benchmarks are a mess: LoCoMo scores that don't
reproduce, "95%" claims that turn out to be Recall@15 instead of answer
accuracy, harnesses nobody can run. neuromcp's position: **every number
we publish comes with the exact command, the sample size, and a
confidence interval** — run it yourself and call us out when it doesn't
reproduce.

## What we claim, precisely

| Claim | Metric | Sample | Where it comes from |
|-------|--------|--------|---------------------|
| LongMemEval-S **96.08%** | end-to-end answer accuracy (LLM judge) | n=102 (17 × 6 categories) | Opus generator + Opus judge, single-model run |
| Distractor R@5 **93.3%** at 500 distractors | retrieval recall@5 | n=30 | local harness in this repo, Ollama nomic-embed-text |

Honesty notes, up front:

- **n=102 is not n=500.** Wilson 95% CI for 98/102 ≈ 90.5–98.7%. A full
  500-question run with the same config is the milestone before any
  "top-tier" claim. LongMemEval-S is also saturating across the field
  (several systems report 90–96%), so treat small deltas between systems
  as noise.
- **Accuracy ≠ recall.** Our 96.08% is end-to-end answer accuracy. Some
  vendors headline retrieval recall (e.g. "R@15") — a different, easier
  metric. Compare like with like.
- **The judge matters.** Same retrieval with a different judge model
  shifts scores by whole points. We publish the judge (`Opus`) with the
  number.

## Reproduce: distractor retrieval benchmark (runs locally, ~minutes)

The distractor split answers the question that oracle benchmarks dodge:
does retrieval still find the right memory when it competes with real
noise?

```bash
# prerequisites: Ollama running with nomic-embed-text pulled
ollama pull nomic-embed-text

# 5 questions × 200 distractors (fast sanity check, ~2 min)
npx tsx eval/longmemeval-distractor-runner.ts --limit 5 --distractors 200

# the published row: 30 questions × 500 distractors
npx tsx eval/longmemeval-distractor-runner.ts --limit 30 --distractors 500
```

Each question's gold memory is buried among distractor memories drawn
from other questions' haystacks, then retrieved through the full hybrid
ranker (BM25 + vector + graph + usefulness prior). The runner prints
R@5, R@10 and MRR with per-question detail.

This is also the per-PR regression gate: `--limit 5 --distractors 200`
must not regress against the previous release before any retrieval
change merges (see CLAUDE.md).

## Reproduce: LongMemEval-S end-to-end accuracy

The full end-to-end run (ingest → retrieve → answer → judge) uses the
[agent-memory-benchmark](https://github.com/AdelElo13/agent-memory-benchmark)
harness ("omb"), which ingests the LongMemEval-S dataset into a fresh
neuromcp instance and grades answers with an LLM judge:

```bash
OMB_ANSWER_LLM=claude OMB_ANSWER_MODEL=opus \
OMB_JUDGE_LLM=claude OMB_JUDGE_MODEL=opus \
uv run omb run --dataset longmemeval -s s -m neuromcp \
  -c "single-session-user,single-session-assistant,multi-session,temporal-reasoning,knowledge-update,single-session-preference" \
  --query-limit 17
```

Requirements: the LongMemEval-S dataset (see the harness README for the
download), Ollama with `nomic-embed-text`, and Claude CLI access for the
generator/judge. Expect judge costs — this is not a free run.

## Local fixture suite (CI-grade, no LLM)

```bash
npm run eval            # runs eval/runner.ts against eval/fixtures/
```

Deterministic retrieval fixtures (basic recall, cross-namespace,
governance) with a committed baseline in `eval/baseline.json`. CI-safe:
no network, no LLM, no flakiness.

## What we do NOT claim

- No "state of the art" or "better than X" claims — nobody has published
  head-to-head numbers on a shared corpus + embedder, including us.
- The 1000-distractor row in the README is n=5: directionally positive,
  statistically underpowered, labeled as such.
- Benchmarks measure retrieval and single-question answering — not
  long-horizon memory *management* (see Letta's filesystem-baseline
  critique, which we think is a fair point against the whole category).
