# neuromcp — 5-minute quickstart

This is the tight version. The [README](../README.md) has the deep details.

## 1. Install

```bash
npx neuromcp-init
```

Detects your MCP clients (Claude Desktop, Claude Code, Cursor, Windsurf),
writes the config for each (backing up the originals), and initializes
the wiki + hooks. Prefer manual? Copy a config from
[`examples/`](../examples/), e.g.:

```bash
# Claude Code (runs from your shell, so npx is fine)
claude mcp add neuromcp -- npx -y neuromcp@latest
```

For **GUI clients** (Claude Desktop, Codex Desktop) use absolute paths —
they are launched without a login PATH and usually cannot find `node`:

```jsonc
{ "mcpServers": { "neuromcp": {
  "command": "/absolute/path/to/node",                       // which node
  "args": ["/absolute/path/to/neuromcp/bin/neuromcp.mjs"]    // npm root -g
} } }
```

`npx neuromcp-init` writes exactly that form for you.

First run creates `~/.neuromcp/memory.db` automatically.

## 2. Initialize the wiki + hooks (skip if you used neuromcp-init)

```bash
npx neuromcp-init-wiki
```

Required for the full experience on Claude Code: session-start context
injection, session-end persistence, and the critic hook that closes the
usefulness-attribution loop (step 5).

## 3. First store → first search

Inside a Claude Code session:

```
User: remember that my name is Adel and I live in Amsterdam
→ Claude will call store_memory automatically

User: what's my name?
→ Claude will call search_memory and answer from stored context
```

No setup, no API keys, no embeddings to configure. Default provider
is Ollama (`nomic-embed-text`) if you have it running locally; it
falls back to a built-in ONNX model otherwise.

## 4. Optional: turn on local semantic search

If Ollama is installed and running:

```bash
ollama pull nomic-embed-text
```

neuromcp auto-detects it on next start. 768-dim embeddings, fully
local, no data leaves your machine.

## 5. The critic loop (auto-installed)

`npx neuromcp-init-wiki` (step 2) installs and registers the
Stop hook `neuromcp-critic.cjs` automatically. After each Claude
Code session, this scans the transcript, finds which memories Claude
actually cited in its replies, and updates the usefulness prior so
future searches rank proven-helpful memories higher.

To verify it's active:

```bash
grep neuromcp-critic ~/.claude/settings.json
tail -3 ~/.neuromcp/critic.log  # after a few sessions
```

For strict per-session isolation set `NEUROMCP_SESSION_ID` in your
MCP server env (otherwise the critic falls back to temporal-only
scoping, which is still correct — just less paranoid).

## 6. See what's working

```
User: what do you remember about me?
User: show me the memory timeline for "project X"
User: which memories have been most useful?
```

or from the shell:

```bash
npx neuromcp-query --text "project X" --limit 5
node scripts/usefulness-dashboard.mjs          # weekly stats
node scripts/ab-sweep.mjs                      # retrospective A/B
```

## What neuromcp does that others don't

- **Local-first**: your conversations never leave your machine
- **Attribution-native**: every retrieval is logged, every answer can
  cite back, every memory accumulates a usefulness score
- **Temporal validity**: facts carry `valid_from` / `valid_to` so
  old knowledge doesn't fight new knowledge
- **Knowledge graph + attention retrieval**: hybrid BM25 + vector +
  graph + Kimi AttnRes-style attention all in one ranker
- **Thompson sampling exploration** (v0.17.0): no rich-get-richer
  feedback loops
- **[46 MCP tools](TOOLS.md)**: episodes, clusters, spaced repetition,
  consolidation, reflection — everything an agent needs to reason
  over persistent context

## Something broken?

```bash
npx neuromcp-doctor check          # add --json for a machine-readable report
```

Checks Node, native modules, the database, the shared daemon, Ollama, the
ONNX fallback and whether your vector index still matches a reachable
provider — with a fix-hint per failure.

If it reports a **dimension mismatch**, the server is running in degraded
mode (full-text search only). Restore the matching provider, or rebuild
the index on a copy first:

```bash
npx neuromcp-reembed           # dry run on a copy
npx neuromcp-reembed --apply   # swap in; original kept as *.pre-reembed-<ts>
```

## Where to go next

- `README.md` — the full feature tour
- `docs/TOOLS.md` — all 46 MCP tools, auto-generated from the registrations
- `CHANGELOG.md` — what's new in the latest release
- `ROADMAP.md` — what's planned
- `eval/longmemeval-runner.ts` — run the benchmark on your machine
