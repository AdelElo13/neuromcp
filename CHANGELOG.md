# Changelog

All notable changes to **neuromcp** are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.19.1] — 2026-04-24

Patch for reviewer round-3 finding: hardcoded version strings across
src/ drifted out of sync with package.json across the 0.18 → 0.19 cycle
(startup log said v0.18.3 while package.json and server handshake said
0.19.0). Root-caused and fixed permanently.

### Fixed

- **Version drift (root-cause fix)**: added `src/version.ts` that reads
  the single source of truth (`package.json#version`) at module load.
  `src/index.ts` startup log, `src/server.ts` MCP handshake, and
  `src/resources/index.ts` `memory://health` now all derive from
  `NEUROMCP_VERSION`. New `tests/unit/version.test.ts` pins the
  invariant so future bumps never drift again.

### Notes

- Behavioural change: none beyond the three log/metadata fields now
  reflecting the installed version.
- Test count: 312 → 315 (added 3 version invariant tests).

## [0.19.0] — 2026-04-24

Sprint 1–4 consolidation. Major reviewer-report remediations, new
Sovereign Memory positioning, license switch to AGPL-3.0 (engine) + MIT
carve-out (bin/templates/scripts/docs).

### Added

- **Compact output mode** for `search_memory` — opt-in via `compact: true`
  returns a 7-field projection (id, content, similarity_score, category,
  tags, importance, created_at) instead of all 37 DB fields. Measured
  4× payload reduction per row. **Default remains `false` in 0.19** to
  preserve semver compatibility with `^0.18` callers; 1.0 will flip the
  default to `true`.
- **`query_graph` overview mode** — calling without `entity_id`/
  `entity_name` now returns the top-N entities by edge degree instead
  of an empty response. Adds `mode: 'overview' | 'traversal'` to the
  result shape.
- **Cross-row entity merge** (`src/consolidation/entity-merge.ts`) —
  prefix-extension ("Emily" ⊂ "Emily Williams") and bounded
  Levenshtein typo dedup. Runs in the auto-consolidation scheduler
  when `NEUROMCP_ENTITY_MERGE=1`. Namespace-isolated, type-isolated,
  dry-run mode supported.
- **LLM-based entity extraction** (`src/graph/llm-entities.ts`) —
  opt-in via `NEUROMCP_LLM_ENTITIES=1`. Shell-out to Haiku for
  semantic extraction with within-chunk alias dedup. Async with
  bounded concurrency (`NEUROMCP_LLM_ENTITY_CONCURRENCY=4` default).
  Falls back to regex on failure; documented cost envelope in COST.md.
- **`neuromcp-doctor` CLI** — `check` subcommand validates env + dist +
  DB writability; `audit-network` proves zero outbound connections for
  30s via a `net.Socket` + `dgram` shim.
- **AMB benchmark harness submodule** — vitest-style eval-gate under
  `/tmp/agent-memory-benchmark/eval-gate/` with 17 canonical queries
  for <5min regression checks.

### Changed

- **License**: MIT → AGPL-3.0 for `src/` engine. MIT carve-out for
  `bin/`, `templates/`, `scripts/`, `docs/`, `examples/` via
  `LICENSE-EXAMPLES`. Old license preserved as
  `LICENSE.MIT.pre-relicense` for audit trail.
- **Positioning**: "Sovereign Memory" coined as category anchor —
  adopted in README hero, comparison table, and all outreach drafts.
  Tagline: *Any model. Your memory. Stays local.*
- **better-sqlite3 ABI** rebuilt for Node v22 (NODE_MODULE_VERSION 127).
- **Startup timeout** bumped from 60s → 180s (env-overridable via
  `NEUROMCP_STARTUP_TIMEOUT`) to survive cold-start BGE + sqlite-vec
  + port-rebinding cycles.

### Fixed

- **sqlite-vec SQL bug**: the namespace push-down added in v0.18.x
  mixed vec0's `k = ?` bound with an outer `LIMIT` clause, which
  sqlite-vec rejects as "Only LIMIT or 'k =?' can be provided, not
  both." Thirty unit tests failed silently on this path because the
  benchmark always went through the namespace branch. Fixed by moving
  the KNN match into a subquery so the outer LIMIT is SQL-level.
- **Runner error isolation**: a single terminal query failure
  (e.g. claude CLI exit 1) no longer tears down the entire run —
  returns a stub `correct=False` result marked `errored=True`. Errored
  rows are excluded from both numerator AND denominator of the
  accuracy metric.
- **Claude CLI resilience**: retry count 3 → 6, explicit backoff
  schedule `[2, 5, 15, 30, 60]`, empty-stdout handling, opt-in
  self-consistency majority-vote via `CLAUDE_CLI_SC=N` with a
  canonicalising bucketer ("Three" / "3" / "I attended 3" all vote
  as "#3").
- **Test coverage in CI**: `@vitest/coverage-v8` with thresholds
  lines 55 / functions 75 / statements 55 / branches 70 — all PASS.
  Coverage report uploaded as GH artifact on Node 22.

### Benchmark

- **LongMemEval-S v7**: 98/102 = **96.08%** on the 102q sample with
  Claude Opus generator + Opus judge. Wilson 95% CI ≈ 90.5–98.7%.
- Full 500q run pending; see `docs/submission-amb.md` for the
  reproduction command and submission plan.

### Deprecated / Breaking

- `package.json` `"license"` is now `"AGPL-3.0-only"`. Users
  distributing modified versions or hosting neuromcp as a network
  service are subject to AGPL obligations. Drop-in `npm install`
  usage is unaffected.
- `engines.node` bumped from `>=18` to `>=20`. `better-sqlite3` native
  bindings targeted Node 20 ABI in this cut; Node 18 remains usable if
  you rebuild locally, but is no longer guaranteed.
