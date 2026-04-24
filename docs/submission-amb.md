# AMB Leaderboard Submission — neuromcp v7

> Prepared 2026-04-24. Run in progress (PID in `/tmp/v7-500.pid`).
> Targets: `vectorize-io/agent-memory-benchmark` repo PR when run completes.

## Result file path (will be produced by the harness)

```
outputs/longmemeval/neuromcp-opus-v7-500/rag/s.json
```

## Submission PR spec

### Target repo

<https://github.com/vectorize-io/agent-memory-benchmark>

### Branch name

`submit/neuromcp-opus-v7-longmemeval-s`

### Files to add / modify

1. **New**: `outputs/longmemeval/neuromcp-opus-v7-500/rag/s.json.gz` — gzip'd to match the
   convention used by other accepted entries (hindsight, hybrid-search).

2. **Optional**: append a short paragraph to any README/leaderboard doc that
   lists entrants. Do NOT modify other providers' files.

### PR title

```
Add neuromcp v7 — LongMemEval-S — Sovereign Memory MCP server
```

### PR body (paste-ready)

```markdown
## Summary

Adds a LongMemEval-S result for **neuromcp v7**, a local-first MCP memory
server. Sovereign Memory design — all data in SQLite on the user's disk,
no cloud calls during ingest, retrieval, or answer generation.

## Configuration

| Field | Value |
|---|---|
| Memory provider | neuromcp |
| Mode | rag |
| Split | longmemeval-s |
| Sample | n=500 (full split) |
| Answer LLM | Claude Opus (via Claude CLI) |
| Judge LLM | Claude Opus (same CLI) |
| Temperature | default (Claude CLI does not expose temperature) |
| Retrieval | hybrid: BM25 + sqlite-vec + graph + usefulness prior + BGE-reranker-v2-m3 rerank |
| k | 100 pre-rerank, 30 post-rerank |
| Entity extraction | regex (default). LLM-based entity extraction available as opt-in (`NEUROMCP_LLM_ENTITIES=1`), not used for this submission. |
| Session summary | NOT enabled for this submission (default regex path) |

## Why this is comparable to existing entries

- Same dataset, same split, same `omb run` harness.
- Same judge methodology (LLM judge, per-category prompts).
- n=500 matches hindsight's 473/500 submission.
- Fully reproducible with the command below.

## Reproduction command

```bash
OMB_ANSWER_LLM=claude OMB_ANSWER_MODEL=opus \
OMB_JUDGE_LLM=claude OMB_JUDGE_MODEL=opus \
NEUROMCP_K=100 NEUROMCP_TEMPORAL_CHRONO=1 \
NEUROMCP_RERANK=1 NEUROMCP_RERANK_KEEP=30 \
NEUROMCP_STARTUP_TIMEOUT=180 \
uv run omb run \
  --dataset longmemeval -s s -m neuromcp \
  -n neuromcp-opus-v7-500 \
  --description "v7 full 500q"
```

Requires `neuromcp` npm install (`npm install -g neuromcp`) and the Claude
CLI (`claude`) in `$PATH`.

## Known limitations

- **Stochasticity**: the Claude CLI does not expose a temperature or seed
  flag, so identical inputs may produce slightly different outputs across
  runs (observed ±1pp noise on the n=102 sample). This is documented in
  the harness `claude_cli.py`.
- **Judge = generator**: using Opus as both answer model AND judge is an
  unusual choice. Our rationale: when we swapped the judge between Sonnet
  and Opus on an earlier run, Opus was stricter on temporal-reasoning
  questions and closer to the gold-standard human rating. The judge choice
  does not invalidate the result but is worth disclosing.

## Repo + license

- Source: <https://github.com/AdelElo13/neuromcp>
- npm: <https://www.npmjs.com/package/neuromcp>
- License: AGPL-3.0 (engine) + MIT (templates/CLI carve-out)

## Contact

Maintainer: AdelElo13 (GitHub). Issues and questions on the neuromcp repo.
```

## Pre-submit checklist

- [ ] 500q v7 run completes without errors (monitor `/tmp/v7-500.log`)
- [ ] `s.json` renders a non-zero accuracy (sanity: >0%)
- [ ] Gzip the output file to match existing convention (`gzip -k s.json`)
- [ ] Fork `vectorize-io/agent-memory-benchmark`
- [ ] Create branch `submit/neuromcp-opus-v7-longmemeval-s`
- [ ] Copy `s.json.gz` into `outputs/longmemeval/neuromcp-opus-v7-500/rag/`
- [ ] Open PR with the body above
- [ ] Link to neuromcp commit SHA used in the run

## If result regresses

If the full 500q score drops below the 102q sample (expected — smaller
samples overstate), do NOT hide it:

- Still submit, with the honest number.
- Include the 102q sample as "validation subset" in the PR description.
- File follow-up work in neuromcp repo for the regression categories.

"Honest number loses" beats "no number with spin" for benchmark credibility.
