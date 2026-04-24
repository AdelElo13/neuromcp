# Week 2 — Awesome-MCP-Servers PRs (5 lists)

For each list: open a PR adding **one row** under the existing "Memory" or
"Storage" section, no extra prose, link to repo + npm. Brevity = merge.

## Common PR title

```
Add neuromcp — local-first MCP memory server (AGPL-3.0)
```

## Common PR body (paste-ready)

```markdown
neuromcp gives any MCP-compatible client (Claude Desktop, Cursor, Continue,
LibreChat, LM Studio, …) persistent semantic memory that lives entirely on
the user's machine.

- **Sovereign Memory**: SQLite + sqlite-vec + BM25 + graph in one Node process. No cloud, no API key required.
- **LongMemEval-S**: 96.08% (n=102) with Claude Opus generator + Opus judge.
- **Install**: `npm install -g neuromcp` → add `{"command":"neuromcp"}` to your MCP client.
- **License**: AGPL-3.0 engine + MIT carve-out for templates/CLI.

Repo: https://github.com/AdelElo13/neuromcp
npm: https://www.npmjs.com/package/neuromcp
```

## Per-list line-item to insert

### 1. punkpeye/awesome-mcp-servers (top priority — 31K⭐)

Section: `Memory & Knowledge Management`. Add row alphabetically:

```markdown
- [neuromcp](https://github.com/AdelElo13/neuromcp) — Sovereign Memory MCP server. Hybrid retrieval (vector + BM25 + graph + usefulness prior), local SQLite, zero cloud dependencies. AGPL-3.0.
```

### 2. appcypher/awesome-mcp-servers (12K⭐)

Same row format under their `Memory` heading.

### 3. wong2/awesome-mcp-servers

Same. They have a "Knowledge & Memory" section.

### 4. yzfly/Awesome-MCP-ZH (Chinese audience)

Same row, but include Chinese tagline:

```markdown
- [neuromcp](https://github.com/AdelElo13/neuromcp) — 主权记忆 (Sovereign Memory) MCP 服务器, 完全本地, 96.08% LongMemEval-S 准确率.
```

### 5. modelcontextprotocol/servers (official list)

Read their CONTRIBUTING.md before opening; the official list has stricter
review rules. Submit only AFTER the four above are merged so we can claim
"featured in 4 awesome lists" in the PR body.

## Pre-flight checks before opening any PR

- [ ] README's hero + license badges match what the PR body claims
- [ ] `npm test` is green on the latest commit
- [ ] Latest npm publish version matches GitHub `main`
- [ ] At least one merged release tag exists (`git tag` shows v0.18.x or higher)
