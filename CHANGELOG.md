# Changelog

All notable changes to **neuromcp** are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
