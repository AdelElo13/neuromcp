# neuromcp v2 — Schema (LLM Operating Rules)

## Bij sessie-start
1. Lees `wiki/index.md` (wordt geïnjecteerd via hook)
2. Als working directory een bekend project is → lees die project pagina
3. Gebruik wiki-kennis proactief — niet wachten tot het gevraagd wordt

## Tijdens sessie
Als je iets nieuws leert dat persistent moet zijn:
1. Update de relevante wiki pagina('s)
2. Als het een nieuw onderwerp is → maak een nieuwe pagina + update index.md
3. Append naar `wiki/log.md`

Wat is "persistent"?
- Nieuwe project info (URLs, keys, stack keuzes)
- User voorkeuren die je ontdekt
- Error patterns die je tegenkomt
- Beslissingen met context (waarom X gekozen boven Y)
- Herbruikbare procedures (hoe je iets hebt gedaan)

Wat is NIET persistent:
- Tijdelijke debug output
- Eenmalige vragen
- Informatie die al in de wiki staat

## Bij sessie-einde
De Stop hook doet automatisch:
1. Schrijft raw session log naar `raw/sessions/`
2. Git commit op de wiki (alle wijzigingen getrackt)

Jij (Claude) moet VOOR het einde van de sessie:
- Wiki pagina's updaten die door deze sessie zijn veranderd
- Je wordt elke 8 tool calls herinnerd via de [WIKI REMINDER] hook

## Wiki pagina formaat
```markdown
---
title: [Naam]
type: [person|project|system|pattern|decision|skill]
created: [YYYY-MM-DD]
updated: [YYYY-MM-DD]
confidence: [high|medium|low]
related: [lijst van gerelateerde pagina slugs]
---

# [Titel]

[Inhoud in Markdown]
```

## Regels
- Houd pagina's kort en scanbaar — bullets boven proza
- Update `updated` datum bij elke wijziging
- Voeg `related` links toe voor cross-referencing
- Contradictions: als nieuwe info een bestaand feit tegenspreekt, update het oude feit met de nieuwe info + noteer de wijziging in log.md
- Stale info: als een feit >90 dagen niet geüpdated is, markeer confidence als "low"

## Versioning
- De wiki is een git repo (~/.neuromcp/wiki/.git)
- Stop hook auto-commit na elke sessie
- Bij fouten: `git -C ~/.neuromcp/wiki log` en `git -C ~/.neuromcp/wiki diff HEAD~1` om te herstellen
