# neuromcp

Semantic memory for AI agents — local-first MCP server with hybrid search, governance, and consolidation.

[![npm version](https://img.shields.io/npm/v/neuromcp)](https://www.npmjs.com/package/neuromcp)
[![license](https://img.shields.io/npm/l/neuromcp)](./LICENSE)

```bash
npx neuromcp
```

## Why

AI agents forget everything between sessions. The default MCP memory server stores flat key-value pairs with keyword search — fine for "remember my name is Bob", useless for "what was the architectural decision we made about authentication last week?"

neuromcp solves this with **hybrid search** (vector embeddings + full-text), **memory governance** (namespaces, trust levels, lineage tracking), and **automatic consolidation** (dedup, decay, prune) — all running locally in a single SQLite file. No cloud, no API keys, no infrastructure.

## Before & After

| | Without neuromcp | With neuromcp |
|---|---|---|
| Session memory | Gone when you close the terminal | Persisted, searchable, ranked by relevance |
| Search | Exact keyword match | Semantic — "auth architecture" finds "JWT validation middleware" |
| Duplicates | Same fact stored 50 times | Content-hash dedup + similarity-based merge |
| Stale memories | Accumulate forever | Automatic decay, pruning, and TTL sweeps |
| Multi-project | Everything in one pile | Namespace isolation per project |
| Trust | All memories equal | Trust levels (high/medium/low) + source tracking |
| Setup | API keys, cloud accounts, config files | `npx neuromcp` — zero config, runs locally |

## How It Works

```
Query: "how does auth work in this project?"
                │
                ▼
    ┌───────────────────────┐
    │   Hybrid Search       │
    │                       │
    │  Vector (semantic)    │──→ "JWT tokens validated in middleware" (0.87)
    │  FTS (keyword)        │──→ "auth module uses passport.js"     (0.91)
    │                       │
    │  RRF Fusion           │──→ Combined ranking, best results first
    └───────────────────────┘
                │
                ▼
    Filters: namespace, category, trust, date range
                │
                ▼
    Top results returned to agent
```

**Embeddings:** Auto-detects Ollama at localhost:11434 for real semantic search (nomic-embed-text). Falls back to built-in ONNX model (bge-small-en-v1.5) for basic similarity. Zero config either way.

**Storage:** Single SQLite file (`~/.neuromcp/memory.db`), WAL mode for concurrent access, content-hash deduplication at write time.

**Consolidation:** Plan-then-commit pipeline — preview what will change before applying. Deduplicates near-identical memories, decays old memories' importance over time, prunes below-threshold, sweeps tombstoned records past TTL.

## Real-World Example

```
You: Where were we with the payment integration?

Claude: [searches neuromcp for "payment integration"]

Found 3 relevant memories:
- (0.92) "Decided on Stripe over PayPal — better webhook reliability, 
         session from 2026-03-28"
- (0.87) "Payment webhook handler at src/api/webhooks/stripe.ts needs 
         idempotency keys — known bug, not yet fixed"
- (0.81) "Test coverage for payment module is at 64%, target is 80%"

Based on our previous sessions: we chose Stripe, the webhook handler 
needs idempotency keys (that's still open), and test coverage needs 
work. Want me to start with the idempotency fix?
```

## Quick Start

```bash
npx neuromcp
```

Creates `~/.neuromcp/memory.db` on first run. Downloads ONNX model automatically.

### Recommended: Add Ollama for real semantic search

```bash
# Install Ollama from https://ollama.com, then:
ollama pull nomic-embed-text
```

neuromcp auto-detects it. No config needed.

| Provider | Semantic Quality | Setup |
|----------|-----------------|-------|
| **Ollama + nomic-embed-text** | Excellent — real semantic understanding, 8K context | `ollama pull nomic-embed-text` |
| ONNX (built-in fallback) | Basic — keyword overlap, no deep semantics | Zero config |

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

### Tools (8)

| Tool | Description |
|------|-------------|
| `store_memory` | Store with semantic dedup. Returns ID and match status. |
| `search_memory` | Hybrid vector + FTS search with RRF ranking. Filters by namespace, category, tags, trust, date. |
| `recall_memory` | Retrieve by ID, namespace, category, or tags — no semantic search. |
| `forget_memory` | Soft-delete (tombstone). Supports `dry_run`. |
| `consolidate` | Dedup, decay, prune, sweep. `commit=false` for preview, `true` to apply. |
| `memory_stats` | Counts, categories, trust distribution, DB size. |
| `export_memories` | Export as JSONL or JSON. |
| `import_memories` | Import with content-hash dedup. |

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
| `memory://tag/{namespace}/{tag}` | Tag within namespace |
| `memory://namespace/{ns}` | All in namespace (max 100) |
| `memory://consolidation/log` | Recent consolidation entries |
| `memory://consolidation/log/{id}` | Specific operation log |
| `memory://operations` | Active/recent operations |

### Prompts (3)

| Prompt | Description |
|--------|-------------|
| `memory_context_for_task` | Search relevant memories and format as LLM context |
| `review_memory_candidate` | Show proposed memory alongside near-duplicates |
| `consolidation_dry_run` | Preview consolidation without applying |

## Memory Governance

**Namespaces** isolate memories by project, agent, or domain. Each memory belongs to exactly one namespace. Use `NEUROMCP_NAMESPACE` env var or specify per-operation.

**Trust levels** (`high`, `medium`, `low`, `unverified`) indicate confidence in the source. High-trust memories rank higher in search results and resist decay.

**Soft delete** tombstones memories instead of removing them. Tombstoned records survive for `NEUROMCP_TOMBSTONE_TTL_DAYS` (default 30) — recoverable until the next consolidation sweep.

**Content hashing** (SHA-256) deduplicates at write time. Identical content in the same namespace returns the existing memory instead of creating a duplicate.

**Lineage tracking** records source (`user`, `auto`, `consolidation`, `claude-code`, `error`), project ID, and agent ID per memory. Full audit trail for governance.

## Configuration

All via environment variables. Defaults work for most setups.

| Variable | Default | Description |
|----------|---------|-------------|
| `NEUROMCP_DB_PATH` | `~/.neuromcp/memory.db` | Database file path |
| `NEUROMCP_MAX_DB_SIZE_MB` | `500` | Max database size |
| `NEUROMCP_EMBEDDING_PROVIDER` | `auto` | `auto`, `onnx`, `ollama`, `openai` |
| `NEUROMCP_EMBEDDING_MODEL` | `auto` | Model name (auto-detected) |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `NEUROMCP_DEFAULT_NAMESPACE` | `default` | Default namespace |
| `NEUROMCP_TOMBSTONE_TTL_DAYS` | `30` | Days before permanent sweep |
| `NEUROMCP_AUTO_CONSOLIDATE` | `false` | Enable periodic consolidation |
| `NEUROMCP_CONSOLIDATE_INTERVAL_HOURS` | `24` | Consolidation frequency |
| `NEUROMCP_DECAY_LAMBDA` | `0.01` | Importance decay rate |
| `NEUROMCP_DEDUP_THRESHOLD` | `0.92` | Cosine similarity for dedup |
| `NEUROMCP_MIN_IMPORTANCE` | `0.05` | Prune threshold |
| `NEUROMCP_AUTO_COMMIT_SIMILARITY` | `0.95` | Auto-merge threshold |
| `NEUROMCP_SWEEP_INTERVAL_HOURS` | `6` | TTL sweep frequency |
| `NEUROMCP_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Comparison

| Feature | neuromcp | @modelcontextprotocol/server-memory | mem0 | cortex-mcp |
|---------|----------|--------------------------------------|------|------------|
| Search | Hybrid (vector + FTS + RRF) | Keyword only | Vector only | Vector only |
| Embeddings | Built-in ONNX (zero config) | None | External API | External API |
| Governance | Namespaces, trust, soft delete | None | None | Basic |
| Consolidation | Plan-then-commit | None | None | Manual |
| Storage | SQLite (single file) | JSON file | Cloud / Postgres | SQLite |
| Infrastructure | Zero | Zero | Cloud account | Zero |
| MCP surface | 8 tools, 13 resources, 3 prompts | 5 tools | N/A | 4 tools |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and guidelines.

## License

MIT
