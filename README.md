# neuromcp

**Local-first MCP memory server — 99.8% Recall@5 on LongMemEval oracle split (100 questions), zero API calls.**

Local-first MCP server with hybrid search, verbatim recall, and crash-resilient session persistence.

[![npm version](https://img.shields.io/npm/v/neuromcp)](https://www.npmjs.com/package/neuromcp)
[![npm downloads](https://img.shields.io/npm/dw/neuromcp)](https://www.npmjs.com/package/neuromcp)
[![license](https://img.shields.io/npm/l/neuromcp)](./LICENSE)

```bash
npx neuromcp
```

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

| Distractors | R@5 | R@10 | MRR | Hit Rate |
|-------------|-----|------|-----|----------|
| 0 | 100% | 100% | 100% | 100% |
| 1000 | 23.3% | 30.0% | 10.3% | 30.0% |

Reproduce: `npx tsx eval/longmemeval-distractor-runner.ts --limit 30 --distractors 1000`

This is the **honest** benchmark. At 1000 distractors the hybrid
ranker (BM25 + vector + attention + graph + usefulness prior) still
beats random-baseline (~0.5%) by 40x, but we're far from
oracle-clean accuracy. Closing that gap is active work: the
semantic critic loop accumulates helpful/harmful signal, the
Thompson-gated usefulness prior re-ranks, and reflection surfaces
high-confidence memories over time.

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

### 1. Start the MCP server

```bash
npx neuromcp
```

### 2. Initialize the wiki + hooks (**required** for closed-loop attribution)

```bash
npx neuromcp-init-wiki
```

This creates the wiki structure, installs hooks (Claude Code) and rules (other editors), and configures everything automatically. **Without this step**, `npx neuromcp` still runs as a plain MCP server with 42 tools, but the critic hook that closes the attribution loop is not installed — retrieval works but usefulness scores never accumulate. Safe to run multiple times — won't overwrite existing config.

### Editor Compatibility

neuromcp works with any MCP-compatible editor. Two tiers of integration:

| Feature | Claude Code | Cursor / Windsurf / Cline / Copilot / JetBrains / Zed |
|---------|-------------|-------------------------------------------------------|
| MCP tools (40+) | Full | Full |
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

Same format — add to your editor's MCP settings.

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

### Core Tools

| Tool | Description |
|------|-------------|
| `store_memory` | Store with semantic dedup, contradiction detection, surprise scoring, entity extraction. |
| `search_memory` | Hybrid vector + FTS search with RRF ranking, graph boost, cognitive priming. Returns explain metadata (trust, contradictions, claims, confidence). |
| `recall_memory` | Retrieve by ID, namespace, category, or tags — no semantic search. |
| `forget_memory` | Soft-delete (tombstone). Supports `dry_run`. |
| `consolidate` | Dedup, decay, prune, sweep. `commit=false` for preview, `true` to apply. |
| `memory_stats` | Counts, categories, trust distribution, DB size. |
| `export_memories` | Export as JSONL or JSON. |
| `import_memories` | Import with content-hash dedup. |
| `search_all` | Unified search across extracted memories and verbatim text with source labels. |

### Verbatim Tools

| Tool | Description |
|------|-------------|
| `store_verbatim` | Store raw conversation text — no summarization, never pruned. |
| `search_verbatim` | Full-text search (FTS5) on verbatim entries for exact recall. |
| `verbatim_stats` | Stats on verbatim storage: total entries, size, distribution. |

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

## What's New in v0.9

### Auto-Capture (v0.9.0)

Session hooks automatically extract high-signal events — no manual `store_memory` calls needed:

| Detected | Category | How |
|----------|----------|-----|
| CronCreate / ScheduleWakeup calls | `intent` | Regex on transcript |
| "Remember this" / "Onthoud dit" | `decision` | Pattern matching |
| Domain monitoring (whois checks) | `intent` | Command detection |
| Key decisions ("we decided...") | `decision` | Language patterns |
| Deployments (npm publish, etc.) | `event` | Command detection |

### Full Pipeline Auto-Capture (v0.9.1)

Auto-captured memories now go through the full store pipeline: dedup, contradiction detection, embeddings, entity extraction, and claims — via HTTP endpoint (`POST /api/store`). Falls back to raw SQL when HTTP is unavailable.

Contradiction resolution now has three tiers:
- **Supersede** (score > 0.5): old memory invalidated, new one takes over
- **Coexist** (score 0.35–0.5): both kept, linked via `contradicts` edge in knowledge graph
- **Flag** (score 0.3–0.35): reported for review

### Explain Mode (v0.9.2)

Every `search_memory` result includes an `explain` field:

```json
{
  "explain": {
    "source_trust": { "level": "high", "reason": "Directly provided by user" },
    "temporal_validity": { "currently_valid": true, "superseded_by": null },
    "contradictions": [{ "memory_id": "abc", "content_preview": "...", "resolution": "coexist" }],
    "claims": [{ "subject": "neuromcp", "predicate": "version", "object": "0.9.2" }],
    "confidence": { "retrieval_score": 0.016, "source_trust_score": 1.0, "overall": 0.85 }
  }
}
```

No other memory system provides this level of transparency.

## Comparison

| Feature | neuromcp | Hindsight | Mem0 | Letta/MemGPT | agentmemory |
|---------|----------|-----------|------|--------------|-------------|
| **LongMemEval R@5** | **99.8%** | 91.4% | 49% | — | — |
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
| Pricing | Free (MIT) | Free (MIT) | Freemium ($23.9M funded) | Free ($10M funded) | Free (Apache-2.0) |

## License

MIT
