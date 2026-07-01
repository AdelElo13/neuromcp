# neuromcp — Sovereign Memory for AI agents

**Any model. Your memory. Stays local.**

neuromcp is the first **Sovereign Memory** layer for AI: an open-source MCP server that gives Claude, GPT, Gemini, and Ollama persistent, searchable memory — stored entirely on your machine. No API keys. No cloud sync. No subscription required to remember who you are.

> **Sovereign Memory** = data that you own outright, lives on hardware you control, and is portable across every model you use. Cloud memory products own your data; Sovereign Memory means *you* do.

[![npm version](https://img.shields.io/npm/v/neuromcp)](https://www.npmjs.com/package/neuromcp)
[![npm downloads](https://img.shields.io/npm/dw/neuromcp)](https://www.npmjs.com/package/neuromcp)
[![license: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-471%20passing-brightgreen)](./tests)

```bash
npx neuromcp-init   # one command: detects your MCP clients, writes configs, sets up the wiki
```

Or run the bare server without any setup: `npx neuromcp`. Something not
working? `npx neuromcp-doctor` diagnoses the daemon, Ollama, embeddings
and the database in one run.

## Why neuromcp

**The LLM is a commodity. Your memory is the moat.**
GPT-5, Claude 4, Gemini — they all converge. The model you use next year will differ. The memory of every conversation, decision, and preference you build is yours. neuromcp keeps that layer on your machine and makes it portable across any MCP-compatible client.

**Local-first is a design choice, not a limitation.**
No telemetry. No data leaves your laptop. No vendor has a copy of your conversations. Audit every line of code that touches your memory. SQLite + local embeddings; everything fits on one disk.

**One install. Every client.**
Claude Desktop, Cursor, Windsurf, Codex CLI, Continue, LibreChat, Open WebUI — neuromcp speaks MCP, so it works wherever MCP is supported. Switch models tomorrow; your memory follows.

**Real recall, not keyword matching.**
Hybrid retrieval combines vector search (nomic-embed-text, 768-dim), BM25 full-text, graph links, and a learned usefulness prior. At 500 distractors on LongMemEval, R@5 holds at 93.3%. Your context window gets the right memory, not just the most recent.

## LongMemEval-S accuracy

| Run | Score | Sample | Config |
|-----|-------|--------|--------|
| **v7 (current)** | **96.08%** (98/102) | n=102 | Opus generator + Opus judge, single-model |
| v6 | 95.10% (97/102) | n=102 | Same as v7, prior hint set |

Repro: `OMB_ANSWER_LLM=claude OMB_ANSWER_MODEL=opus OMB_JUDGE_LLM=claude OMB_JUDGE_MODEL=opus uv run omb run --dataset longmemeval -s s -m neuromcp -c "single-session-user,single-session-assistant,multi-session,temporal-reasoning,knowledge-update,single-session-preference" --query-limit 17`

> **Sample size honesty.** n=102 (17 per category × 6 categories). Wilson 95% CI for 98/102 ≈ 90.5–98.7%. Full 500q run with the same config is the next milestone before any "top-tier" claim.

## Benchmarks (v0.18.0)

### Oracle split (clean — easy mode)

| Mode | R@5 | R@10 | Hit Rate |
|------|-----|------|----------|
| Extracted (hybrid) | 100% | 100% | 100% |

Oracle-split LongMemEval isolates the correct memory in a small
corpus. Every local MCP memory system claims ~99% here. It measures
"does the ranker work on clean inputs" — nothing more.

### Distractor split (v0.18.0, honest)

Same 30 questions + 1000 random distractor memories drawn from other
questions' haystacks. The correct memory now competes against real noise.

| Embedder | Distractors | N | R@5 | R@10 | MRR |
|----------|-------------|---|-----|------|-----|
| Ollama `nomic-embed-text` | 0 (oracle) | 30 | 100% | 100% | 100% |
| Ollama `nomic-embed-text` | 200 | 5 | 100% | 100% | 100% |
| Ollama `nomic-embed-text` | **500** | **30** | **93.3%** | **93.3%** | **80.3%** |
| Ollama `nomic-embed-text` | 1000 | 5 | 100% | 100% | 74% |

Reproduce: `npx tsx eval/longmemeval-distractor-runner.ts --limit 5 --distractors 1000`

> **Sample sizes.** The 500-distractor row is n=30 (Wilson 95% CI for
> 28/30 ≈ 78-99% R@5). The 1000-distractor row is n=5 — preliminary,
> Wilson 95% CI [57%, 100%]. The 1000-distractor n=30 run takes ~36 min
> on a single Ollama instance; cached-distractor batching is v0.19.0
> work. Treat 500-distractor numbers as defensible, 1000-distractor as
> directionally positive but underpowered.


> **Head-to-head comparison is explicit v0.19.0 work.** Hindsight (local
> OSS MCP, ~94.6% LongMemEval claimed) and Mem0/Zep publish their own
> numbers on their own harnesses. Until we run all of them against the
> same corpus + embedder, calling any local MCP server "state of the art"
> is marketing, not measurement. neuromcp publishes its numbers with
> sample-size caveats so you can judge direction; don't read absolute
> superiority into them yet.

Hybrid ranker (BM25 + vector + attention + graph + usefulness prior)
keeps R@5 = 100% at 1000:1 distractor:target ratio on the observed
sample. MRR drops to 74% because the correct memory is sometimes not
rank-1 but always rank ≤ 5 in what we saw. Earlier v0.18.0 numbers
(R@5 23%) were from a test FakeEmbedder — fixed in v0.18.1.

**What this benchmark does NOT prove:** end-to-end answer
correctness, long-horizon multi-session reasoning, or superiority
over commercial cloud systems (Mem0, Zep) on their own benchmarks.
Those comparisons need their numbers on the same distractor split,
which hasn't been published.


## Why

AI agents forget everything between sessions. Existing solutions either store flat key-value pairs (useless for real knowledge) or require cloud infrastructure and API keys.

neuromcp gives you two layers of memory:

1. **MCP Server** — hybrid search (vector + full-text + graph), verbatim recall, memory governance, automatic consolidation, all in a single SQLite file
2. **Wiki Knowledge Base** — compiled Markdown knowledge that survives crashes, compounds over sessions, and gives your agent project-aware context at every startup

Inspired by [Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), [Mastra's Observational Memory](https://mastra.ai/research/observational-memory), and [Zep's temporal knowledge graphs](https://arxiv.org/abs/2501.13956) — but simpler than all of them. No vector DB, no embeddings pipeline, no cloud. Just Markdown files + Git + hooks.

## Architecture

```
~/.neuromcp/
├── memory.db               ← SQLite: hybrid search, MCP tools
├── wiki/                   ← Compiled knowledge (git-tracked)
│   ├── index.md            ← Routekaart — LLM reads this FIRST
│   ├── schema.md           ← Operating rules for the LLM
│   ├── log.md              ← Append-only changelog
│   ├── people/             ← User profiles, preferences
│   ├── projects/           ← Project knowledge (stack, auth, URLs)
│   ├── systems/            ← Infrastructure (tools, MCP servers)
│   ├── patterns/           ← Reusable patterns (error fixes, routing)
│   ├── decisions/          ← Architecture decisions with context
│   └── skills/             ← Repeatable procedures
└── raw/sessions/           ← Raw session logs (auto-generated)
```

### How the wiki works

| When | What happens |
|------|-------------|
| **Session start** | Hook injects `index.md` + user profile + auto-detected project page (~1300 tokens) |
| **During session** | LLM updates wiki pages when learning something persistent |
| **Every 8 tool calls** | Hook reminds LLM to update the wiki |
| **Session end** | Hook writes raw session log + git auto-commits all wiki changes |
| **Crash** | Checkpoint every 5 tool calls to file. Git history for rollback. |

### Self-healing consolidation pipeline (v0.15.0+)

Every ~4h the launchd agent runs `run-consolidation.sh`, which
orchestrates four steps end-to-end:

1. **`consolidate-sessions.py`** — batches raw sessions per project,
   asks Claude for a factual summary, and fact-checks it against the
   raw sources. When the auditor flags specific unsupported claims the
   consolidator now **auto-strips those lines and re-audits once** — so
   one speculative sentence no longer kills a whole batch.
2. **`rescue-rejected.py`** — any batch that still fails is parsed,
   the unsupported claims are removed, and the cleaned summary is
   appended to its wiki page. Pure text surgery, no LLM calls.
3. **`entity-linker.py`** — cross-links every page: a bare-word mention
   of another registered entity (people/, projects/, systems/) is added
   to the page's `related:` frontmatter. Makes the wiki act like a
   graph without a separate graph database.
4. **`rebuild-index.py`** — regenerates `index.md` and per-category
   `-index.md` files. Categories over 10 pages are auto-split so the
   session-start router stays compact as the wiki scales.

The pipeline is idempotent — safe to re-run at any time.

### What the LLM knows at session start

```
Schema (operating rules) → How to maintain the wiki
Index (knowledge map)    → What knowledge exists
User profile             → Who you are, how you work
Project page             → Current project details (auto-detected from cwd)
Last session             → What happened last time
```

## Quick Start

### One command (recommended)

```bash
npx neuromcp-init
```

Detects your installed MCP clients (Claude Desktop, Claude Code, Cursor,
Windsurf), writes the `neuromcp` entry into each config (with a backup of
the original), initializes the wiki + hooks, and checks whether Ollama is
available. `--dry-run` previews everything without writing.

### Manual steps (what init does under the hood)

**1. Start the MCP server**

```bash
npx neuromcp
```

**2. Initialize the wiki + hooks** (**required** for closed-loop attribution)

```bash
npx neuromcp-init-wiki
```

This creates the wiki structure, installs hooks (Claude Code) and rules (other editors), and configures everything automatically. **Without this step**, `npx neuromcp` still runs as a plain MCP server with [46 tools](docs/TOOLS.md), but the critic hook that closes the attribution loop is not installed — retrieval works but usefulness scores never accumulate. Safe to run multiple times — won't overwrite existing config.

### Editor Compatibility

neuromcp works with any MCP-compatible editor. Two tiers of integration:

| Feature | Claude Code | Cursor / Windsurf / Cline / Copilot / JetBrains / Zed |
|---------|-------------|-------------------------------------------------------|
| MCP tools ([46](docs/TOOLS.md)) | Full | Full |
| Context at session start | Hooks (automatic) | Rules (LLM-driven, best-effort) |
| Persist at session end | Hooks (automatic) | Rules (LLM-driven, best-effort) |
| Wiki reminders | Every 8 tool calls | No |
| Crash-resilient checkpoints | Yes | No |

**Claude Code** gets the full experience via native hooks — context injection and persistence happen automatically, even if the LLM forgets.

**Other editors** get rules files that instruct the LLM to call neuromcp tools at session start/end. This depends on LLM compliance — it works well in practice but is not guaranteed like hooks.

```bash
# Auto-detect installed editors
npx neuromcp-init-wiki

# Target a specific editor
npx neuromcp-init-wiki --editor cursor

# Install rules for all supported editors
npx neuromcp-init-wiki --editor all
```

Supported editors: `cursor`, `windsurf`, `cline`, `copilot` (VS Code), `jetbrains`, `zed`

### Recommended: Add Ollama for real semantic search

```bash
ollama pull nomic-embed-text
```

neuromcp auto-detects it. No config needed.

## Installation

### Claude Code

```jsonc
// ~/.claude.json → mcpServers
{
  "neuromcp": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "neuromcp"]
  }
}
```

### Claude Desktop

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "neuromcp": {
      "command": "npx",
      "args": ["-y", "neuromcp"]
    }
  }
}
```

### Cursor / Windsurf / Cline

Same format — add to your editor's MCP settings. Copy-paste configs for
every client live in [`examples/`](examples/).

### Shared daemon (recommended when you run multiple clients)

By default each client spawns its own `neuromcp` process. One shared
background daemon serves them all instead — one database connection, one
embedding pipeline, no cold start per client:

```bash
npx neuromcp-enable-daemon --port 3200   # macOS launchd agent; verify with: curl -s http://127.0.0.1:3200/health
```

Then point clients at the daemon:

```jsonc
// Claude Code (~/.claude.json) — native HTTP transport
{ "neuromcp": { "type": "http", "url": "http://127.0.0.1:3200/mcp" } }

// Claude Desktop — stdio-only, bridge via neuromcp-connect.
// The bridge waits for the daemon on cold boot (plain mcp-remote exits
// fatally when the client starts before the daemon has bound its port,
// leaving a permanent "Server disconnected").
{ "neuromcp": { "command": "npx", "args": ["-y", "--package=neuromcp", "neuromcp-connect", "http://127.0.0.1:3200/mcp"] } }
```

The daemon binds loopback only, rejects non-allowlisted `Host` and
`Origin` headers (DNS-rebinding defense), and is unauthenticated by
design inside that boundary. Uninstall: `npx neuromcp-enable-daemon --uninstall`.

### Platform support

| Component | macOS | Linux | Windows |
|-----------|-------|-------|---------|
| MCP server (stdio + HTTP) | ✅ | ✅ (CI) | ⚠️ untested — native deps ship win-x64 prebuilds, reports welcome |
| Shared daemon autostart (`enable-daemon`) | ✅ launchd | manual systemd | ❌ |
| Auto-consolidation (`enable-consolidation`) | ✅ launchd | cron snippet | ❌ |
| Claude Code hooks | ✅ | ✅ | ⚠️ untested |

### Per-project isolation

```jsonc
// .mcp.json in project root
{
  "mcpServers": {
    "neuromcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "neuromcp"],
      "env": {
        "NEUROMCP_DB_PATH": ".neuromcp/memory.db",
        "NEUROMCP_NAMESPACE": "my-project"
      }
    }
  }
}
```

## MCP Surface

**46 tools** across 8 families — the full auto-generated reference with
every parameter lives in [`docs/TOOLS.md`](docs/TOOLS.md) (regenerated
from the actual registrations on every change; CI fails when it drifts).

| Family | Tools | Highlights |
|--------|-------|-----------|
| Core memory | 11 | `store_memory` (dedup + contradiction detection + surprise scoring), `search_memory` (hybrid RRF + explain metadata), `recall_answer` (extractive cited answers with gap-analysis), `search_all` |
| Knowledge graph | 6 | `create_entity`, `create_relation`, `query_graph`, `compute_centrality` (PageRank) |
| Episodes | 10 | `start_episode`/`end_episode`, clustering, `memory_timeline` |
| Multi-agent | 9 | `register_agent`, `find_expert`, review queues, memory transfer |
| Verbatim store | 3 | exact-recall FTS on raw text, never summarized or pruned |
| Wiki | 3 | `wiki_ingest`, `wiki_lint`, `wiki_briefing` |
| Attribution & usefulness | 3 | `log_retrieval`, `cite_memories` — closes the usefulness-prior loop |
| Reflection | 1 | `generate_reflection` |

**Picking the right retrieval tool:** `search_memory` returns ranked raw
memories; `recall_answer` synthesizes a cited extractive answer (or
honestly says `not_in_memory`); `recall_memory` is a plain ID/filter
lookup with no semantics; `search_all` adds the verbatim store to the
sweep.

### Resources (13)

| URI | Description |
|-----|-------------|
| `memory://stats` | Global statistics |
| `memory://recent` | Last 20 memories |
| `memory://namespaces` | All namespaces with counts |
| `memory://health` | Server health + metrics |
| `memory://stats/{namespace}` | Per-namespace stats |
| `memory://recent/{namespace}` | Recent in namespace |
| `memory://id/{id}` | Single memory by ID |
| `memory://tag/{tag}` | Memories by tag |
| `memory://namespace/{ns}` | All in namespace |
| `memory://consolidation/log` | Recent consolidation entries |
| `memory://operations` | Active/recent operations |

### Prompts (3)

| Prompt | Description |
|--------|-------------|
| `memory_context_for_task` | Search relevant memories and format as LLM context |
| `review_memory_candidate` | Show proposed memory alongside near-duplicates |
| `consolidation_dry_run` | Preview consolidation without applying |

## Wiki Knowledge Base

The wiki is the compiled, human-readable knowledge layer. It replaces the chaos of session logs with structured, interlinked Markdown pages.

### Why a wiki instead of more vector search?

| Traditional RAG | neuromcp Wiki |
|----------------|---------------|
| Re-derives answers every query | Knowledge compiled once, refined over time |
| Chunking artifacts, retrieval noise | Human-readable pages with source citations |
| Vector DB, embedding pipeline | Plain Markdown + Git |
| Black box retrieval | Auditable, editable, portable |
| Knowledge evaporates | Knowledge compounds |

### Wiki page format

```markdown
---
title: My Project
type: project
created: 2026-04-06
updated: 2026-04-06
confidence: high
related: [other-project, oauth-setup]
---

# My Project

Description, stack, auth, deployment details...
```

### How to use

The wiki works automatically once hooks are installed. The LLM:
1. Reads `index.md` at session start to know what knowledge exists
2. Reads specific pages when relevant to the current task
3. Updates pages when learning something new
4. Gets reminded every 8 tool calls if the wiki needs updating

You can also browse and edit the wiki manually — it's just Markdown files.

### Auto-consolidation (optional)

Once you accumulate raw session logs, the wiki can be kept fresh automatically. A scheduled job reads unprocessed sessions, groups them per project (by detecting `$HOME/projects/<name>` paths in the session content), and uses the `claude` CLI to synthesise a `## [date]` entry into the right wiki page.

```bash
npx neuromcp-enable-consolidation
```

**What it installs:**
- `~/.neuromcp/scripts/consolidate-sessions.py` — the worker
- `~/.neuromcp/scripts/run-consolidation.sh` — threshold-guarded runner
- **macOS**: a launchd agent that fires every 4 hours (`com.neuromcp.consolidate`)
- **Linux**: prints a cron snippet to add manually

**Requirements:**
- `python3` ≥ 3.8 on `PATH`
- the [`claude` CLI](https://claude.com/claude-code) on `PATH`

**Guards built in:**
- Threshold: skip if fewer than 5 unprocessed sessions
- Output is extracted from a fenced markdown block; apology/narration text is rejected
- Ledger (`~/.neuromcp/consolidation-ledger.json`) makes re-runs idempotent
- Large project backlogs are auto-batched (default 15 sessions per `claude` call; override with `--max-sessions`)

**Uninstall:** `npx neuromcp-enable-consolidation --uninstall`

**Change interval:** `npx neuromcp-enable-consolidation --interval 7200` (every 2 hours)

**Hallucination guard (eval-loop).** Every consolidator output goes through a second Haiku audit before the wiki is touched. If any factual claim in the generated summary is not traceable to the raw sessions, the chunk goes to `~/.neuromcp/review-queue/` instead of the wiki. No hallucinated claims leak through.

**Atomic facts with temporal supersession.** After a summary is approved, it is also distilled into short standalone facts and stored as `category='fact'` rows with `valid_from=today`. When a new fact is Jaccard-similar to an existing one in the same project, Haiku decides whether NEW supersedes OLD — if yes, the old row gets `superseded_by_id` and `valid_to` set. Retrieval defaults to current facts only (`superseded_by_id IS NULL`), so outdated conclusions never resurface.

### Auto-retrieve + hybrid indexing

Once the wiki has content, make it *searchable* so the `UserPromptSubmit` hook can surface relevant pages automatically (no more "LLM must remember to call `search`"):

```bash
npx neuromcp-index-wiki              # index wiki pages into memories_fts + memories_vec
npx neuromcp-index-wiki --rebuild    # wipe wiki entries first, then reindex
npx neuromcp-index-wiki --dry-run    # preview what would change
npx neuromcp-index-wiki --no-embed   # FTS-only mode (no embedding provider needed)

npx neuromcp-backfill-embeddings     # embed any memory still missing a vector
```

The indexer splits each page on `##` section headers and stores every section as a deduplicated memory (`source='wiki'`, `category='wiki'`). Each section is both written to the FTS5 index *and* embedded via the configured provider (Ollama → OpenAI → ONNX) so vector search works too.

At prompt time the `neuromcp-auto-retrieve.js` hook calls `neuromcp-query`, which runs FTS5 BM25 and sqlite-vec cosine search in parallel and fuses the rankings via **Reciprocal Rank Fusion** (k=60). The top-3 merged results are injected as `<neuromcp-recall>` context.

The hook is installed automatically by `neuromcp-init-wiki` and registered under `UserPromptSubmit` in Claude Code's `settings.json`. Re-run the indexer after large wiki updates (or schedule it — it's idempotent).

**Tuning:**

| Env var | Default | Purpose |
|---------|---------|---------|
| `NEUROMCP_BM25_THRESHOLD` | `-1.0` | Stricter (more negative) = fewer weak keyword matches |
| `NEUROMCP_QUERY_BIN` | auto-detect | Override the `neuromcp-query` binary path |
| `NEUROMCP_NO_EMBED` | `0` | Set to `1` to force FTS-only indexing |
| `NEUROMCP_CONTRADICTION_CHECK` | `1` | Set to `0` to skip Haiku supersession judgments |
| `NEUROMCP_AUDIT_FAIL_OPEN` | `0` | Set to `1` to bypass the consolidator audit on infrastructure failure (default is fail-CLOSED) |

### Known upstream issues

**`memories_vec` does not reclaim space after DELETE** — [sqlite-vec #54](https://github.com/asg017/sqlite-vec/issues/54) / [#265](https://github.com/asg017/sqlite-vec/issues/265). When you re-index after editing wiki sections, the old vector rows are marked deleted but their storage stays. The database file grows monotonically until you run `npx neuromcp-index-wiki --rebuild`, which drops and re-creates the vector rows. Run a rebuild every few weeks if you edit the wiki heavily.

**`claude` CLI streaming hangs from non-TTY subprocesses on macOS** — if you script interactions with `claude -p` from another process (e.g. scheduled jobs), pipe it through `script -q /dev/null` to allocate a pseudo-TTY. Without that the stdout buffer never flushes. We work around this inside the consolidator where needed.

## Memory Governance

**Namespaces** isolate memories by project, agent, or domain.

**Trust levels** (`high`, `medium`, `low`, `unverified`) rank search results and control decay resistance.

**Soft delete** tombstones memories — recoverable for 30 days.

**Content hashing** (SHA-256) deduplicates at write time.

**Lineage tracking** records source, project ID, and agent ID per memory.

## Configuration

All via environment variables. Defaults work for most setups.

| Variable | Default | Description |
|----------|---------|-------------|
| `NEUROMCP_DB_PATH` | `~/.neuromcp/memory.db` | Database file path |
| `NEUROMCP_EMBEDDING_PROVIDER` | `auto` | `auto`, `onnx`, `ollama`, `openai` |
| `NEUROMCP_DEFAULT_NAMESPACE` | `default` | Default namespace |
| `NEUROMCP_AUTO_CONSOLIDATE` | `false` | Enable periodic consolidation |
| `NEUROMCP_TOMBSTONE_TTL_DAYS` | `30` | Days before permanent sweep |
| `NEUROMCP_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## What's new

Full history in [CHANGELOG.md](CHANGELOG.md). Recent highlights:

- **v0.27** — security release: CWE-22 path-traversal fix in `wiki_ingest`,
  MCP-spec `Origin` validation on the daemon, `neuromcp-connect`
  boot-race-safe Claude Desktop bridge, runtime health-check hook.
- **v0.26** — `recall_answer` (deterministic extractive answers with
  citations + gap-analysis, no LLM on the read path), optional local
  cross-encoder reranker (ships default-off after an honest A/B),
  recall-quality correctness sweep.
- **v0.20–0.25** — shared HTTP daemon, session isolation, critic hook,
  entity dedup canonicalization, distractor benchmark hardening.

### Explain mode

Every `search_memory` result includes an `explain` field so you can audit
what the system remembers and why it surfaced:

```json
{
  "explain": {
    "source_trust": { "level": "high", "reason": "Directly provided by user" },
    "temporal_validity": { "currently_valid": true, "superseded_by": null },
    "contradictions": [{ "memory_id": "abc", "content_preview": "...", "resolution": "coexist" }],
    "claims": [{ "subject": "neuromcp", "predicate": "version", "object": "0.26.0" }],
    "confidence": { "retrieval_score": 0.016, "source_trust_score": 1.0, "overall": 0.85 }
  }
}
```

Contradiction resolution is three-tier: **supersede** (score > 0.5, old
memory invalidated), **coexist** (0.35–0.5, both kept + linked via a
`contradicts` graph edge), **flag** (0.3–0.35, reported for review).

## Troubleshooting

```bash
npx neuromcp-doctor
```

One run checks: Node version, native modules actually loadable
(`better-sqlite3`, `sqlite-vec`), database openable, shared daemon
`/health`, Ollama reachable + `nomic-embed-text` pulled, ONNX fallback
model present. Exit codes: `0` healthy, `1` degraded (e.g. no Ollama —
ONNX fallback active), `2` broken. Start every bug report with its
output.

## Comparison

| Feature | neuromcp | Hindsight | Mem0 | Letta/MemGPT | agentmemory |
|---------|----------|-----------|------|--------------|-------------|
| **LongMemEval R@5 (oracle)** | **99.8%** | — | — | — | — |
| **LongMemEval R@5 (1000 distractors, n=5, Ollama)** | **100%** (preliminary, CI [57%, 100%]) | not published | not published | not published | not published |
| Search | Hybrid (vector + FTS + RRF + graph) | Vector + rerank | Vector | Vector | Vector |
| Auto-capture | Deterministic (no LLM cost) | LLM extraction | No | Agent self-edit | Yes |
| Explain mode | Yes (trust, contradictions, claims) | No | No | No | No |
| Knowledge graph | Entities, relations, PageRank | Entities + beliefs | No | No | No |
| Contradiction detection | 3-tier (supersede/coexist/flag) + graph edges | Belief updating | No | No | No |
| Temporal validity | valid_from/valid_to on memories + relations | Yes | No | No | No |
| Wiki knowledge base | Compiled Markdown + Git | No | No | Tiered blocks | No |
| Local-first | SQLite, zero cloud | SQLite | Cloud / Postgres | Server | Local |
| Embeddings | Built-in ONNX (zero config) + Ollama | External | External API | External | External |
| Governance | Namespaces, trust levels, soft delete | Namespaces | API keys | Agent-scoped | Cross-agent |
| Infrastructure | Zero | Zero | Cloud account | Server | Zero |
| Pricing | Free (AGPL-3.0) | Free (MIT) | Freemium ($23.9M funded) | Free ($10M funded) | Free (Apache-2.0) |

## License

**AGPL-3.0** for the engine in `src/`. **MIT** for `bin/`, `templates/`,
`scripts/`, `docs/`, and `examples/` (carve-out — see `LICENSE-EXAMPLES`).

### License FAQ

**Can I use neuromcp commercially?** Yes. Running neuromcp as part of your
own application, on your own infrastructure, is unrestricted. AGPL only
imposes obligations if you **modify** the engine code AND **distribute** or
**host** it as a network service.

**Can I install neuromcp from npm in my closed-source product?** Yes. Using
the published binary as a dependency does not trigger AGPL contagion.

**What if I host neuromcp as a SaaS?** Then AGPL §13 applies: you must make
the source code (including your modifications) available to your users.
This is the explicit anti-fork clause we chose for the engine — it stops
well-funded competitors from taking the code, putting it behind a login,
and shipping it as their own product.

**Can I copy a CLI script or template?** Yes. Everything in `bin/`,
`templates/`, `scripts/`, `docs/`, and `examples/` is dual-licensed
AGPL-3.0 OR MIT. Pick MIT in your downstream project.

**Need different terms for the engine?** Commercial dual-license is
available — contact the maintainer.
