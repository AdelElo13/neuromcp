# Outreach Tracker

Status: green-fielded 2026-04-24. Update weekly.

## Methodology

Score each target on R · A · L (reach × alignment × likelihood), each 1–5
(max 125). Sort by score. Work top-down. Don't pitch the bottom of the list
without first shipping the demo for the top.

## Top 15 (priority)

| # | Target | Score | Status | Last touch | Outcome |
|---|--------|-------|--------|------------|---------|
| 1 | punkpeye/awesome-mcp-servers (31K⭐) | 125 | not started | — | — |
| 2 | Continue.dev (24K⭐) | 100 | not started | — | — |
| 3 | Ollama (100K⭐) | 100 | not started | — | — |
| 4 | LibreChat (19K⭐) | 100 | not started | — | — |
| 5 | Open WebUI (70K⭐) | 100 | not started | — | — |
| 6 | appcypher/awesome-mcp-servers (12K⭐) | 100 | not started | — | — |
| 7 | LM Studio (4M downloads) | 80 | not started | — | — |
| 8 | Aider (24K⭐) | 64 | not started | — | — |
| 9 | CrewAI (26K⭐) | 64 | not started | — | — |
| 10 | Cursor (millions of users) | 60 | not started | — | — |
| 11 | LangChain / LangGraph (95K⭐) | 60 | not started | — | — |
| 12 | Mozilla AI / Lumigator | 60 | not started | — | — |
| 13 | SIDN Fonds / Bits of Freedom (NL) | 60 | not started | — | — |
| 14 | Proton / Lumo | 50 | not started | — | — |
| 15 | Zed editor | 36 | not started | — | — |

Status values: `not started → drafted → sent → acknowledged → in progress → merged|declined|stale`.

## Pre-flight checklist (do BEFORE first email)

- [ ] 90-second demo video published (install → first memory → airplane mode → recall)
- [ ] README rewrite landed on `main` with new positioning
- [ ] Public 500q benchmark result published with full reproducer
- [ ] `docs/comparison.md` neutral table vs Mem0/mcp-memory-service
- [ ] `docs/integrations/{continue,cursor,ollama,librechat,lm-studio,aider,open-webui}.md` copy-paste configs
- [ ] Trademark application filed (Benelux BOIP first)

## Sequence (4-week cadence)

- **Week 1**: ship demo + README + comparison page. NO outreach yet.
- **Week 2**: 5 PRs to awesome-mcp-server lists. Lowest effort, highest reach.
- **Week 3**: 5 MCP-client maintainers (Continue, LibreChat, LM Studio, Aider, Open WebUI).
- **Week 4**: 5 framework + privacy targets (Ollama joint demo, CrewAI, LangChain, SIDN Fonds, Mozilla.ai).

## Templates

Email templates live in `docs/outreach/`:

- `mcp-client-template.md` — "3-line integration" hook, used for Continue/LibreChat/Aider.
- `local-llm-peer-template.md` — joint demo proposal, used for Ollama/LM Studio.
- `privacy-org-template.md` — story angle, used for Proton/Mozilla/Bits of Freedom.

Personalise the opener; never send a template verbatim.

## Logging

After each contact, append a line to `METRICS.md` with `[outreach]` prefix.
Replies that produce a merged PR or featured listing flow to that file too.
