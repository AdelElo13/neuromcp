# Found-During-Fix log — v0.21.0 correctness sweep

Items discovered while working the v0.21.0 bug list that are out-of-scope
for the current PR stack. Logged here per CLAUDE.md policy.

---

## P1: Bug #2 — repro path unclear

**Reported symptom:** `store_memory({importance: 0.8, source_trust: "high"})`
allegedly persists to DB with `importance: 1.0` — user-input mutated by
trust-boost in the write pipeline.

**What I found in code (release/0.21.0-correctness-fixes branch, base e1830fc):**

- `src/tools/store.ts:107` — `const importance = input.importance ?? 0.5`. Direct passthrough of user input. **No trust multiplier here.**
- `src/tools/store.ts:124` — on exact-content-hash dedup: `const newImportance = Math.max(exactMatch.importance, importance)`. **This is a mutation, but only on dedup, and it preserves whichever is higher (user-input OR existing DB value). It is not driven by source_trust.**
- `src/cognitive/importance.ts:computeAdaptiveImportance` — produces a derived `adjusted` score from base + access/recency/centrality boosts. **Returns a struct; does not write back into the `memories.importance` column.**
- `src/cognitive/explain.ts:104` — `TRUST_SCORES[memory.source_trust] ?? 0.5` is read-time only, exposed in explain output.

**Hypothesis on what the user actually saw:**
1. They stored a memory at importance 0.8.
2. The same content (or a near-dup post-dedup-merge) had previously been stored at importance 1.0 by another path (auto-extraction? a higher-importance source?).
3. On re-store, line 124's `Math.max` kept 1.0.
4. The user reads importance back → 1.0, concludes their 0.8 was overwritten.

**What we still need before fixing:**
- A failing test scenario that mutates `importance` from a clean state with a single store. Without it the planned `effective_importance` split becomes a speculative refactor.
- OR: confirmation that the symptom is "Math.max keeps the existing higher value, not the user's input" — which IS a real correctness issue (you can't lower a memory's importance without deleting + re-storing) and the planned split still applies, but the bug description and fix framing change.

**Severity:** P1 (real correctness issue likely exists, but the exact path is not what the brief described). Hold the planned split until repro is locked.

**Recommended next step:** ask the user for the exact stdout of the `recall_memory({id:...})` they used to observe importance=1.0, plus the prior history of stores against that content. Or have me add an instrumentation-only PR that logs every importance write with caller and prior value.

---

## P3: legacy active-episode hooks for non-tool callers

**Discovered while writing Bug #7:** `src/tools/transfer.ts` and `src/tools/reflection.ts` insert memories directly via `INSERT INTO memories (...)` instead of going through `storeMemory()`. They do not consult the new active-episode resolver. Today they pass `episode_id` either explicitly or null.

**Impact:** memories created by `transfer_memories` or auto-reflection from inside the same process where `start_episode` was called will NOT auto-attach to the active episode. The user-facing `store_memory` tool DOES attach correctly — that's the documented contract.

**Severity:** P3 (consistent behaviour across all internal write paths is nice-to-have but not a user-facing bug). Defer until/unless someone reports it.

---

## Closed during sweep

(none yet — bugs #1, #5, #7 closed cleanly without surfacing extra issues.)

---

## P3: Lint — `require()` style import in `src/episode/active-state.ts`

**Symptom:** `npm run lint` fails with:
- `src/episode/active-state.ts:83:36  error  A `require()` style import is forbidden  @typescript-eslint/no-require-imports`
- `src/episode/active-state.ts:2:10  warning  'dirname' is defined but never used`

**Origin:** introduced in commit `58d116b` (Bug #7 fix, 2026-04-29) — predates this v0.21.0 schema-extension PR.

**Hypothesised root cause:** the `try { return require('node:fs') } catch { return null }` pattern intentionally uses CJS to gracefully degrade when running in environments where dynamic ESM imports throw. Replacement should use top-level `import * as fs from 'node:fs'` since this file is always run in Node, never bundled to a browser.

**Proposed fix:** 
```ts
import * as fs from 'node:fs';
// drop the IIFE; just use fs.* directly
```
And: remove the unused `dirname` import on line 2.

**Severity:** P3 — lint fails, build still ships (`tsc --noEmit` does not run because `eslint &&` short-circuits). Not a runtime bug, but blocks `npm run lint` clean state.

**Out of scope here** because the v13 schema additions in this PR do not touch `src/episode/`. Raising as a follow-up ticket.
