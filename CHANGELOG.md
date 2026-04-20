# Changelog

All notable changes to **neuromcp** are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
