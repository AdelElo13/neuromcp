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

---

## P1: `startHttpTransport()` does not attach `httpServer.on('error', ...)` — EADDRINUSE crashes whole process despite try/catch

**Symptom:** Starting `neuromcp` with `NEUROMCP_HTTP_ENABLED=true` while another instance already holds port 3200 causes the new process to die with an uncaught `Error: listen EADDRINUSE: address already in use 127.0.0.1:3200`. The `try { await startHttpTransport(...) } catch { logger.warn(...) }` block in `src/index.ts` does NOT catch this, even though it looks like it should.

**Origin:** `src/transport/http.ts:250-262` returns a Promise that only resolves on the `listen()` success callback. There is no `httpServer.on('error', ...)` registration. When the bind fails, `'error'` is emitted asynchronously on the server instance with no listener attached, which Node treats as an unhandled `'error'` event → process exit.

**Hypothesised root cause:** classic Node.js http.Server bind-error pitfall. Listen success callback fires only on success; bind errors come through the `'error'` event, not as a Promise rejection of `listen()`.

**Proposed fix:** in `src/transport/http.ts`, change the final return to attach both `error` and `listening` handlers, racing them to the Promise outcome:

```ts
return new Promise<Server>((resolve, reject) => {
  const onError = (err: Error): void => {
    httpServer.removeListener('listening', onListening);
    reject(err);
  };
  const onListening = (): void => {
    httpServer.removeListener('error', onError);
    logger.info('http', `HTTP API listening on ${options.host}:${options.port}`, { /* … */ });
    resolve(httpServer);
  };
  httpServer.once('error', onError);
  httpServer.once('listening', onListening);
  httpServer.listen(options.port, options.host);
});
```

That makes the existing try/catch in `index.ts` actually do its job ("HTTP transport failed to start, running stdio-only"), and removes the EADDRINUSE crash from multi-client setups (Claude Code + Claude Desktop + ChatGPT all spawning their own stdio-neuromcp).

**Severity:** P1 — silently breaks neuromcp for any user with multiple MCP-capable clients on the same machine. No data loss, but feature simply does not start. Workaround (`NEUROMCP_HTTP_ENABLED=false`) is what unblocked the present author.

**Out of scope here** because the daemon-mode work in this PR introduces a *new* `src/transport/mcp-http.ts` daemon path and doesn't refactor the legacy `startHttpTransport()` listen logic. Will be addressed in a focused PR (defensive-listen) right after v0.25 daemon mode lands; that PR can attach the error handler in 8 lines without touching the rest of `http.ts`.

---

## ~~P2: `neuromcp-enable-daemon` renders npx cache paths into launchd plist~~ [RESOLVED in-PR]

**Originally deferred to a follow-up.** Closed during round-8 hardening pass after Adel's "echt af, geen fouten meer" directive.

**Fix shipped (in `bin/enable-daemon.mjs`):** the installer now detects transient install roots (`/_npx/`, `/_cacache/`, `/private/tmp/`, `/var/folders/`, `/tmp/`) and refuses to register a plist that would point at a path the OS or npm can evict. First-attempt fix tried to copy `bin/` + `dist/` to `~/.neuromcp/` but the daemon also needs `node_modules` (MCP SDK, better-sqlite3 native binding, onnxruntime native) which cannot be relocated faithfully across Node ABIs — so the safer fix is detect-and-refuse with a clear remedy (`npm i -g neuromcp@latest`) and an explicit escape hatch (`NEUROMCP_ALLOW_TRANSIENT_INSTALL=1`) for advanced users.

---

## P2: Consolidation summarizer produces speculative content → 100% audit-rejection rate

**Reported symptom:** Wiki pages stale (`~/.neuromcp/wiki/index.md` 3 days old at 2026-05-17 even though `launchd` cron `com.neuromcp.consolidate` fires every 4h). Every `consolidate-sessions.py` run ends with `Done: 0/N projects processed`. Result: user-facing recall is consistently "thin" — recurring frustration *"werkt neuromcp nu naar behoren?"*.

