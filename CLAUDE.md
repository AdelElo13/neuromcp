# Project: neuromcp

## Context
- **What this builds**: open-source local-first AI memory MCP server. Persistent semantic memory for any MCP-compatible LLM client (Claude, GPT, Gemini, Ollama, Cursor, Continue, etc).
- **Stack**: TypeScript (strict), Node 22+, better-sqlite3 + sqlite-vec, Ollama for embeddings (nomic-embed-text 768d), MCP SDK over stdio + HTTP transport.
- **Platform**: cross-platform (macOS/Linux/Windows), local-first by design — no cloud, no API keys required for core operation.
- **Phase**: post-v0.20, pushing toward v0.21.0 (correctness fixes after external functional review). Benchmark target: ≥95% on LongMemEval, currently ~96.08% golden baseline.
- **License**: AGPL-3.0 + MIT carve-out (examples/integration bridges).

## Working style

### Plan Mode is mandatory
- For any non-trivial change: read relevant files, describe root-cause understanding, present implementation plan **before** touching code.
- Wait for explicit approval. No code mutations on speculation.
- For architectural choices that affect state (where state lives, schema design, migrations): describe options, let user choose.

### Evidence-grounded claims only
- Adel's hard rule: *"hoogwaardig bewijs altijd nodig ik eis dat"*.
- Never claim "fixed", "works", "shipped", "tested", "done" without one of:
  - Actual tool output (stdout/stderr, exit code, file contents).
  - Test run transcript (the **actual run**, not a test plan).
  - Live smoke test: invoke the thing, show the output.
- Forbidden phrases: *"should work", "will work", "all green"* without attached proof.
- Per regression: write the test FIRST, see it fail on current code, THEN fix, THEN see it pass.

### File output expectations
- Deliver **complete files**, not snippets or diffs (unless explicitly asked for a diff).
- No `console.log` in shipped code — use the project logger (`src/observability/logger.ts`).
- TypeScript strict mode is non-negotiable. No `any`. Use `unknown` + narrow.

## Verification

### Per-PR / per-bug
1. Write the regression test first; see it fail.
2. Apply the fix.
3. See the test pass.
4. Run the relevant unit test suite locally — must be green.
5. Run integration tests touching the changed surface — must be green.
6. Run LongMemEval distractor benchmark at limit=5, distractors=200:
   ```bash
   npx tsx eval/longmemeval-distractor-runner.ts --limit 5 --distractors 200
   ```
   R@5 must NOT regress vs v0.20.1 baseline.

### Pre-release
- Full `npm test` green.
- `npm run build` clean.
- `.mcpb` bundle rebuilds and installs cleanly.
- CHANGELOG.md updated with `BREAKING:`, `FIX:`, `INTERNAL:` prefixes per entry.
- LongMemEval golden run reproducible.

## What I do NOT want

- **No temporary fixes that mask larger problems.** If a fix only addresses the symptom, escalate — do not paper over.
- **No changes outside the scope of the task.** Out-of-scope finds go in `FOUND-DURING-FIX.md`, not in the current PR.
- **No new dependencies without discussion.** Especially no LLM-call-on-write-path additions without latency budget approval.
- **No half-finished work shipped as complete.** Every public knob must work, every flow end-to-end.
- **No "known limitations" in release notes for actual bugs.** Bugs are for fixing, not documenting around.
- **No `console.log` / `print` in shipped code.** Use the structured logger.
- **No mutation of user-input fields.** If a computed score derives from user input, store it in a separate column with a clear name (`effective_*`, `computed_*`).

## Known pitfalls

- **better-sqlite3 native ABI**: must match Node version of the runtime; `.mcpb` bundle ships pre-built binaries via npm prebuilt protocol. Don't break this without a plan.
- **Hybrid retrieval scoring confusion**: `rank_score` (RRF, ~0.015 for rank 1) is NOT cosine similarity. Document the difference loudly. Field rename in v0.21.
- **Predicate classification for contradictions**: default to `additive` (conservative). Mutually-exclusive predicates require explicit listing in `src/config/predicate-classes.json`. False positives in contradictions = hallucination vector for downstream LLMs — unacceptable.
- **Active episode state**: `start_episode` mutates per-process state file (`~/.neuromcp/active-episode.json`). PID staleness: stale state file is detected on next read and ignored.
- **Entity dedup case-sensitivity**: case + type variants caused duplicate entities pre-v0.21. Canonical key is `(LOWER(TRIM(name)), namespace)`. Migration script is destructive (deletes losers); always run `--dry-run` first.
- **Wiki consolidation runs every 4h via launchd** (`com.neuromcp.consolidate.plist`); raw sessions persist immediately on Stop hook, but wiki summaries lag up to 4h.
- **WIP brain-tools** (untracked: `src/registration/brain.ts`, `src/tools/brain.ts`): not in this v0.21 scope. Stashed under `WIP: brain tools + manifest changes (pre-v0.21 work)`.

## Repository layout (key paths)

```
src/
├── tools/             # MCP tool implementations (one file per tool family)
├── registration/      # MCP tool registration + Zod schemas (server-side)
├── cognitive/         # claims, contradictions, importance, MMR, explain
├── graph/             # entities, relations, traversal, pagerank
├── storage/           # DB schema, migrations
├── vectors/           # sqlite-vec wrapper
├── embeddings/        # Ollama provider + types
├── transport/         # stdio + HTTP MCP transports
├── observability/     # logger, metrics
├── config.ts
└── types.ts           # central type definitions
tests/
├── unit/
└── integration/
eval/
├── longmemeval-runner.ts
├── longmemeval-distractor-runner.ts
└── baseline.json
scripts/
├── build-mcpb.sh      # produces .mcpb bundle
└── (migrations live here too)
```

## Bug-fix policy (added 2026-04-29)

If during a fix you discover an unrelated bug or weakness:
1. Do NOT fix it in the current PR.
2. Append it to `FOUND-DURING-FIX.md` with: file path, line number, symptom, hypothesised root cause, proposed fix, severity (P0/P1/P2/P3).
3. Continue with the current scope.
4. After PR merge, raise the items from the file as new tickets.

This keeps PRs reviewable and prevents scope creep — a recurring failure mode.