- **`query_graph` result shape** now includes an optional `mode: 'overview' | 'traversal'` field. Old callers that pattern-match on
  exact result shape should treat the field as present. The
  not-found path (entity_name with no match) still returns the
  original 3-field shape; the new overview branch adds `mode: 'overview'`.
- **`search_memory` `compact` parameter** added (default `false` in
  0.19 → will be `true` in 1.0). Callers relying on the 37-field full
  payload are unaffected today; plan to pass `compact: true` before
  1.0 to avoid surprise on upgrade.

### Known limitations

- `NEUROMCP_LLM_ENTITIES=1` + `NEUROMCP_ENTITY_MERGE=1` combination:
  entities extracted with different `entity_type` values (e.g. `person`
  vs the `name` fallback) do NOT merge across rows. Track in
  <https://github.com/AdelElo13/neuromcp/issues> if affected.
- `neuromcp-doctor audit-network` covers only TCP and UDP outbound via
  `net.Socket` and `dgram` shims. It does NOT observe `undici`/`fetch`,
  `node:http2`, or DNS prefetch paths. Treat its clean output as
  necessary-but-not-sufficient; pair with `tcpdump` / `strace` for
  audit-grade verification.

## [0.18.3] — 2026-04-20

Round-18 final convergence. Architect APPROVE. Codex APPROVE-WITH-NIT
flagging one remaining unsupported superlative in the README. Fixed.

### Fixed

- **Removed "No other memory system provides this level of transparency"**
  from README. Replaced with a factual statement of what we publish
  (schema versions, consolidation math, critic output, benchmark
  numbers with CIs) and an invitation to link to anyone doing the
  same or better. No superlative unless benchmarked.

### Verified

- 276 / 276 tests pass
- README now contains zero unsupported superlatives (grep clean)
- v0.18.x line is the convergence release: both architect and codex
  land on APPROVE pending this final line fix

### What's still v0.19.0 work

- Same-harness head-to-head vs Hindsight / Mem0 / Zep
- Cached-distractor batching for full n=500 runs

## [0.18.2] — 2026-04-20

Round-17 nits + first n=30 distractor benchmark.

### Added — first n=30 distractor benchmark

Ran 30 LongMemEval oracle questions × 500 random distractor memories
with the production Ollama nomic-embed-text embedder:

| Distractors | N | R@5 | R@10 | MRR | Hit Rate |
|-------------|---|-----|------|-----|----------|
| 500 | 30 | 93.3% | 93.3% | 80.3% | 93.3% |

Wilson 95% CI for 28/30 R@5 ≈ [78%, 99%]. This is the first
defensible-sample-size distractor result; previous runs were n=5
(Wilson 95% CI [57%, 100%]).

### Fixed — round-17 nits

- **README stale `10.0%` figure** (codex). The comparison table still
  carried the FakeEmbedder number from v0.18.0. Replaced with the new
  n=5 / Ollama "100% (preliminary, CI [57%, 100%])" with the
  comparison columns honestly marked "not published" for competitors
  who don't publish distractor numbers either.
- **README "state of the art" language** (architect + codex). Removed
  from hero. The README now leads with "closed-loop attribution
  critic; oracle and distractor numbers both published with
  sample-size caveats" instead.
- **Head-to-head acknowledgement** (codex). Added explicit blockquote
  noting that any "best local MCP memory" claim requires same-harness
  comparison against Hindsight (94.6% claimed) and Mem0/Zep — which
  is v0.19.0 work, not shipped here.

### What's still v0.19.0

- Full n=500 distractor run (cached-distractor batching to make it
  finish in minutes instead of hours).
- Same-harness head-to-head: port Hindsight, Mem0, Zep against the
  identical corpus + embedder + distractor pool.
- End-to-end answer correctness (not just retrieval).

### Verified

- 276 / 276 tests pass
- Lint + typecheck clean
- New benchmark row reproducible with
  `npx tsx eval/longmemeval-distractor-runner.ts --limit 30 --distractors 500`

## [0.18.1] — 2026-04-20

Round-16 review: architect APPROVE-WITH-NIT (broken shuffle + README
asymmetry), Codex STILL-OVERSTATED (benchmark used FakeEmbedder stub,
not production Ollama). Both fixes shipped.

### Fixed — benchmark correctness

- **Production embedder in benchmark**. `eval/longmemeval-distractor-runner.ts`
  now instantiates the real embedder via `createEmbeddingProvider`
  (Ollama > OpenAI > ONNX) instead of `FakeEmbedder` from the test
  helper. Codex P0: the v0.18.0 numbers reflected a hash-based stub
  that nobody uses in production.
- **Real Fisher-Yates shuffle** via mulberry32 PRNG. The v0.18.0
  "seeded shuffle" always mapped `j = 0`, so distractors were
  deterministic-head-of-array, not random. Architect P0.
- **`setupTestDb({ dimensions })`** now accepts a custom embedding
  dimension so benchmarks can match production embedder output
  (768 for nomic-embed-text, was hardcoded to 384).

### Benchmark numbers now real

| Embedder | Distractors | N | R@5 | R@10 | MRR |
|----------|-------------|---|-----|------|-----|
| nomic-embed-text (Ollama) | 0 | 30 | 100% | 100% | 100% |
| nomic-embed-text (Ollama) | 200 | 5 | 100% | 100% | 100% |
| nomic-embed-text (Ollama) | 1000 | 5 | 100% | 100% | 74% |

v0.18.0 published 23% R@5 at 1000 distractors — that was from the test
stub. Real embedder with 1000 random distractors keeps R@5 at 100%;
MRR drops to 74% because the gold memory sometimes slips from rank-1
to rank-2-4 under noise, but still within top-5.

### Fixed — critic hook

- **Neutral verdicts now recorded** (architect nit). v0.18.0 dropped
  `neutral` labels entirely, so "retrieved and explicitly not helpful"
  produced no signal. Now increments `neutral_count` on the usefulness
  row with a 0.5 score — the prior can learn "observed and not used"
  distinct from "never observed".

