# Launch kit — Show HN · Product Hunt · X

Everything below is paste-ready. Numbers are the ones the repo can back up
today (README, `docs/BENCHMARK.md`, `eval/`); do not inflate them on the day.

**Timing.** Show HN: Tuesday–Thursday, 14:00–16:00 CET (08:00–10:00 ET).
Product Hunt: launch at 00:01 PT (09:01 CET) on a Tuesday or Wednesday; the
ranking day is PT. Post the X thread ~30 min after the HN post so it can link
to the live thread. Do not launch HN and PH on the same day — you cannot
answer two comment streams well at once.

**Day-of checklist.** Daemon + web UI running locally for screenshots; npm
`latest` == GitHub `Latest` == MCP registry `isLatest`; `npx neuromcp-init`
tested on a clean user account within the last 24 h; first HN reply drafted
(the "why AGPL" answer — it will come).

---

## Show HN

**Title** (≤ 80 chars, no marketing words):

```
Show HN: Neuromcp – local-first memory for any MCP client, no API keys
```

Alternative if the first reads too generic:

```
Show HN: I gave Claude, GPT and Cursor a shared memory that never leaves my laptop
```

**Body:**

```
Hi HN — I built neuromcp because every AI client I use forgets me the moment
the session ends, and the products that fix that keep the memory on their
servers.

neuromcp is an MCP server that gives any MCP-compatible client (Claude
Desktop/Code, Cursor, Windsurf, Codex CLI, Continue, LibreChat, …) a
persistent memory that lives in a SQLite file on your machine. Switch
models tomorrow; the memory follows.

What it does:

- Hybrid retrieval: local embeddings (nomic-embed-text via Ollama, ONNX
  fallback so it works offline) + BM25 + a small knowledge graph + a
  "usefulness" prior learned from which memories actually got used.
- Temporal validity: when a fact changes, the old one is superseded, not
  deleted — every read path returns the current version by default and
  you can ask for the history or a point-in-time view.
- A wiki layer: sessions are consolidated into plain Markdown pages
  (people/projects/systems/decisions) that the LLM reads at session start.
  It opens as an Obsidian vault.
- A built-in read-only browser on localhost: the entity graph and a topic
  timeline, served with a strict CSP and only on loopback.
- One command setup: `npx neuromcp-init` detects your clients and writes
  the configs (with backups). `npx neuromcp-doctor` tells you what is wrong
  when something is.

Numbers: 96.08% on LongMemEval-S (n=102, Opus generator + judge; the
reproduction guide and the honest distractor split are in docs/BENCHMARK.md
— the 500-distractor run holds R@5 at 93.3%). No telemetry, no accounts,
no API keys for the core path.

License is AGPL-3.0 for the engine with an MIT carve-out for the client
configs, templates and CLI, so integrating it into your editor setup is
unencumbered.

Repo: https://github.com/AdelElo13/neuromcp
npm: https://www.npmjs.com/package/neuromcp

Things I would love feedback on: the contradiction/supersession heuristics
(they are conservative on purpose — false positives are worse than misses),
and which clients you would want first-class support for next.
```

**Prepared replies** (the questions that always come):

- *Why AGPL?* — "The engine is AGPL so a hosted 'memory as a service' built
  on it has to stay open. Everything you touch as a user — configs,
  templates, the CLI, the hooks — is MIT, so wiring it into your editor or
  company setup has no copyleft implications."
- *How is this different from Mem0 / Zep / ChatGPT memory?* — point to
  `docs/comparison.md`; lead with "runs without an account, no API key,
  MCP out of the box" and never re-run their numbers on our harness.
- *Does it need Ollama?* — "No. Ollama gives you the 768-d model; without it
  the ONNX fallback (bge-small, 384-d) ships in the package and works
  offline. `neuromcp-doctor` shows which route you are on."
- *What about privacy of the web UI?* — "Loopback only; bind the daemon to
  a non-loopback host and the UI and JSON API are disabled entirely."

---

## Product Hunt

**Name:** neuromcp
**Tagline** (≤ 60 chars): `Sovereign memory for AI agents — local, portable, open`
**Topics:** Developer Tools · Artificial Intelligence · Open Source · Privacy

**Description:**

```
neuromcp gives every AI client you use — Claude, Cursor, Windsorf, Codex,
Continue and anything else that speaks MCP — one shared, persistent memory
that lives in a SQLite file on your own machine.

• Any model, your memory: switch from Claude to GPT to a local Ollama model
  and it still remembers who you are, what you decided and why.
• Local-first, for real: no account, no API key, no telemetry. Embeddings
  run locally (Ollama or a bundled ONNX model).
• Real recall: hybrid vector + BM25 + graph retrieval, 96% on LongMemEval-S.
• Facts change; memory keeps up: superseded facts are hidden by default but
  never lost — ask for the history or a point-in-time view.
• See what it knows: a built-in local memory browser with an entity graph
  and a topic timeline, plus a Markdown wiki that opens in Obsidian.
• One command: `npx neuromcp-init`.

Open source (AGPL-3.0 engine, MIT client integrations).
```

**First comment (maker):**

```
Hi everyone — maker here. I built this out of frustration: every assistant
I used forgot me between sessions, and the fixes all wanted my memory on
their servers. neuromcp keeps it in a SQLite file you own and exposes it
over MCP so any client can use it.

The part I am most proud of is temporal validity: when a fact changes, the
old version is superseded rather than deleted, so "what does it think is
true today?" and "what did it think last month?" are both answerable.

Happy to answer anything — especially about the benchmark methodology
(docs/BENCHMARK.md) and the contradiction heuristics.
```

**Gallery (in order):**
1. `docs/assets/memory-browser.png` — the graph + timeline (demo data).
2. Terminal: `npx neuromcp-init` output (record with a clean user account).
3. Claude Desktop with a `search_memory` call showing an `explain` block.
4. Obsidian graph of the wiki with colour groups.

---

## X thread (post ~30 min after HN)

```
1/ Every AI client I use forgets me between sessions. The products that fix
that keep my memory on their servers.

So I built neuromcp: a local-first memory for any MCP client. One SQLite
file, on your laptop, shared by Claude, Cursor, Codex, Continue, Ollama…

🧵

2/ Switch models tomorrow; the memory follows. No account, no API key, no
telemetry. Embeddings run locally (Ollama, or a bundled ONNX model when
you're offline).

3/ Facts change. neuromcp supersedes instead of deleting: every read
returns what's true *now*, and you can ask what it believed on any date.

4/ You can actually see what it knows: a built-in localhost browser with
the entity graph and a topic timeline — and the wiki layer opens straight
in Obsidian.

[memory-browser.png]

5/ Numbers, honestly: 96.08% on LongMemEval-S (n=102), R@5 93.3% at 500
distractors. Reproduction guide in the repo — run it yourself.

6/ Setup is one command:

npx neuromcp-init

Open source (AGPL engine, MIT integrations).
Repo: github.com/AdelElo13/neuromcp
HN thread: <link>
```

---

## After launch (first 72 h)

- Answer every HN/PH comment within the hour on day one.
- File every bug report as an issue the same day; ship fixes as patch
  releases (Trusted Publishing makes that a tag + `gh release`).
- Log recurring questions into `docs/QUICKSTART.md` / README FAQ.
- Then the outreach in `week2-awesome-mcp-pr.md`, `week3-mcp-clients.md`,
  `week4-frameworks-press.md` — in that order.
