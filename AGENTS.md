# AGENTS.md — neuromcp

This file exists for agents that look for `AGENTS.md` (Codex, and other
non-Claude coding agents). **The rules for this repository live in
[`CLAUDE.md`](./CLAUDE.md) and apply to every agent, whatever it is called.**

Read `CLAUDE.md` in full before touching anything. In particular:

- **Plan Mode is mandatory** for non-trivial changes — describe root cause and
  plan first, wait for approval, then code.
- **Evidence-grounded claims only** — never say "fixed", "works", "tested" or
  "done" without the actual tool output, test run, or live smoke test.
- **Regression test first** — see it fail on current code, then fix, then see
  it pass.
- **No out-of-scope changes** — unrelated finds go in `FOUND-DURING-FIX.md`,
  not in the current PR.
- **No new dependencies, no `console.log`, no `any`** — TypeScript strict is
  non-negotiable; use the project logger (`src/observability/logger.ts`).

This file is deliberately a pointer, not a copy: one source of truth means the
two files cannot drift apart.