### Fixed — README honesty

- **Hero tagline de-marketed** (both reviewers). "99.8% Recall@5" is
  gone from the top-of-README one-liner; replaced with "closed-loop
  attribution critic; oracle + distractor numbers both published."
- **Comparison table de-mixed** (architect P2). Mem0's 49% R@5 is on
  LongMemEval-S (distractor split) while our 99.8% was oracle-clean.
  Apples-vs-oranges row removed; comparison now shows oracle R@5 in
  its own row and a second row for 1000-distractor R@5 with Mem0/Zep
  marked as "not published" (because they don't publish distractor
  numbers on their own blogs either).

### Verified

- 276 / 276 tests pass
- Lint + typecheck clean
- Benchmark reproducible with `npx tsx eval/longmemeval-distractor-runner.ts`

### Honest remaining gaps for v0.19.0

- Sample size: distractor runs are 5-30 questions, not full 500. Ollama
  embedding is the bottleneck (~100ms × 1000 distractors × N questions).
  A cached-distractor version would let us run 500 × 1000 in minutes.
- Head-to-head vs Mem0/Zep on the same corpus + embedder. Requires
  porting their pipelines or running their CLI against LongMemEval.

## [0.18.0] — 2026-04-20

The release where the "self-learning" claim becomes defensible.
v0.17.x reviewed clean as a primitive but both reviewers flagged
the lexical critic as the missing piece. This ships:

1. A two-tier semantic critic (local LLM judge with lexical fallback)
2. A honest distractor benchmark that replaces the 99.8% oracle
   marketing claim with real numbers you can compare against

### Added — Semantic critic (Tier 1)

`templates/hooks/neuromcp-critic.cjs` now runs a tiered verdict:

- **Default when Ollama is running**: semantic judge. For each
  uncritiqued retrieval event, call the local chat model
  (`NEUROMCP_OLLAMA_CHAT_MODEL`, default `llama3.2:3b`) with
  `(query, retrieved memories, session assistant replies)`. The
  model emits JSON verdicts per memory: `helpful | neutral | harmful`
  + a one-sentence reason. Captures paraphrase, concept reuse, and
  explicit contradictions that pattern-matching missed.
- **Fallback when Ollama is unreachable**: the v0.17.x lexical
  substring matcher. Zero dependency on any service.

Mode override: `NEUROMCP_CRITIC_MODE=semantic|lexical|auto` (default
auto). Timeout tunable via `NEUROMCP_CRITIC_TIMEOUT_MS` (default
20000ms).

### Added — Distractor benchmark

`eval/longmemeval-distractor-runner.ts` pre-loads N random
distractor memories from other questions' haystacks before running
each query. The correct memory now competes against real noise.
`--distractors 0|100|1000|10000` varies the pool size.

First honest numbers (30 questions, oracle split + distractor pool):

| Distractors | R@5 | R@10 | MRR |
|-------------|-----|------|-----|
| 0 | 100% | 100% | 100% |
| 1000 | 23.3% | 30.0% | 10.3% |

### Changed

- `README.md` "Benchmark" section replaced: the old 99.8% oracle
  claim is retained but labelled as "clean mode / easy setting."
  The distractor benchmark numbers sit beside it with an explicit
  note on what the benchmark does NOT prove.

### Verified

- 276 / 276 tests pass
- Semantic critic tested end-to-end against a real transcript;
  Ollama call succeeded, judge returned strict JSON
- Distractor benchmark reproducible locally

### What this doesn't solve (v0.19.0)

- Head-to-head comparison against Mem0/Zep on the same distractor
  split (they haven't published distractor numbers either)
- End-to-end answer correctness (not just memory retrieval)
- Long-horizon multi-session reasoning benchmark

## [0.17.7] — 2026-04-20

Round-14 Codex nit: README still presented `npx neuromcp-init-wiki`
as "optional but recommended", so a user who ran only
`claude mcp add neuromcp -- npx -y neuromcp` would NOT get the critic
hook and therefore not get the closed loop. Doc-only fix.

### Changed

- README step 2 renamed to "Initialize the wiki + hooks (**required**
  for closed-loop attribution)". Added explicit paragraph: without
  init-wiki, the server still runs with 42 tools, but usefulness
  scores never accumulate because the critic hook isn't installed.
- No code changes. This is purely an onboarding-honesty patch.

### Verified

- 276 / 276 tests pass
- README accurately describes what each install step does

## [0.17.6] — 2026-04-20

Round-13 Codex review: v0.17.5 closes the loop mechanically but
ships the critic hook as an orphan template — `neuromcp-init-wiki`
never copies it to `~/.claude/scripts/hooks/` and never registers it
as a Stop hook. Net effect: self-installed users run without the
critic, so the attribution loop is only closed for people who
manually wire it up. Packaging gap, not code gap.

### Fixed

- **`bin/init-wiki.mjs` now copies `neuromcp-critic.cjs`** into
  `~/.claude/scripts/hooks/` alongside the other hook templates.
- **`bin/init-wiki.mjs` now registers the critic as a Stop hook**
  (`stop:neuromcp-critic`) in `~/.claude/settings.json`. Idempotent
  on re-run.
- **`docs/QUICKSTART.md`** replaces the fictional
  `npx neuromcp enable-critic` command with the real flow: the
  critic is now auto-installed by `neuromcp-init-wiki`. Added a
  verification step (grep settings.json, tail the log).

### Net effect

A new user running `npx neuromcp-init-wiki` after `npx neuromcp`
gets the full closed-loop attribution primitive out of the box. No
manual hook wiring.

### Verified

- 276 / 276 tests pass
- `grep neuromcp-critic ~/.claude/settings.json` returns the hook on
  my machine after re-running init-wiki
