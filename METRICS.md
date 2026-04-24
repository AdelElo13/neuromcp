# Metrics

Weekly numbers. Append, never overwrite. Be honest about what we ran and what came back.

## Targets (from 22 april strategy)

| Metric | 30d | 60d | 90d |
|--------|-----|-----|-----|
| GitHub stars | 150 | 600 | 1,500 |
| npm weekly downloads | 100 | 500 | 2,000 |
| Featured listings | 4 | 8 | 12 |
| Merged integration PRs (external) | 1 | 3 | 6 |
| Press / blog mentions | 1 | 3 | 6 |
| Active contributors | 1 | 3 | 6 |
| External issues opened | 5 | 25 | 75 |

If we miss >50% on any metric, the bottleneck is product or demo, not
outreach volume. Diagnose first; don't escalate the funnel.

## Benchmark

| Date | Run | Score | Sample | Generator | Judge | Notes |
|------|-----|-------|--------|-----------|-------|-------|
| 2026-04-23 | v6 | 95.10% | 102 | claude opus | claude opus | baseline lock |
| 2026-04-23 | v7 | 96.08% | 102 | claude opus | claude opus | dropped user-owned hint, added anti-self-doubt guard. 0 regressions, +1 fix (citrus) |
| 2026-04-24 | v8d | 96.08% | 5q sample | claude opus + haiku summary | claude opus | trips/Muir fixed but citrus regressed → net 0; sprint2 features remain opt-in |

## Code health

| Date | Tests | Coverage (lines / functions / branches) | Lint | Build |
|------|-------|-----------------------------------------|------|-------|
| 2026-04-24 | 297 / 297 | 59.48% / 79.82% / 79.29% | green | green |

## Weekly log

### Week of 2026-04-21 → 2026-04-27

- Sprint 1: engineering hardening — SQL bug + claude_cli resilience + runner error isolation + SC normaliser + coverage in CI. Codex review, 0 CRITICAL.
- Sprint 2: session summary observer + 2-pass verifier (both opt-in). Codex review, 1 CRITICAL fix.
- Sprint 2.3: LLM entity extraction (opt-in). Codex review, 2 HIGH fixes (event-loop, alias-scope honesty).
- Sprint 3: better-sqlite3 ABI rebuild (root cause for v8b crashes), startup timeout 60→180s, eval-gate harness.
- Sprint 4.1: cross-row entity-merge dedup pass.
- Score: 95.10% → 96.08%, 0 regressions.

## How to update

1. Append a line to the relevant table — do NOT delete prior rows.
2. Add a `### Week of YYYY-MM-DD` block at the bottom of "Weekly log".
3. Commit with subject `metrics: week of YYYY-MM-DD`.
