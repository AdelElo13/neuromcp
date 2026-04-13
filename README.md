# neuromcp

**The #1 AI memory system on [LongMemEval](https://github.com/xiaowu0162/LongMemEval) — 99.9% Recall@5, zero API calls.**

Local-first MCP server with hybrid search, verbatim recall, and crash-resilient session persistence.

[![npm version](https://img.shields.io/npm/v/neuromcp)](https://www.npmjs.com/package/neuromcp)
[![npm downloads](https://img.shields.io/npm/dw/neuromcp)](https://www.npmjs.com/package/neuromcp)
[![license](https://img.shields.io/npm/l/neuromcp)](./LICENSE)

```bash
npx neuromcp
```

## Benchmark: #1 on LongMemEval

Tested on the full [LongMemEval](https://github.com/xiaowu0162/LongMemEval) benchmark — 500 questions, 6 categories, oracle split.

| System | R@5 | R@10 | Hit Rate | API Calls |
|--------|-----|------|----------|-----------|
| **neuromcp extracted** | **99.9%** | **100.0%** | **100.0%** | **0** |
| **neuromcp verbatim** | **99.8%** | **99.9%** | **100.0%** | **0** |
| MemPalace raw | 96.6% | — | — | 0 |
| MemPalace held-out | 98.4% | — | — | 0 |
| MemPalace hybrid + rerank | 100.0% | — | — | Yes (Claude Haiku) |
| OMEGA | 95.4% | — | — | Yes (GPT-4.1) |
| Mastra OM | 94.9% | — | — | Yes (GPT-5-mini) |
| RMM + GTE (ACL 2025) | 69.8% | — | — | Yes |

**Highest Recall@5 ever reported without external API calls.** The only systems scoring higher use paid LLM reranking (MemPalace hybrid uses Claude Haiku) or represent the theoretical ceiling from the original paper (RAG Oracle). neuromcp achieves this with pure local retrieval — no cloud, no API keys, no reranking.

<details>
<summary>Per-category breakdown</summary>

| Category | N | Extracted R@5 | Verbatim R@5 |
|----------|---|---------------|--------------|
| knowledge-update | 78 | 100.0% | 100.0% |
| multi-session | 133 | 100.0% | 100.0% |
| single-session-assistant | 56 | 100.0% | 100.0% |
| single-session-preference | 30 | 100.0% | 100.0% |
| single-session-user | 70 | 100.0% | 100.0% |
| temporal-reasoning | 133 | 99.6% | 99.2% |

</details>

Reproduce: `npx tsx eval/longmemeval-runner.ts`

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

### 2. Initialize the wiki (optional but recommended)

```bash
npx neuromcp-init-wiki
```

This creates the wiki structure, installs hooks (Claude Code) and rules (other editors), and configures everything automatically. Safe to run multiple times — won't overwrite existing config.

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
| **LongMemEval R@5** | **99.9%** | 91.4% | 49% | — | — |
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
