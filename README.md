# neuromcp

Semantic memory for AI agents — local-first MCP server with hybrid search, governance, and consolidation.

```bash
npx neuromcp
```

## Features

- **Hybrid search** — vector + full-text with Reciprocal Rank Fusion (RRF) ranking
- **Memory governance** — namespaces, trust levels, soft delete, lineage tracking
- **Plan-then-commit consolidation** — dedup, decay, prune, sweep — never mutates without preview
- **Built-in ONNX embeddings** — bge-small-en-v1.5, zero config, no API keys
- **8 tools + 13 resources + 3 prompts** — full MCP protocol surface
- **SQLite storage** — single file, zero infrastructure, WAL mode
- **Structured observability** — stderr logging, metrics, operation IDs

## Quick Start

```bash
npx neuromcp
```

The server starts on stdio, creates `~/.neuromcp/memory.db` on first run, and downloads the ONNX embedding model automatically.

## Installation

### Claude Code

```jsonc
// ~/.claude.json
{
  "mcpServers": {
    "neuromcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "neuromcp"]
    }
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

Same MCP config format — add to your editor's MCP settings.

### Per-project (.mcp.json)

```jsonc
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

## Tools (8)

| Tool | Description |
|------|-------------|
| `store_memory` | Store a memory with semantic deduplication. Returns ID and whether it matched an existing memory. |
| `search_memory` | Hybrid vector + full-text search with RRF ranking. Supports filters by namespace, category, tags, trust, date range. |
| `recall_memory` | Retrieve memories by ID, namespace, category, or tags without semantic search. |
| `forget_memory` | Soft-delete (tombstone) memories matching filters. Supports `dry_run` mode. |
| `consolidate` | Merge near-duplicates, decay stale memories, prune low-value, sweep expired. Set `commit=true` to apply; `commit=false` for a dry-run plan. |
| `memory_stats` | Counts, categories, trust levels, importance distribution, and database size. |
| `export_memories` | Export as JSONL or JSON for backup or migration. |
| `import_memories` | Import from JSONL or JSON with content-hash deduplication. |

## Resources (13)

| URI | Description |
|-----|-------------|
| `memory://stats` | Global memory statistics across all namespaces |
| `memory://recent` | Last 20 memories across all namespaces |
| `memory://namespaces` | All namespaces with memory counts |
| `memory://consolidation/log` | Recent consolidation log entries |
| `memory://operations` | Active and recent operations |
| `memory://health` | Server health check with metrics snapshot |
| `memory://stats/{namespace}` | Statistics for a specific namespace |
| `memory://recent/{namespace}` | Last 20 memories in a specific namespace |
| `memory://id/{id}` | Retrieve a specific memory by ID |
| `memory://tag/{tag}` | Memories containing a specific tag |
| `memory://tag/{namespace}/{tag}` | Memories with a tag in a specific namespace |
| `memory://namespace/{ns}` | All memories in a namespace (up to 100) |
| `memory://consolidation/log/{operation_id}` | Consolidation log for a specific operation |

## Prompts (3)

| Prompt | Description |
|--------|-------------|
| `memory_context_for_task` | Search memories relevant to a task and format them as LLM context. |
| `review_memory_candidate` | Show a proposed memory alongside existing near-duplicates to decide whether to store it. |
| `consolidation_dry_run` | Preview proposed consolidation actions (merges, decays, prunes, sweeps) without applying them. |

## Memory Governance

**Namespaces** isolate memories by project, agent, or domain. Each memory belongs to exactly one namespace.

**Trust levels** (`high`, `medium`, `low`, `unverified`) indicate confidence in the memory source. Searchable as a filter.

**Soft delete** tombstones memories instead of removing them. Tombstoned records are retained for `NEUROMCP_TOMBSTONE_TTL_DAYS` (default 30) before permanent removal during consolidation sweeps.

**Content hashing** (SHA-256) provides deduplication at write time. Identical content in the same namespace is detected and the existing memory is returned instead of creating a duplicate.

**Lineage tracking** records the source (`user`, `auto`, `consolidation`, `claude-code`, `error`), project ID, and agent ID for each memory, enabling audit trails.

## Configuration

All configuration is via environment variables with sensible defaults.

| Variable | Default | Description |
|----------|---------|-------------|
| `NEUROMCP_DB_PATH` | `~/.neuromcp/memory.db` | SQLite database file path |
| `NEUROMCP_MAX_DB_SIZE_MB` | `500` | Maximum database size in MB |
| `NEUROMCP_EMBEDDING_PROVIDER` | `auto` | Embedding provider: `auto`, `onnx`, `ollama`, `openai` |
| `NEUROMCP_EMBEDDING_MODEL` | `auto` | Model name (auto-detected for ONNX) |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `NEUROMCP_EMBEDDING_URL` | — | Custom embedding API endpoint |
| `NEUROMCP_DEFAULT_NAMESPACE` | `default` | Default namespace for operations |
| `NEUROMCP_TOMBSTONE_TTL_DAYS` | `30` | Days before tombstoned memories are permanently swept |
| `NEUROMCP_AUTO_CONSOLIDATE` | `false` | Enable automatic periodic consolidation |
| `NEUROMCP_CONSOLIDATE_INTERVAL_HOURS` | `24` | Hours between automatic consolidation runs |
| `NEUROMCP_DECAY_LAMBDA` | `0.01` | Exponential decay rate for importance |
| `NEUROMCP_DEDUP_THRESHOLD` | `0.92` | Cosine similarity threshold for deduplication |
| `NEUROMCP_MIN_IMPORTANCE` | `0.05` | Minimum importance after decay before pruning |
| `NEUROMCP_AUTO_COMMIT_SIMILARITY` | `0.95` | Similarity above which dedup merges automatically |
| `NEUROMCP_SWEEP_INTERVAL_HOURS` | `6` | Hours between TTL sweep checks |
| `NEUROMCP_CLAUDE_CODE_INTEGRATION` | `auto` | Claude Code integration mode: `auto`, `enabled`, `disabled` |
| `NEUROMCP_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `NEUROMCP_LOG_FORMAT` | `text` | Log format: `text`, `json` |

## Comparison

| Feature | neuromcp | @modelcontextprotocol/server-memory | mem0 | cortex-mcp |
|---------|----------|--------------------------------------|------|------------|
| Search | Hybrid (vector + FTS + RRF) | Keyword only | Vector only | Vector only |
| Embeddings | Built-in ONNX (zero config) | None | External API | External API |
| Governance | Namespaces, trust, soft delete | None | None | Basic |
| Consolidation | Plan-then-commit (dedup, decay, prune, sweep) | None | None | Manual |
| Storage | SQLite (single file) | JSON file | Cloud / Postgres | SQLite |
| Infrastructure | Zero — runs locally | Zero | Cloud account required | Zero |
| MCP surface | 8 tools, 13 resources, 3 prompts | 5 tools | N/A | 4 tools |

## License

MIT
