# Week 4 — Frameworks + privacy press (5 targets)

## 1. Ollama joint demo — Jeff Morgan <jmorgan@ollama.com>

Subject: Local LLM + Sovereign Memory — joint demo for Ollama users?

Hi Jeff,

Ollama runs any model on the user's machine. neuromcp gives that model
persistent memory on the same machine. We're both making the "nothing
leaves the device" story real — want to co-publish the first end-to-end
Sovereign Memory demo?

What I'm proposing (I do the work):

- 90-second screen capture: `ollama run llama3.2` + Claude Desktop or
  LibreChat pointing at neuromcp. Model remembers across restarts. Zero
  outbound network calls during inference (verifiable with
  `neuromcp doctor audit-network`).
- A short "Ollama + neuromcp in 5 minutes" guide; you get final edit.
- Attribution that reads "featured by Ollama community" if that's fair —
  nothing more.

Value to Ollama: a concrete answer to "how do I give my local model
memory?" — which I see weekly in your Discord.

96.08% on LongMemEval-S (n=102), AGPL-3.0 engine + MIT templates,
TypeScript + SQLite, no telemetry.

Repo: https://github.com/AdelElo13/neuromcp

Adel

---

## 2. CrewAI adapter — João Moura <joao@crewai.com>

Subject: CrewAI memory adapter for neuromcp — opt-in PR?

Hi João,

CrewAI's memory layer is great for in-process agents. For multi-agent
systems where the user wants the same memory across crews, sessions, and
hardware, neuromcp adds Sovereign Memory: local SQLite, hybrid retrieval,
no cloud.

I'd like to open a PR adding `NeuromcpMemory` to crewai-tools (or
contrib), conforming to the existing `Memory` protocol. ~150 lines plus
docs. Optional dependency, no breaking changes.

Spec:
- `save(value)` → `store_memory` MCP call
- `search(query, k)` → `search_memory` MCP call
- Optional `recall(query)` for verbatim chunks

96.08% on LongMemEval-S; the multi-agent shared-namespace story is what
makes it interesting for CrewAI users specifically. Want me to draft the
PR or open an issue first to scope?

Repo: https://github.com/AdelElo13/neuromcp

Adel

---

## 3. LangChain community PR

Open: https://github.com/langchain-ai/langchain/issues with title:

> Proposal: NeuromcpMemory adapter in langchain-community

Body (paste-ready):

```markdown
neuromcp is a local-first MCP memory server (AGPL-3.0 engine + MIT
templates, TypeScript + SQLite). It exposes `store_memory`, `search_memory`,
and `recall_memory` over MCP. I'd like to contribute a
`langchain_community.memory.NeuromcpMemory` class that wraps the MCP
calls behind LangChain's `BaseMemory` interface.

- No new dependencies for users who don't enable it.
- Calls go through the user's local neuromcp install (`npx neuromcp`).
- 96.08% on LongMemEval-S (n=102, Opus + Opus judge).

Should I open the PR directly under langchain-community/memory, or
draft a design doc here first?

Repo: https://github.com/AdelElo13/neuromcp
```

---

## 4. Mozilla.ai / Lumigator — <hello@mozilla.ai>

Subject: Sovereign Memory benchmark contribution for Lumigator

Hi Mozilla.ai team,

Lumigator's mission to evaluate models for trustworthy AI is exactly
where Sovereign Memory belongs as a category. neuromcp is a local-first
AI memory MCP server (AGPL-3.0 engine, MIT templates). We score 96.08%
on LongMemEval-S (n=102, Opus + Opus judge) — top-tier among
local-first systems and competitive with cloud providers.

I'd like to:

1. Provide a reproducible LongMemEval harness contribution to Lumigator
   if you have a memory-evaluation track.
2. Co-author a piece on what "trustworthy memory" means once the
   industry stops shipping conversation history to vendors by default.

Open to whichever angle fits. Repo:
https://github.com/AdelElo13/neuromcp

Adel

---

## 5. SIDN Fonds grant application

Application portal: https://www.sidnfonds.nl/aanvraag

Project name: **neuromcp — Sovereign Memory voor AI agents**

Korte samenvatting (NL):

> neuromcp is een open-source MCP-geheugenserver die AI-modellen als
> Claude, GPT, en lokale Ollama-modellen voorziet van persistent geheugen
> dat volledig op de machine van de gebruiker blijft. Geen cloud, geen
> API-keys, geen vendor met een kopie van je gesprekken. Het project
> draait al productie bij solo-developers en early-adopters; deze
> aanvraag financiert (a) cross-device CRDT-synchronisatie zonder
> centrale server, (b) on-device LLM extractie via Ollama voor volledige
> end-to-end privacy, en (c) een NL-talige documentatie + onboarding
> voor het bredere Nederlandse open-source ecosysteem.

Aanvraagbedrag: €25.000 (range €5.000–€50.000)

Looptijd: 6 maanden

Relevantie voor SIDN: digitale soevereiniteit, open-source NL-stack,
privacy-by-architecture (niet door belofte). Past binnen "AI &
Soevereiniteit" focus.

Bijlagen:
- Repo link + benchmark resultaten
- 1-pager met roadmap + milestones (zie /docs/strategy/2026-04-22.md)
- CV maintainer