**What I found in code (branch `feat/mcp-http-daemon-v0.25`, file `scripts/consolidate-sessions.py:564-581`):**

The summarizer prompt instructs Claude to *"Cover: version changes, bugs (root cause + fix), decisions (with rationale)..."* but contains **no evidence-grounding clause**. Claude (Haiku) produces plausible-sounding summaries that include details the source sessions do not contain.

The auditor (`scripts/consolidate-sessions.py:171+`, `audit_summary()`) is strict — it verifies every claim traces back to a quoted line in the source sessions. Sample rejections from the 2026-05-16 02:19 launchd run, captured in `~/.neuromcp/consolidation.log`:

- `Verascripta batch 1/2 REJECTED — Last commit date (30 apr) ... not mentioned in source sessions`
- `Verascripta batch 2/2 REJECTED — scripts/run-tests.sh does not appear in FILES MODIFIED across any of the 4 source sessions`
- `home batch 1/1 REJECTED — Summary invents causal mechanisms (Supabase re-triggering telegram) ... not present in session logs`
- `neuromcp batch 1/1 REJECTED — Summary conflates Telegram questions with invented technical explanations`

All 4 batches rejected → `Done: 0/3 projects processed`. The auditor catches the speculation but no summary survives → wiki never updates → recall stays thin.

**Root cause:** summarizer prompt is permissive, auditor is strict. The two are mis-aligned. Softening the auditor would breach Adel's hard evidence-rule; the fix is to harden the summarizer.

**Proposed fix:** add four evidence-grounding clauses to the `STRICT INSTRUCTIONS` block in `consolidate_batch()` around line 574:

```
- EVIDENCE RULE: every factual claim (version, date, name, fix, error, decision rationale) MUST be directly traceable to a quoted line in SESSIONS. If you cannot point to a source line, leave it out. Sparse summaries beat fabricated ones.
- DO NOT invent: causal mechanisms ("X caused Y" when sources show only X and Y separately), commit dates, version numbers, or fix details that the sessions do not explicitly state.
- DO NOT conflate user questions with answers: if a session contains "[USER]: how does X work?" without a follow-up explanation in the same session, do NOT write a summary that contains the answer.
- WHEN IN DOUBT: write less, or write "No technical substance this window." A correct sparse summary is acceptable; a confident wrong summary is not.
```

**Severity:** P2 — real bug, blocks the entire wiki-update pipeline, but has a clean workaround (lokal patch in `~/.neuromcp/scripts/consolidate-sessions.py`). Affects every user of `neuromcp` who enables consolidation — the same prompt ships via npm.

**Out of scope here** because the daemon-mode work in this PR touches `src/transport/*` + `bin/`; it does not modify `scripts/consolidate-sessions.py`. Per CLAUDE.md bug-fix policy: logged here, addressed in a focused follow-up PR after v0.25 lands.

**Recommended next step (post-merge):** branch `fix/consolidation-summarizer-evidence-prompt`. Write regression test that mocks `claude -p` with a known speculative completion and asserts auditor rejects → re-run with patched prompt and assert auditor accepts. Apply the four-clause patch.

**Workaround applied locally on 2026-05-17:** patched `~/.neuromcp/scripts/consolidate-sessions.py` with the four clauses above, so Adel's own cron starts producing acceptable summaries immediately. Not committed to the repo — waiting on daemon-PR merge per project policy.

---

## P2: `consolidate_batch()` silently swallows `claude -p` stderr → opaque "no output" warnings

**Reported symptom:** `~/.neuromcp/consolidation.log` shows `WARN: no output for <project> batch <N>/<M>` with no further context. Real failure mode (auth, rate-limit, crashed CLI, missing prompt-cache, etc.) is invisible. Adel's own debug took >24h to root-cause because the script printed the same "no output" line for an auth-failure as it would for a model-empty-response.