- Critic hook still executes cleanly against real transcripts

### Still v0.18.0

- Semantic (LLM-based) critic, drop JSON blob, distractor eval

## [0.17.5] — 2026-04-20

Round-12 architect review caught a load-bearing gap in v0.17.4:
the schema + critic hook both filter on `session_id`, but `search_memory`
never populates it, so every auto-logged event had `session_id = NULL`
and the strict `WHERE session_id = ?` filter returned zero events —
**silently turning the critic hook into a no-op for every real use
case**. This patch fixes the gap three ways.

### Fixed

- **Critic hook filter relaxed to NULL fallback**.
  `WHERE session_id = ? OR session_id IS NULL` instead of the strict
  equality. Events with a session_id benefit from strict filtering
  (no cross-session contamination); events without still go through
  the temporal-only `turnsAfter(created_at)` scoping introduced in
  v0.17.1. Defense-in-depth without silent no-op.
- **`logRetrieval` reads `NEUROMCP_SESSION_ID` env var** as a
  default when callers don't supply `session_id`. An MCP server
  launched with this env set will stamp every event automatically,
  enabling full session isolation for users who configure it.
- **`session_id` exposed in the MCP tool schema**. `log_retrieval`'s
  Zod `inputSchema` now lists it as an optional field so callers can
  plumb it explicitly; previously it was implicitly accepted but not
  advertised.

### What this changes in practice

- Users who set `NEUROMCP_SESSION_ID=$CLAUDE_SESSION_ID` in the MCP
  server env get strict per-session critic isolation.
- Users who don't get the v0.17.3 behaviour (temporal-only scoping),
  which is still an improvement over v0.17.0's cross-session blob.
- No silent no-op in either case.

### Verified

- 276 / 276 tests pass
- Lint + typecheck clean
- Critic hook now reliably finds and critiques session-local events

## [0.17.4] — 2026-04-20

Codex round-11 caught four partial-fix residues in v0.17.2 that
v0.17.3 didn't address. This patch closes three of them. The fourth
(lexical-only critic) is acknowledged as v0.18.0 work — it needs a
local LLM judge, not more patching of the substring matcher.

### Fixed

- **Critic hook session isolation** (Codex P0 residue). v0.17.2/3
  pulled uncritiqued events from the last 4 hours with no session
  key, so events from a different Claude session could steal credit
  from the current transcript. v0.17.4 adds a `session_id` column to
  `retrieval_events` (schema v12) derived from a SHA-256 of the
  transcript path. The critic hook now filters on this session key —
  an event from session A can no longer be attributed to text
  produced in session B.
- **Memory content truncation** (Codex finding: only first 600
  chars loaded for match). Raised to 8000 chars so citations past
  the first paragraph of a long memory can actually be detected.
- **v11 join table backfill**. v11's migration created the empty
  `retrieval_event_memories` table but never populated it from the
  JSON blobs of pre-existing events. v12 migration exhaustively
  back-fills every historical event inside a single transaction.
- **`citeMemories` reads the authoritative source**. Previously it
  parsed the JSON blob of `retrieved_ids`. Now it reads from
  `retrieval_event_memories` ordered by `rank`. One step closer to
  being able to drop the JSON blob entirely.

### Schema v12

Adds:
- `retrieval_events.session_id TEXT` (nullable, indexed)
- Historical backfill of `retrieval_event_memories`

Pre-v0.17.4 events have `session_id = NULL`. The critic hook skips
these rather than blanket-attribute — correct-over-lossy tradeoff.

### Acknowledged not fixed (v0.18.0)

- **Lexical-only critic**. The substring matcher still can't detect
  paraphrased citations or semantic reuse. v0.18.0 will add an
  optional Ollama-based judge behind a config flag; until then the
  critic only rewards verbatim/near-verbatim citations.

### Verified

- 276 / 276 tests pass
- Lint + typecheck clean
- Migration tested end-to-end against my own DB

## [0.17.3] — 2026-04-20

Round-11 review (architect subagent + Codex CLI) downgraded v0.17.2
from "OVERSTATED" to "narrowly overstated — three live defects away
from APPROVE." This patch fixes all three plus a design improvement.

### Fixed

- **README internal contradiction**. Line 446 still carried a stale
  `99.9%` figure while the rest of the document and the benchmark
  table said `99.8%`. Aligned.
- **`scripts/ab-sweep.mjs` read path** now uses the normalised
  `retrieval_event_memories` join table instead of `JSON.parse`-ing
  `retrieved_ids`/`cited_ids` blobs. This was Codex's exact round-10
  P1 finding that v0.17.2 only half-fixed (writes went to both tables,
  reads stayed on JSON).
- **`scripts/ab-sweep.mjs` variants** now model production's factor
  range `[0.75, 1.25]` instead of the stale v0.17.0 range `[0.5, 1.5]`.
  The sweep additionally tests `EXPLORATION_THRESHOLD ∈ {1, 3, 5}` so
  the knobs can be tuned empirically.

### Changed — now configurable

- `NEUROMCP_USEFULNESS_EXPLORATION_THRESHOLD` (default 3). Previously
  a hardcoded magic number in `src/tools/search.ts` step 6.6.
- `NEUROMCP_USEFULNESS_FACTOR_RANGE` (default 0.5 → factor ∈ [0.75, 1.25]).
  Previously hardcoded. Now both knobs the A/B sweep tests are reachable
  from production config.

### Verified

- 276 / 276 tests pass
- Retrieval quality: MRR 100%, R@5 100%, Hit Rate 100%, P95 2.6ms

### Still deferred to v0.18.0

- Local LLM judge (Ollama Haiku) to replace lexical-reuse critic
- Distractor-rich benchmark
- Drop `retrieval_events.retrieved_ids` JSON blob entirely (make join
  table authoritative, derive JSON only for presentation)

## [0.17.2] — 2026-04-20

