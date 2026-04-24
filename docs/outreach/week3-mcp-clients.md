# Week 3 — MCP-client maintainer outreach (5 emails)

Send Tuesday or Wednesday, 09:00–11:00 in the recipient's timezone.
One email per day, NOT five at once. Track in `OUTREACH.md`.

---

## 1. Continue.dev — Ty Dunn <ty@continue.dev>

Subject: 3-line integration to give Continue users persistent memory (neuromcp)

Hi Ty,

Continue users on Reddit and GitHub keep asking for "remember what I said
last session." I built neuromcp to solve that — a Sovereign Memory MCP
server that gives any MCP client semantic memory, episodes, and verbatim
recall. Everything stays on disk; no cloud required.

Integration is literally three lines in `config.json`:

```json
"mcpServers": { "neuromcp": { "command": "npx", "args": ["-y", "neuromcp"] } }
```

That unlocks `search_memory`, `recall_memory`, and `store_memory` inside
Continue with zero infra on your side. TypeScript, AGPL-3.0 (engine) +
MIT (templates/CLI), no telemetry. 96.08% on LongMemEval-S (n=102, Opus
generator + judge, full 500q run pending).

I'd love to:

1. Open a PR adding a "Memory" section to your docs with a 30-second quickstart.
2. Record a 60-sec demo showing Continue remembering across sessions — yours to publish.
3. Ship any Continue-specific hooks you want (e.g. auto-store accepted diffs).

No ask beyond a link in docs if it passes your bar.

Repo: https://github.com/AdelElo13/neuromcp

Adel

---

## 2. LibreChat — Danny Avila (GitHub Discussion)

Title: Sovereign-Memory MCP integration for LibreChat — 3-line config?

Hi Danny,

LibreChat's privacy posture is what brought half your community in.
neuromcp is a local-first MCP memory server with the same posture — all
data in `~/.neuromcp/`, no telemetry, no cloud. I'd like to write a
recipe for the LibreChat docs that drops it into `librechat.yaml` in
about three lines.

Integration:

```yaml
mcpServers:
  neuromcp:
    command: npx
    args: [-y, neuromcp]
```

It gives every conversation persistent semantic recall, hybrid retrieval
(vector + BM25 + graph), and a Markdown wiki the user can audit by hand.
96.08% on LongMemEval-S (n=102). AGPL-3.0 engine + MIT templates. 297
unit + integration tests.

Happy to:
- Draft the docs page as a PR.
- Record a 90-sec demo of LibreChat remembering across restarts.
- Ship a LibreChat-specific hook for auto-storing accepted assistant turns.

Repo: https://github.com/AdelElo13/neuromcp

Adel

---

## 3. Aider — Paul Gauthier <paul@aider.chat>

Subject: Persistent memory for Aider — opt-in, local, three lines

Hi Paul,

Aider's `--read` brings repo files into context, but cross-session memory
("we decided last week to use Zod, not Yup") is still missing. neuromcp
is an MCP memory server I built to solve exactly that — local SQLite,
hybrid search, zero cloud.

Wire-up in `~/.aider.conf.yml` or via MCP client:

```yaml
mcp-servers:
  neuromcp:
    command: npx
    args: [-y, neuromcp]
```

Aider then gets `search_memory`, `store_memory`, `recall_memory` as
tools. The user ends a session, you (Aider) auto-store the diff context;
next session it surfaces relevant prior decisions. AGPL-3.0 engine, 297
tests, 96.08% on LongMemEval-S.

Two questions:
1. Would Aider accept a built-in toggle (e.g. `--memory neuromcp`) so
   users don't have to wire MCP themselves?
2. Or is the right pattern an external aider-memory adapter, with a
   docs page?

Either path I'm happy to do the work. Repo:
https://github.com/AdelElo13/neuromcp

Adel

---

## 4. LM Studio — team@lmstudio.ai (or Discord)

Subject: Memory layer for LM Studio's MCP support — local, fast install

Hi Yagil + team,

LM Studio shipped MCP support in 0.3.17. Most MCP servers in the wild
add memory by talking to a remote API; neuromcp keeps everything on the
user's disk in SQLite, which fits LM Studio's privacy story.

Install path:
1. `npm install -g neuromcp`
2. Add to LM Studio MCP config:
   ```json
   { "neuromcp": { "command": "neuromcp" } }
   ```

That's it. Local model (anything LM Studio runs) + local memory in one
process, no API keys. 96.08% on LongMemEval-S, AGPL-3.0 engine + MIT
templates.

Three concrete asks:
1. Featured-in-LM-Studio listing on your MCP marketplace.
2. A 60-second demo I can record for your launch material — local
   model + local memory + airplane mode.
3. Anything LM-Studio-specific you want me to build (hook, format adapter).

Repo: https://github.com/AdelElo13/neuromcp

Adel

---

## 5. Open WebUI — Tim Baek <tim@openwebui.com> + Discord

Subject: MCP memory server for Open WebUI — no cloud, AGPL-3.0

Hi Tim,

Open WebUI is the largest self-hosted AI UI; the next gap users are
asking about is persistent memory across chats. neuromcp does that as
an MCP server. Everything stays on the host machine — same posture as
Open WebUI itself.

Setup:

```json
{
  "mcpServers": {
    "neuromcp": { "command": "npx", "args": ["-y", "neuromcp"] }
  }
}
```

You get `store_memory`, `search_memory`, `recall_memory`, plus optional
session-summary observer and graph-based entity dedup. AGPL-3.0 engine
+ MIT templates. 297 tests, 96.08% on LongMemEval-S.

I'd like to:
1. Open a PR adding a Memory section to Open WebUI docs.
2. Record a side-by-side demo (with-memory vs without) you can use.
3. Ship an Open-WebUI-specific hook if there's a clear pattern you want.

Repo: https://github.com/AdelElo13/neuromcp

Adel