**What I found in code (branch `feat/mcp-http-daemon-v0.25`, file `scripts/consolidate-sessions.py:582-591`):**

```python
r = subprocess.run(
    ["claude", "-p", "--tools", "", "--no-session-persistence", prompt],
    capture_output=True,    # ← captures BOTH stdout and stderr
    text=True,
    timeout=300,
)
if r.returncode != 0 or not r.stdout.strip():
    print(f"  WARN: no output for {project} batch {batch_idx}/{batch_total}")
    return False, []         # ← r.stderr is captured but never inspected
```

When `claude -p` is logged out, it prints `Not logged in · Please run /login` to stderr **with exit code 0** (which itself is debatable, but it's a separate upstream issue). The Python check `r.returncode != 0` is false, `not r.stdout.strip()` is true → WARN line emitted with no hint that auth was the cause.

**Verification:**
- `env -i HOME=$HOME PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin claude -p --tools "" --no-session-persistence --model haiku "say HI" 2>&1` → prints `Not logged in · Please run /login`, exit 0.
- Three consecutive cron runs (2026-05-16 02:19, 2026-05-17 01:28, 2026-05-17 01:33) all logged 0/N processed with the opaque WARN, masking the actual auth failure for hours.

**Proposed fix:** capture the stderr (or stdout when stderr is empty) tail and print it alongside the exit code:

```python
if r.returncode != 0 or not r.stdout.strip():
    stderr_tail = (r.stderr or "").strip().splitlines()[-3:]
    stdout_tail = (r.stdout or "").strip().splitlines()[-3:]
    hint = " | stderr: " + " ¶ ".join(stderr_tail) if stderr_tail else ""
    if stdout_tail and not stderr_tail:
        hint = " | stdout: " + " ¶ ".join(stdout_tail)
    print(f"  WARN: no output for {project} batch {batch_idx}/{batch_total} (exit {r.returncode}){hint}")
    return False, []
```

Three lines emitted instead of one, with exit-code + last 3 lines of stderr (or stdout if stderr is empty). Costs nothing on success path. Turns silent failures into actionable signal.

**Severity:** P2 — observability bug, not a correctness bug. Masks downstream issues (like the auth failure that hid for >24h). Affects everyone who runs neuromcp consolidation; same script ships via npm.

**Out of scope here** because it lives in `scripts/`, the daemon-PR touches `src/transport/*` + `bin/`. Logged here per CLAUDE.md policy, addressed in the same follow-up PR as the P2 above (single `scripts/consolidate-sessions.py` patch covers both).

**Workaround applied locally on 2026-05-17:** patched `~/.neuromcp/scripts/consolidate-sessions.py` with the diff above. Next failed batch will now log the real cause.

**Upstream context (not a neuromcp bug but worth noting):** `claude -p` returning exit 0 on a not-logged-in error is itself a UX-bug worth raising with Anthropic. A logged-out CLI should arguably exit non-zero so subprocess callers can fail fast.

---

## P1: neuromcp has no runtime-health surface → silent failures break user trust

**Reported symptom:** Adel's hard quote on 2026-05-17: *"voor users die dit downloaden moet alles werken en als er iets mis is moet jij claude dus dat aan ze melden iets mis met neuromcp mensen vertrouwen er blind op dat alles werkt"*.

Concrete failure mode this exposes: when consolidation breaks (e.g. P2 prompt-bug above, or P2 stderr-swallow above, or `claude -p` auth fail, or DB corruption, or 4h cron not firing), **the user keeps using neuromcp assuming it works**. Symptoms only emerge as "recall is thin" days/weeks later. No surface signals: no health endpoint, no `doctor --runtime` mode, no SessionStart context injection saying "I'm degraded".

**What I found in code:**

- `bin/doctor.mjs` (206 lines): install-time checks only — node version, dist presence, sqlite native build, package version, data dir, platform. Pass on all of these even when the runtime pipeline is fully broken.
- No `health-check`, `--runtime`, `doctor live`, or equivalent command exists.
- `templates/hooks/` ships auto-capture + persist, but **no health/diagnostics hook**.
- `~/.neuromcp/consolidation.log` is the only signal — and only if the user happens to `tail` it.

**Proposed fix (two parts):**

### Part A: extend `neuromcp-doctor` with `--runtime` mode

Add a flag that runs runtime checks against the live install. Mirror the structure of the bash script in `Workaround` below, but in Node so it ships cross-platform via npm. Check items:

1. **DB integrity**: `~/.neuromcp/memory.db` exists, openable, returns `SELECT COUNT(*) FROM memories`.
2. **Wiki freshness**: `wiki/index.md` mtime — WARN if >2d, FAIL if >14d.
3. **Consolidation backlog**: count `raw/sessions/*.md` minus processed ledger entries; WARN if >100.
4. **Last consolidation result**: parse last `Done: X/Y` from `consolidation.log`; FAIL if X=0 and Y>0.
5. **`claude -p` subprocess auth**: probe with 5s ceiling; FAIL on 401 / "Not logged in" / "Invalid auth"; surface fix suggestion.
6. **Embedding provider reachable**: ping Ollama `nomic-embed-text` endpoint at `http://localhost:11434/api/tags` (or whatever the resolved provider is).
7. **Auto-capture hook installed**: check `~/.claude/hooks/hooks.json` for the bundled neuromcp hooks, warn if missing on a Claude Code install.

Exit codes: `0=healthy`, `1=degraded(warn)`, `2=broken(fail)`.

Output: structured human-readable lines + `--json` flag for machine consumption.

### Part B: ship a SessionStart hook in `templates/hooks/`

Add `templates/hooks/neuromcp-health-check.{sh,js}` that:
- Runs `neuromcp-doctor --runtime --quiet` (or equivalent).
- Outputs a one-liner when healthy (don't pollute every SessionStart with noise).
- Outputs the full report when degraded (so Claude has the failure surface in context and can tell the user).

Register it in the `neuromcp-init-wiki` installer's hook-injection step so downstream Claude Code users get it automatically.

**Severity:** P1 — addresses Adel's #1 product requirement on 2026-05-17: trust by default, loud failures when broken. Without this, the same silent-failure mode that hid the auth bug for 3+ days will recur with every future regression. The two P2 bugs above (prompt + stderr) only get *caught* by users if this surface exists.

**Workaround applied locally on 2026-05-17:**
- Created `~/.neuromcp/scripts/health-check.sh` (bash, portable) implementing all 6 checks listed in Part A (except embedding-provider ping; deferred).
- Registered in `~/.claude/hooks/hooks.json` as 4th SessionStart entry `id: session:neuromcp-health`. Backup of pre-edit hooks.json at `~/.claude/hooks/hooks.json.bak-2026-05-17`.
- Verified live: outputs one-liner when healthy, full report when degraded. Tested in current degraded state (consolidation broken due to `claude -p` auth), surfaced the 401 + fix suggestion in <1s.

Once daemon-PR merges, the bash script can be ported 1:1 to `bin/doctor.mjs --runtime` (or new `bin/health-check.mjs`), and the template hook can be added to `templates/hooks/`.

**Not yet handled (next iteration):**
- Telegram/email/desktop notification when health drops from green → red (currently only visible in next SessionStart).
- Trend tracking (run-to-run delta in `~/.neuromcp/health-log.jsonl`) so we can see "auth broke 14h ago" instead of just "auth broken now".
- Auto-repair attempts where safe (e.g. `claude -p` 401 → suggest token refresh path, or run `claude login` interactive prompt).

---

## P1: consolidate-sessions.py — no audit-retry loop on rejected batches *(RESOLVED — see commit `<sha>` and CHANGELOG.md Unreleased ### Added)*

> **Status:** resolved in the same PR stack that closed the kernel
> `--tools ""` bug. `consolidate_batch` now wraps summary + audit in a
> bounded `for attempt in range(MAX_AUDIT_ATTEMPTS + 1)` loop with model
> escalation (`AUDIT_MODEL` → `RETRY_MODEL`) on retry, and exhausted
> batches land in `review-queue/exhausted/` so health-check.sh can flag
> them as a persistent degraded signal. Stale queue files from earlier
> failed runs are pruned automatically by `scripts/reprocess-review-queue.py`
> (hooked into `scripts/run-consolidation.sh`). Regression tests:
> `tests/unit/consolidate-sessions-retry.test.ts` (structural) and
> `tests/integration/reprocess-review-queue.test.ts` (behavioural — 5 cases).
>
> Behavioural integration test for the in-script retry path itself
> deferred — see P3 below.

**Reported symptom:** when `audit_summary` returns `(False, reason)` the
batch is written to `~/.neuromcp/review-queue/<timestamp>_<project>_batch<n>.md`
and `consolidate_batch` returns `(False, [])`. The ledger is NOT advanced for
those sessions, so the next scheduled consolidation run will see the same
batch as pending. But the script does not re-attempt the summary on a fresh
`claude -p` call within the same run — a single audit rejection per project
blocks all forward progress for that project until human intervention.

**Observed in the wild:**
- 2026-05-27 10:00 — `csm-staging batch 1/1 rejected — AUDIT UNAVAILABLE`
  (timeout). Sat in review-queue 24h until next run, which got further but
  rejected on different grounds.
- 2026-06-07 03:31 — `home batch 1/1 rejected — Summary claims '4 sessions'
  but explicitly lists only 3`. Real audit fired correctly (post-`--tools`
  fix); the auditor caught a hallucinated count in the Haiku summary. No
  retry: the next launchd run will hit the same Haiku non-determinism and
  may reject again.

**Hypothesised root cause:** `consolidate_batch` treats audit rejection as a
terminal outcome for the run, on the (defensible) theory that humans should
review queued summaries before re-trying. But the review-queue is not wired
to any UI or automated re-injection path, so in practice the queue is
write-only and the backlog grows monotonically.

**Proposed fix (two layers):**
1. In-run retry with bounded attempts (default 2): on rejection, regenerate
   summary + re-audit. Different temperature or model on second pass to
   reduce determinism in the failure mode.
2. Scheduled re-process pass that walks `review-queue/`, runs the audit
   against the queued summary + originating raw sessions, and either
   approves+writes-to-wiki or moves to a `review-queue/exhausted/` dir
   after N total attempts across runs. Exhausted batches surface in
   `health-check.sh` as a degraded-state signal.

**Severity:** P1 — the consolidation main flow was rescued by the
`--tools ""` removal (this PR), but without retry the wiki will still
plateau on any project that hits a single Haiku hallucination in summary
generation. That is exactly the kind of silent slow-degrade that Adel
called out: "we gaan niet voor 'goed genoeg' ... geen stille fallbacks".

**Out of scope for this PR** (current PR: tools/stdin fix in
`consolidate-sessions.py` only).

---

## P2: claude CLI — at least one MCP tool registers a top-level oneOf/allOf/anyOf input_schema

**Reported symptom:** any `claude -p --tools <value>` invocation (any value
— `""`, `none`, `[]`, `Read`, etc.) returns
`API Error 400 tools.N.custom.input_schema: input_schema does not support
oneOf, allOf, or anyOf at the top level`. The index N shifts with each added
`--tools <value>`, suggesting the flag appends to the implicit registered
set rather than replacing it.

**What I confirmed (not in this repo):**
- `claude -p --no-session-persistence "<prompt>"` (no `--tools` flag at all)
  works correctly with no tools registered → exit 0, response on stdout.
- `claude -p --tools "" "<prompt>"` and every other `--tools <value>` I
  tried → exit 1 with the 400 error above.
- Reproduced with `claude --version` = `2.1.141 (Claude Code)` on macOS
  Darwin 25.5.0, 2026-06-07.

**Why this matters for neuromcp:**
- The fixed call sites in `consolidate-sessions.py` now correctly omit the
  flag. No further action needed inside this repo.
- BUT: any future `claude -p`-based workflow (tests, scripts, integrations
  in downstream tools) that tries to use `--tools` for tool-allow-listing
  will hit this. It is an ecosystem-wide footgun, not a neuromcp one.

**Hypothesised root cause (educated guess, not verified):** one of the
installed MCP servers / Claude Code plugins / built-in tools is shipping a
JSON Schema whose top-level form uses `oneOf` / `allOf` / `anyOf`. The
Anthropic Messages API tool-schema validator rejects this (per the API
error message). The CLI does not pre-validate the schema before sending,
so the rejection only surfaces at API-call time.

**Proposed action:** out-of-scope investigation in Adel's `~/.claude/`
plugin/MCP set. To identify tool N: run `claude -p --tools "" --debug
"<prompt>"` (if `--debug` exists) or instrument the CLI to dump the
registered tool list before the API call. Once N is identified, find the
offending tool's `input_schema` and rewrite as a flat object schema.

**Severity:** P2 — workaround (don't use `--tools` flag) is trivial and
fully effective for neuromcp. But it is a latent trap for any future
project relying on this CLI surface.

**Out of scope for this PR** entirely — this is an upstream / ecosystem
issue, not a neuromcp issue.

---

## P3: consolidate-sessions.py — retry loop has structural test only, no behaviour test

**Reported symptom:** `tests/unit/consolidate-sessions-retry.test.ts`
asserts that the retry primitives (constants, loop construct, exhausted
folder reference) exist in the script source. It does NOT assert that a
rejected batch is actually retried with the escalated model and that
exhausted batches actually land in `review-queue/exhausted/`. A refactor
that renames the constants while breaking the runtime behaviour would
silently pass this test if the new names happen to keep the same regex
shape, or fail without a clear pointer to the regression.

**Why structural-only was chosen for this PR:** a behaviour test needs
either (a) a Python test runner (forbidden by project CLAUDE.md "no new
dependencies without discussion") or (b) a vitest integration test that
spawns `python3 scripts/consolidate-sessions.py` against a tmpdir with a
fake `claude` shim binary on PATH. Option (b) is the right answer but
introduces a new test pattern (PATH manipulation + spawned subprocess +
fixture sessions) that has no precedent in the repo. Doing it correctly
takes ~1 hour and benefits from its own design review.

**Proposed fix:** add `tests/integration/consolidate-sessions-retry-behaviour.test.ts`
that:
1. Creates a tmpdir with 2 fake raw session files under
   `<tmpdir>/raw/sessions/`.
2. Generates a fake `claude` shell script at `<tmpdir>/bin/claude` that
   - on first invocation returns a summary with a deliberate count
     mismatch (trigger audit reject),
   - on second invocation (the retry, with `--model sonnet`) returns a
     summary that the audit will approve.
3. Prepends `<tmpdir>/bin` to PATH, runs `python3 scripts/consolidate-sessions.py
   --since <today>` with `NEUROMCP_DIR` env override pointing at the tmpdir.
4. Asserts: exit 0, wiki page `<tmpdir>/wiki/projects/<project>.md` was
   created with the approved summary, ledger advanced, no file in
   `<tmpdir>/review-queue/exhausted/`.
5. Mirror test for the exhaustion path: fake `claude` rejects on every
   call, assert batch lands in `exhausted/` and ledger NOT advanced.

**Severity:** P3 — the structural test catches the common refactor mistake
(deleting the loop entirely). The gap is the silent-rename-while-breaking
case, which is rarer. P3 not P1 because we have other observability
(`health-check.sh` will surface stuck batches in production).

**Blocked by:** nothing. This is straight follow-up work.

---

## P3: local `node` default is v26 → `npm test` fails with 226 better-sqlite3 ABI errors

**Discovered while fixing the daemon node-path bug (2026-06-09).** Running
`npx vitest run` with the machine's default `node` (`/opt/homebrew/bin/node`
= v26.0.0) makes every DB-backed test fail at `new Database()` with a native
ABI mismatch — 226 failed / 117 passed / 25 skipped. The native
`better-sqlite3` binding in `node_modules` was built for node@22 (the
daemon's runtime).

**Proof:** the identical suite under node@22
(`/opt/homebrew/opt/node@22/bin/node`) → 59 files / 368 tests pass, 0 fail.
Only the node version changed.

**Not a repo bug** — `package.json` engines is `>=20`, and a fresh
`npm install` under node 26 would rebuild/download the matching binary. This
is local toolchain drift: node was upgraded to 26 without rebuilding native
modules.

**Remedy (local):** run tests under node@22 —
`PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm test` — or
`npm rebuild better-sqlite3 onnxruntime-node` after a node major bump.

**Severity:** P3 — environment-only, zero production impact, but it masks
real regressions behind a wall of fake failures. Worth a one-line note in
the README/CONTRIBUTING test section so it doesn't burn an hour next time.

## P3: `recall_answer` `sources` lists all retrieved memories, incl. below-floor

**Discovered during the Codex round-6 review (2026-06-14).** `synthesizeAnswer`
populates `sources` from every retrieved memory (`src/cognitive/synthesize.ts`,
the `memories.map(...)` near the top), including memories below the
`relevanceFloor` that are correctly EXCLUDED from `citations`/`answer`. Codex
confirmed this is **not** an answer/citation leak — the answer only ever cites
eligible (above-floor) memories — but the `sources` field is documented as "the
source memories that backed the answer," which is mildly misleading when it also
lists candidates that backed nothing.

**Proposed fix:** filter `sources` to the memories that actually contributed a
selected sentence (or eligible content), or rename/redocument the field as
"retrieved candidates." Cosmetic; no correctness impact.

**Severity:** P3 — transparency/labeling only, no fabrication risk.

## [2026-07-02] Gevonden tijdens security-fix (path traversal + Origin)

- **P2 — `scripts/__pycache__/consolidate-sessions.cpython-312.pyc` is git-tracked.** Compiled Python cache hoort niet in git; blokkeerde vandaag een branch-switch. Fix: `git rm --cached`, `__pycache__/` in .gitignore.
- **P2 — `wiki.ts` god-file (665+ regels, 3 onafhankelijke tools).** Split naar `wiki/ingest.ts`, `wiki/lint.ts`, `wiki/briefing.ts`, `wiki/shared.ts`. Lage cohesie was mede-oorzaak dat de traversal-bug onopgemerkt bleef.
- **P2 — `/api/store-batch` lekt rauwe error-details (`detail: msg`) naar de client** terwijl `/api/store` bewust filtert (src/transport/http.ts:348-356 vs 321-329). Consolideer naar één patroon.
- **P3 — `readJsonBody`/`readBoundedBody` gedupliceerd** in mcp-http-daemon.ts en http.ts (verschillende caps, zelfde logica). Extraheer naar `transport/body.ts`.
- **P3 — geen timeout op request-body-inlezen** (slow-loris) in beide body-readers; relevant zodra `NEUROMCP_DAEMON_INSECURE_NON_LOOPBACK=1` gebruikt wordt.
- **P3 — geen concurrency-test voor multi-client SQLite writes** (N parallelle store_memory tegen één daemon-DB); WAL+busy_timeout is geconfigureerd maar onbewezen onder contentie.
- **P3 — flaky test onder volle suite-load:** `tests/integration/release-014-regressions.test.ts` › "embed.mjs returns {ok:false} for unknown memory id" faalde 1× met lege stdout (JSON parse error) tijdens parallelle full-suite run; geïsoleerd en bij herhaalde full run groen. Vermoedelijk subprocess-spawn contention. Overweeg retry of ruimere timeout op de runNode-helper.

---

## P3: pre-existing type debt in bin/ + scripts/ (excluded from new tsconfig.scripts.json gate)

**Found while:** wiring the v0.28.0 audit-network fixes (dead SIGKILL fallback +
missing spawn 'error' listener) into CI. Root cause of the gap: `npm run lint`
was `eslint src/ && tsc --noEmit` with tsconfig `include: ["src"]`, so nothing
in bin/ or scripts/ was ever linted or type-checked.

**Fix applied in that PR:** lint now runs `eslint src/ bin/ scripts/` plus
`tsc -p tsconfig.scripts.json` (strict checkJs over bin/ + scripts/).
`bin/doctor.mjs` was made strict-clean.

**Remaining debt:** 16 files fail strict checkJs today (~248 errors, mostly
implicit-any params and property access on `unknown` from `res.json()` /
db rows). They are listed in the `exclude` ratchet in `tsconfig.scripts.json`
— new files ARE checked by default; these need typing to be un-excluded:

- bin/embed.mjs, bin/enable-consolidation.mjs, bin/enable-daemon.mjs,
  bin/enable-zombie-cleanup.mjs, bin/init-wiki.mjs, bin/init.mjs,
  bin/neuromcp-connect.mjs, bin/query.mjs, bin/resolve-node-bin.mjs
- scripts/ab-sweep.mjs, scripts/backfill-embeddings.mjs,
  scripts/backfill-verbatim.mjs, scripts/download-reranker.mjs,
  scripts/index-wiki.mjs, scripts/migrate-memory.ts,
  scripts/usefulness-dashboard.mjs

**Proposed fix:** JSDoc-type per file (boundary casts on JSON/db reads),
remove from exclude one file per PR. Severity P3 — no runtime impact known,
but the gate can't protect excluded files until then.

**Also (same sweep):** the 2 eslint warnings this surfaced
(`migrate-memory.ts` unused import `applySchema`,
`usefulness-dashboard.mjs` unused `__dirname`) got fixed in the PR after
all: on Node 18 ESLint 10's stylish formatter crashes on ANY printed
output (`util.styleText` missing), so warnings broke the CI matrix. The
CI lint step now runs on Node 22 only for the same reason.

---

## [2026-07-06] Gevonden tijdens hardening-fix (registry-workflow pin + init atomic write)

- **P3 — `neuromcp-init` laadt als bijeffect een launchd-agent in de globale
  gui-domain.** `bin/init-wiki.mjs:249-259` auto-installeert
  `enable-zombie-cleanup.mjs`, dat `launchctl` aanroept op basis van `HOME`.
  Symptoom: een init-run met alternatieve/sandbox `HOME` (CI, tests, smoke
  runs) registreert een agent (`com.neuromcp.zombie-cleanup`) die naar een
  tijdelijk pad wijst — na cleanup van dat pad blijft een dangling launchd-
  entry achter. Vandaag live gereproduceerd tijdens de init-smoke-test in een
  fake-HOME sandbox (agent handmatig ge-boot-out). Hypothese root cause:
  installer gebruikt `HOME` voor plist-pad maar launchctl-registratie is
  per-user globaal; er is geen guard tegen niet-standaard HOME en geen
  opt-in. Voorstel: zombie-cleanup-install opt-in maken (of minstens skippen
  wanneer `HOME` afwijkt van de user-database-home / in CI), en bij install
  een bestaande registratie met zelfde label detecteren. Severity: P3.
