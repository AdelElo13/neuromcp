# neuromcp client configuration examples

Everything in this `examples/` directory is MIT-licensed (see
`LICENSE-EXAMPLES` in the repository root) — copy, adapt and ship freely.

The fastest path is the interactive setup, which detects your clients and
writes these configs for you:

```bash
npx neuromcp-init
```

Prefer doing it by hand? Pick your client below. When something doesn't
work, run `npx neuromcp-doctor` first — it checks the daemon, Ollama, the
ONNX fallback model and the database, and tells you what to fix.

| File | Client | Mode |
|------|--------|------|
| [claude-desktop.json](claude-desktop.json) | Claude Desktop | per-client stdio (simplest) |
| [claude-desktop-daemon.json](claude-desktop-daemon.json) | Claude Desktop | shared daemon via `neuromcp-connect` (recommended with multiple clients) |
| [claude-code.json](claude-code.json) | Claude Code (`~/.claude.json` or project `.mcp.json`) | stdio |
| [claude-code-daemon.json](claude-code-daemon.json) | Claude Code | shared daemon over HTTP |
| [cursor.json](cursor.json) | Cursor (`~/.cursor/mcp.json`) | stdio |

## stdio vs shared daemon

**stdio** (default): each client spawns its own `neuromcp` process. Zero
setup, but N clients = N processes, each with its own embedding pipeline.

**Shared daemon**: one background process serves every client over
`http://127.0.0.1:<port>/mcp` — one database connection, one embedding
pipeline, no cold start per client. Install it with:

```bash
npx neuromcp-enable-daemon --port 3200   # macOS launchd; Linux: systemd manually
```

Stdio-only clients (Claude Desktop) reach the daemon through
`neuromcp-connect`, which also waits for the daemon on cold boot so the
client never sees "Server disconnected" after a reboot.