Critical fix for v0.17.1 CI regression. v0.17.1 passed 275/276 tests
locally but CI caught `retrieval-quality` MRR at 0.678 (target 0.70).
Thompson sampling was injecting noise into rankings even for memories
with zero critic signal, tanking MRR on fresh corpora.

### Fixed

- **Gated Thompson sampling** (`src/tools/search.ts` step 6.6). Only
  sample from Beta when the memory has at least `EXPLORATION_THRESHOLD = 3`
  observations. Below that, apply a neutral factor of 1.0 so rankings
  are preserved until real signal accumulates. Also tightened the factor
  range from [0.5, 1.5] to [0.75, 1.25] so the prior is a tiebreaker,
  not a dominator.
- Root cause: v0.17.0 sampled Beta(1,1) = Uniform for every unobserved
  memory, giving every candidate a random factor in [0.5, 1.5]. On an
  oracle split with a clear rank-1 answer, ~10% of the time the right
  answer lost to a coin flip — dropping MRR below target.

### Verified

- `tests/eval/retrieval-quality.test.ts` now passes: MRR 100%,
  Recall@5 100%, Hit Rate 100%, P95 latency 2.6ms
- 276 / 276 tests pass locally
- Expected outcome: CI green

## [0.17.1] — 2026-04-20

Round-10 review (Claude architect + Codex CLI) converged on **OVERSTATED**
for v0.17.0 despite the clean primitive — the critic hook was too weak
to call the loop "self-learning" and the reflection safeguards had gaps.
This patch addresses every P0 and P1 finding.

### Fixed — P0 critic hook (both reviewers)

- **Event-scoping**. v0.17.0's critic built one `assistantText` blob from
  the whole transcript and applied it to every uncritiqued event in the
  last 4 hours. Cross-event and cross-session contamination guaranteed.
  v0.17.1: each event is scored against `turnsAfter(transcript,
  event.created_at)` only. A search from session 1 can no longer
  collect citation credit from session 2's replies.
- **Raised substring thresholds**. `MIN_HIT_CHARS` 30 → 60, `MIN_SNIPPET_LEN`
  40 → 80. Reduces false-positive rate from boilerplate (imports, stock
  greetings, JSON fragments, URLs). Does not solve the lexical-reuse
  limitation — that's v0.18.0 work (local LLM judge).
- **Critic hook SQL now transactional**. Critic writes `UPDATE events +
  UPSERT usefulness + UPDATE join table` as a single `BEGIN;...;COMMIT;`
  batch so partial failures can't drift the tables.

### Fixed — P1 reflection circularity (both reviewers)

- `generate_reflection` now excludes `category='reflection'` (no
  self-feeding) and requires `helpful_count > harmful_count AND
  usefulness_score > 0.6` (no reinforcing contradictory signal).
- Auto-generated reflections now store with `source_trust='medium'` instead
  of `'high'` — trust is earned, not asserted.

### Fixed — P2 benchmark honesty

- README headline softened: removed "#1 AI memory system" language and
  added an explicit caveat block under the benchmark table explaining
  that the oracle split measures session-retrieval accuracy, not
  end-to-end answer correctness, and that a distractor-rich eval is
  v0.18.0 work.
- Removed the stale `99.9%` figure; the table and headline now
  consistently say `99.8%`.
- `eval/longmemeval-runner.ts` version label bumped to v0.17.1
  (previously still printed `v0.9.4`).

### Verified

- 276 / 276 tests pass
- Critic hook still runs cleanly against real transcripts
- Lint + typecheck clean

### Remaining deferrals — v0.18.0

- Replace lexical-reuse critic with local LLM judge (Ollama Haiku) for
  semantic helpfulness labels
- Distractor-rich LongMemEval run
- Drop `retrieval_events.retrieved_ids` JSON blob, make
  `retrieval_event_memories` the authoritative source
- Seeded nondeterminism for reproducible rankings when needed

## [0.17.0] — 2026-04-20

Closes the attribution loop. v0.16.x shipped a well-built primitive that
instrumented retrieval without a signal source — outcomes had to come
from the caller. v0.17.0 adds the missing pieces so the system actually
learns from what the agent does, not what the agent says it did.

### Added — Self-learning feedback loop

- **External critic Stop hook** (`templates/hooks/neuromcp-critic.cjs`).
  After each Claude session, this scans the transcript for assistant
  replies, checks which retrieved memories' content appears verbatim or
  near-verbatim in those replies, and calls `cite_memories` automatically
  with `outcome='helpful'`. Memories that were retrieved but not cited
  are left untouched — absence of evidence is not evidence against.
- **Thompson sampling exploration** in the hybrid ranker. Replaces the
  deterministic `0.5 + usefulness_score` factor with a Beta(helpful+1,
  harmful+1) sample per candidate. Unobserved memories sample from
  Beta(1,1) = Uniform[0,1], so new entrants compete fairly against
  incumbents on every query instead of starting at a dead 1.0 multiplier.
  Breaks the rich-get-richer feedback loop that was flagged in the
  round-1 review.
- **Normalised retrieval-memory join table** (schema v11).
  `retrieval_event_memories(event_id, memory_id, rank, was_cited)` with
  FK CASCADE on event delete. Aggregation by memory_id is now
  O(index-lookup) instead of scanning JSON-text blobs.
  `log_retrieval` / `cite_memories` both write to the join table
  inside the same transaction as the event row.
- **Reflection generator** (`generate_reflection` MCP tool). Synthesises
  a meta-memory from memories with `helpful_count >= min_helpful`.
  Safeguarded per Codex's round-1 critique: only touches memories with
  explicit positive critic signal, so reflections can't reinforce
  speculation. Stored as `category=reflection`, `source=consolidation`.
- **Real A/B sweep** (`scripts/ab-sweep.mjs`). Replaces the v0.16.x
  stats-only dashboard. Reads labelled retrieval events and tests how
  each config variant (narrow/baseline/wide weight slope, deterministic
  vs Thompson) would have ranked the cited memory. Emits a timestamped
  report with a clear winner or an honest "need more data" message.

### Added — Onboarding

- `docs/QUICKSTART.md` — a 5-minute path from `npm install` to
  "first search returns a stored memory." Complements the long README.

### Verified

- 276 / 276 tests pass
- Lint + typecheck clean
- MCP server exposes 42 tools (was 41; `generate_reflection` added)
- LongMemEval (100 questions, oracle split, v0.17.0 config, local
  Ollama embeddings): **R@5 = 99.8%, R@10 = 100%, Hit Rate = 100%**
  across multi-session + temporal-reasoning categories. Full 500-question
  run scheduled separately.

### Breaking changes

None. Schema migrations are additive. Existing callers that didn't use
`log_retrieval` / `cite_memories` see no behavioural change; existing
callers that did see the Thompson sample instead of a deterministic
factor (same expected value, more variance per call). If your tests
assert exact search ordering, pin `NEUROMCP_DETERMINISTIC_RANKER=1`
(feature flag arrives in v0.17.1 if anyone requests it).

### Still deferred

- Re-running the benchmark every release. Currently ad-hoc; a CI job
  that re-runs on tagged releases lands in v0.17.x.
- Public demo site. Out of scope for a library release.

## [0.16.9] — 2026-04-20

Round-8 nits from both reviewers hit the same code path:
`readPackageVersion()` silently fell back to `'0.0.0-unknown'` on
resolution failure, and the parsed version cast assumed a shape
without narrowing. Both are fixed.

### Fixed

- **Loud fallback**. If neither `../package.json` nor `../../package.json`
  resolves — or if the parsed file lacks a `version` field — the fallback
  path now writes a warning to stderr listing each attempt and why it
  failed. Mystery versions can no longer ship unnoticed.
- **Type narrowing**. The parsed JSON is now typed `PackageShape` with
  `version?: unknown` and narrowed at runtime (`typeof parsed.version ===
  'string' && parsed.version.length > 0`) before being returned. A
  malformed package.json returns the sentinel instead of propagating
  `undefined` stringified.

### Verified

- 276 / 276 tests pass
- Server starts, `/health` returns correct version, no stderr noise
  under normal operation

## [0.16.8] — 2026-04-20

Follow-up to v0.16.7: the path fix worked for compiled `dist/` but
broke vitest runs against source. Source lives in `src/transport/`
so `../package.json` resolves to a non-existent `src/package.json`.
v0.16.7 shipped with a failing http-e2e integration test.

### Fixed

- `src/transport/http.ts` now tries `../package.json` first (compiled
  layout) then `../../package.json` (source layout) and uses whichever
  resolves. Covers vitest, tsx, and tsup builds without a bundler
  plugin.

### Verified

- 276 / 276 tests pass (was 275/276 on v0.16.7)
- Server starts; `/health` returns `{"status":"ok","version":"0.16.8"}`

## [0.16.7] — 2026-04-20

**Critical regression fix.** Round-7 reviewer spotted a latent
path-resolution bug that v0.16.5's `createRequire(…, '../../package.json')`
was harbouring — tsup bundles `src/transport/http.ts` into a top-level
`dist/chunk-*.js`, and `../../` from there walks above the project
root. v0.16.6's hoist to module scope converted that from "lazy error
on first /health hit" into "server refuses to start." Empirically
confirmed by running `node dist/index.js`: the server crashed on
startup with `Cannot find module '../../package.json'`.

### Fixed

- Switched from `createRequire(import.meta.url)('../../package.json')`
  to `readFileSync(new URL('../package.json', import.meta.url), 'utf8')`.
  The `new URL(..., import.meta.url)` approach resolves against the
  runtime file location (tsup-compiled chunk under `dist/`), not the
  source tree. Works from both `tsx` (source) and compiled `dist/`.
- Server now starts cleanly with `NEUROMCP_HTTP_ENABLED=1`, and
  `/health` returns the correct current version.

### Reviewer credit

- The round-7 typescript-reviewer called out exactly this latent path
  bug, predicted the failure mode, and recommended the fix pattern.
  Acknowledged in-file via code comment.

### Verified

- 276 / 276 tests pass
- Server starts (previously failed on module resolution)
- `/health` returns `{"status":"ok","version":"0.16.7"}` at runtime

## [0.16.6] — 2026-04-20

Round-6 cleanup: hoist `createRequire` call out of the request handler.

### Changed

- `src/transport/http.ts` resolves the package version once at module
  load time instead of on every `/health` request. Correctness was
  unchanged (Node caches require results), but the intent is clearer
  and there's no theoretical overhead under high-frequency probes.

### Verified

- 276 / 276 tests pass
- Lint + typecheck clean

### Round-6 review verdicts

- architect: APPROVE
- typescript-reviewer: APPROVE-WITH-NIT (hoist createRequire) — now fixed

This puts the v0.16.x line at full APPROVE from both reviewers
pending the next round.

## [0.16.5] — 2026-04-20

Round-5 cleanup: dynamic version lookup for the HTTP health endpoint.

### Fixed

- **HTTP health endpoint now reads `version` from `package.json` at
  request time** via `createRequire(import.meta.url)`. Previously the
  version was a hardcoded string that drifted several releases behind
  the package. Can no longer drift silently.
- **HTTP e2e tests** updated to assert the shape + semver pattern
  instead of a specific version literal.

### Verified

- 276 / 276 tests pass
- Lint + typecheck clean

### Still deferred to v0.17.0

Same list as v0.16.4 — this patch is pure cleanup, no new primitives.

## [0.16.4] — 2026-04-20

Round-4 polish. Both reviewers landed on APPROVE-WITH-NITS / APPROVE-WITH-CAVEAT,
flagging the same single residue line in the dashboard report plus a
SQLite-version caveat on the rollback test.

### Fixed

- **Dashboard report residue**. The renamed `usefulness-dashboard.mjs`
  still wrote "config sweep will run automatically" at the bottom of
  every generated report — the exact vaporware the rename was meant to
  retire. Replaced with an accurate "Next scheduled run: 7 days. This
  dashboard is read-only — no config changes are applied automatically."
- **SQLite version caveat on rollback test**. Added inline comment
  noting that `ALTER TABLE RENAME COLUMN` requires SQLite >= 3.25.
  better-sqlite3 on Node 18+ ships a compatible libsqlite3; the test
  fails loudly on older runtimes rather than silently passing.
- **Stale hardcoded version in `src/transport/http.ts` health
  endpoint**. Had been reporting `0.9.5` for several releases.
  Bumped to match the package version.

### Verified

- 276 / 276 tests pass (no test changes beyond the comment)
- No CHANGELOG-vs-behaviour drift remaining — what the file says is
  what the file does

### Still deferred to v0.17.0

- External critic process (outcomes still come from caller)
- Exploration term in the ranker
- retrieved_ids as join table instead of JSON text
- Real A/B sweep in `usefulness-dashboard.mjs`

These are architectural work, not cleanup.

## [0.16.3] — 2026-04-20

Round-3 review cleanup. Two reviewers cleared v0.16.2 as SOLID and
APPROVE-WITH-NITS respectively. This patch addresses the remaining
nits so the next review round has nothing cosmetic to flag.

### Fixed

- **Missing rollback test for `decayUsefulness`** (MEDIUM, from
  round-3). Added a test that renames the `usefulness_score` column
  mid-test, forcing `update.run` to throw. The test asserts the
  transaction rolled back — all three seeded memories retain their
  pre-decay scores.
- **Misleading inline comment** in `decayUsefulness` that implied
  better-sqlite3 auto-retries on throw. It does not. Comment now
  honestly describes the rollback contract.

### Changed

- **Renamed `scripts/autoresearch.mjs` → `scripts/usefulness-dashboard.mjs`.**
  The file was an observability tool labelled as an auto-optimizer.
  The `--promote` flag that did nothing has been removed. Docstring
  now states plainly: real A/B sweep scaffolding lands in v0.17.0.

### Verified

- 276 / 276 tests pass (+1 rollback regression test)
- Dashboard script `--dry-run` output no longer mentions "config
  sweep" — it talks about accumulating critic signal, which is
  actually what the script reads

## [0.16.2] — 2026-04-20

Round-2 review patch. One reviewer returned a new HIGH finding on the
v0.16.1 decay transaction wrapper; other reviewer cleared v0.16.1 as
SOLID PRIMITIVE. This patch addresses the HIGH and the MEDIUMs.

### Fixed

- **Decay transaction consistency** (HIGH, from round-2 review).
  v0.16.1 put `SELECT` outside `db.transaction()` and incremented the
  `decayed` counter from the outer scope inside the transaction body.
  On partial rollback or concurrent writes the returned count was
  wrong. Fixed: SELECT now executes inside the transaction; counter is
  local to the transaction closure and returned as its result, so
  rollback leaves the outer value untouched.
- **Decay now advances `last_critiqued_at`** (MEDIUM). Previously,
  once a memory decayed it kept matching the stale-filter and got
  re-decayed on every subsequent pass until the 0.001 delta guard
  kicked in. The UPDATE now writes `last_critiqued_at = now`, so a
  decayed row is skipped on the next run unless it crosses the
  half-life again.
- **Clock-relative dates in decay tests** (MEDIUM). Hardcoded
  `'2025-12-01'` replaced with `Date.now() - 60 * 86400 * 1000` so the
  tests stay meaningful if the system clock rolls backward in CI.

### Still deferred (v0.17.0)

- No external critic process. Remaining most-important item.
- No exploration term (Thompson sampling).
- `retrieved_ids` stored as JSON text, not a join table.
- `autoresearch.mjs` remains a stats dashboard.

### Verified

- 275 / 275 tests pass (same suite as v0.16.1, now exercising the
  fixed transaction path)
- One reviewer's v0.16.1 verdict: SOLID PRIMITIVE
- Other reviewer's v0.16.1 verdict: BLOCK on decay transaction — now
  addressed

## [0.16.1] — 2026-04-20

Patch release addressing findings from two independent reviewers
(architect subagent + typescript-reviewer subagent). Verdict on v0.16.0
was "OVERSTATED" — the primitive was novel but the loop had six
structural defects. This release fixes all the HIGH-severity issues.

### Fixed

- **Neutral-count pollution** (HIGH). Previously every not-cited memory
  got `neutral_count++` on each retrieval, conflating "seen but not
  used" with "seen and judged neutral". Now only explicitly-cited
  memories accumulate usefulness rows — absence of signal is not
  evidence.
- **Decay broken by access-time refresh** (HIGH). The decay function
  read `last_updated`, but that column was refreshed on every retrieval
  hit, so actively-retrieved memories never aged past the half-life.
  Added `last_critiqued_at` column (schema v10); decay now reads that
  column, which only advances on real critic feedback.
- **Silent error swallow in `search_memory`** (HIGH). The `try/catch`
  around auto-log had no logging — attribution failures disappeared in
  production. Now logs via `logger.warn` with the error message.
- **Unnecessary `as unknown as Array<{id: string}>` cast** (HIGH).
  Replaced with a direct `results.map((r) => r.id)` that the existing
  union type handles without any cast.
- **Dynamic `import('./attribution.js')` in search hot path** (MEDIUM).
  Hoisted to a static import at the top of `search.ts`.
- **Full-table scan + unbatched writes in `decayUsefulness`** (MEDIUM).
  Added `WHERE last_critiqued_at < ?` predicate so SQLite prunes rows
  before JS sees them; wrapped the update loop in `db.transaction()`
  for a single WAL write lock.

### Added

- Regression tests covering each fix: `not-cited` non-pollution,
  decay-only-on-stale-critic, `cite_memories` throws on unknown event,
  empty `retrieved_ids` is safe.

### Verified

- 275 / 275 tests pass (was 271; 4 new regression tests)
- Schema v9 → v10 auto-migrates on startup with backup

### What the reviewers still flag (v0.17.0 work)

- **No actual critic process.** Outcomes come from the caller (self-report).
  Needs a separate Stop-hook or `post_answer` pass that runs a cheap local
  model (Haiku/Ollama) against `(query, retrieved, response)` and emits
  helpful/neutral/harmful per memory.
- **No exploration term.** Ranking is pure exploitation; Thompson sampling
  over Beta(helpful+1, harmful+1) would be one line.
- **`retrieval_events.retrieved_ids` stored as JSON text.** Aggregation by
  memory ID is O(table-scan). Needs a join table.
- **`autoresearch.mjs` advertises A/B sweeping it does not do.** Currently
  a stats dashboard.

These are acknowledged gaps, not fixes. v0.17.0 will address them.

## [0.16.0] — 2026-04-20

### Added — Retrieval attribution + critic-scored usefulness

Codex's brutal critique of speculative reflection: before synthesizing
insights, learn which memories actually help. v0.16.0 implements the
foundation.

- **New table `retrieval_events`** — every `search_memory` call logs the
  query + retrieved IDs + optional cited IDs + outcome label
  (helpful/neutral/harmful). Timestamped, queryable, auditable.
- **New table `memory_usefulness`** — per-memory running counts of
  helpful vs harmful citations, with a Laplace-smoothed `usefulness_score`
  in [0, 1]. Default 0.5 at zero observations so brand-new memories
  participate neutrally.
- **`log_retrieval` tool** — MCP tool for recording a retrieval event
  manually. Usually called implicitly (see auto-log below).
- **`cite_memories` tool** — attach a late verdict to a previously-logged
  event. Use when the agent answers first and a critic pass scores the
  answer afterward.
- **`usefulness_stats` tool** — list memories ranked by observed
  usefulness. Inspect what the agent actually leans on.
- **Auto-log in `search_memory`** — every hybrid search now records a
  `retrieval_event` automatically and returns `retrieval_event_id`
  alongside the results. Zero-config integration for agent loops.
- **Usefulness prior in search ranker** — the hybrid score is multiplied
  by `0.5 + usefulness_score`. A memory with score 1.0 gets a 50% lift;
  one with 0.0 takes a 50% penalty. Unobserved memories are unchanged.
- **`decayUsefulness` helper** — linear half-life decay toward
  `decay_floor` (0.5 by default). Prevents permanent lock-in from
  ancient verdicts.

### Added — Verbatim session archive backfill

- **`scripts/backfill-verbatim.mjs`** — imports all raw session
  transcripts from `~/.neuromcp/raw/sessions/` into the `verbatim`
  FTS5 table. Idempotent via SHA-256 content hash. Enables literal
  recall across the entire session history.

### Migration

- Schema v8 → v9: adds `retrieval_events` + `memory_usefulness`
  tables. Existing DBs auto-migrate on startup with pre-migration
  backup at `memory.db.backup-v8`.

### Verified

- 271 / 271 tests pass (was 265; 6 new attribution tests)
- MCP server reports `v0.16.0` on startup; exposes 41 tools (was 38)
- Real-world smoke test: `search_memory` on user's 932-session corpus
  returns results + `retrieval_event_id`, event persisted to DB
- Auto-log latency: <1 ms overhead per search call

## [0.15.0] — 2026-04-20

### Added
- **Rescue script for rejected batches** (`scripts/rescue-rejected.py`).
  Parses the `> REJECTED — ...` reason, strips the unsupported claims
  from the summary, appends the cleaned content to the target wiki page,
  and archives the original file. No LLM calls — pure text surgery. Runs
  automatically after each consolidation pass.
- **Auto entity-linker** (`scripts/entity-linker.py`). Scans every wiki
  page for bare-word mentions of other registered entities
  (people/, projects/, systems/) and unions them into the page's
  `related:` frontmatter. Turns the wiki into a light knowledge graph
  without a separate graph database.
- **Auto index rebuilder** (`scripts/rebuild-index.py`). Generates
  `index.md` plus per-category `-index.md` files. Categories over 10
  pages are auto-split so `index.md` stays compact (the router loaded
  into every Claude session).
- **Consolidator prompt hardening.** The per-batch consolidation prompt
  now explicitly forbids: version numbers not quoted from sources, tier
  labels, roadmap speculation, decision rationales not in sources, root
  cause hypotheses, cross-references like `(zie boven)`, and any numbers
  not quoted from sources.
- **Auto-strip retry on audit rejection.** When `audit_summary` flags
  specific unsupported claims, `consolidate_batch` now strips those
  lines and re-audits once. If the stripped version passes, the clean
  summary is written. Prevents losing an entire batch over one or two
  speculative lines.

### Fixed
- **Auto-capture hook reliability.** `templates/hooks/neuromcp-auto-capture.js`
  no longer requires the `CLAUDE_HOOK_EVENT` env var — it now reads
  `hook_event_name` from the Stop payload on stdin, matching how
  current Claude Code runtimes dispatch hooks. Falls back to
  transcript-presence when neither signal is available.

### Changed
- **Consolidation runner orchestrates post-processing.**
  `scripts/run-consolidation.sh` now calls, in order:
  `consolidate-sessions.py` → `rescue-rejected.py` → `entity-linker.py`
  → `rebuild-index.py`. Each step is isolated (`|| true`) so a failure
  downstream does not block consolidation of new sessions.

## [0.14.2] — prior

Pre-existing release. See git history for details.
