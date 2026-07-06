# Handoff plan — neuromcp v0.29.0 (herzien na Codex-review + eigen verificatie)

> Executor: Claude Code 4.8. Reviewer achteraf: Jarvis. **TDD verplicht**
> (test eerst, RED zien, dan fix, GREEN zien). Geen `any`, TS strict,
> project-logger (geen console.log in `src/`). Elke sub-taak = eigen commit.
> Branch: `feat/v0.29-current-validity-and-view`.
>
> **Waarom dit plan groter is dan "verberg superseded rows":** de eerste
> versie behandelde dit als een lokale read-fix. Codex-review + eigen
> code-verificatie (2026-07-06) toonde dat het een **systeembreed
> current-vs-historical invariant** is: als reads superseded rows verbergen,
> moeten ALLE leespaden dat consistent doen ÉN moeten schrijf/consolidatie
> geen levende history stilletjes mergen/prunen/onzichtbaar-maken. Alle
> onderstaande claims met ✓ zijn zelf geverifieerd tegen de code.

---

## KERNBESLISSING — definieer één gedeelde "current validity" bron van waarheid

Maak één helper en gebruik die overal (geen ad-hoc herhaling):

- SQL-fragment: `superseded_by_id IS NULL AND (valid_to IS NULL OR valid_to > :now)`
- In-memory predicaat: `(m.superseded_by_id === null) && (m.valid_to === null || m.valid_to > nowIso)`
- Beide achter een `include_superseded` opt-in (default false) en overschreven door een expliciete `valid_at` point-in-time query.
- Leg in `src/types.ts` of een nieuw `src/governance/validity.ts` vast: `currentValiditySql(nowIso)` + `isCurrent(memory, nowIso)`. Eén plek, overal hergebruikt.

**"Current" is het contract voor default reads. "Historical" is expliciet opt-in (`valid_at` of `include_superseded`). id-lookup is de enige bypass (expliciete fetch mag alles teruggeven).**

---

## FASE 1 — Current-validity invariant end-to-end (correctheid; blokkeert release)

### 1a. Read-paden — dek ALLE surfaces (Codex plan-review #1,#2,#5 — ✓ geverifieerd)
Voeg de current-filter toe, met `include_superseded` opt-in + `valid_at`-voorrang:

1. **`src/tools/search.ts`** — de in-memory loop (rond r362) IS niet genoeg: [search.ts:179](src/tools/search.ts) (vec) en [search.ts:191](src/tools/search.ts) (FTS) beperken kandidaten tot `candidateK` VÓÓR het filteren. **✓ geverifieerd.** Doe BEIDE:
   - push de current-filter in de FTS-SQL (`ftsCandidates`) en, waar sqlite-vec het toelaat, in de vec-query/join;
   - én overfetch `candidateK` ruim genoeg (bv. ×N) zodat verborgen rows het budget niet leegtrekken. Schrijf een **starvation-test**: veel superseded rows bovenaan de index, assert dat de actuele row alsnog in de top-k komt.
2. **`src/tools/recall.ts`** — voeg de current-filter toe wanneer `input.id === undefined && !include_superseded`. **Codex #3 (✓): óók `valid_to`**, niet alleen `superseded_by_id` — een expliciete `store_memory.valid_to` kan bestaan zónder supersede en mag default niet tonen. id-lookup bypasst.
3. **`src/transport/http.ts` `/api/search`** — twee paden:
   - normale hybride tak: leunt op searchMemory → erft de fix, maar test het expliciet;
   - **`chrono=1` tak** [http.ts:184](src/transport/http.ts): losse raw-SQL met alleen `is_deleted=0`. **✓ geverifieerd — dit is het LongMemEval chrono-pad.** Voeg dezelfde current-filter toe + `include_superseded`/`valid_at` query-params voor history.
4. **`src/tools/timeline.ts`** — [timeline.ts:43](src/tools/timeline.ts): `include_superseded:false` voegt nu alleen `is_deleted=0` toe (**✓ Codex #9, semantisch kapot**). Laat `false` de current-filter toepassen.
5. **`src/resources/index.ts`** ([r28](src/resources/index.ts), [r149](src/resources/index.ts)) + **`src/tools/stats.ts`** ([r26](src/tools/stats.ts)) — `memory://recent`, `memory://namespace/{ns}`, stats-counts gebruiken "active = is_deleted=0". Beslis expliciet: recent/namespace-resources tonen default current (met opt-in voor alles); stats mag óf current tellen óf beide apart rapporteren (`total` vs `current`) — kies één en documenteer.
6. **`src/tools/recall-answer.ts`** — loopt via searchMemory → erft de fix; geef `include_superseded` doorheen + schema-veld.

### 1b. Zod-schema's (`src/registration/core.ts`)
Voeg `include_superseded: z.boolean().optional()` toe aan `search_memory`, `recall_memory`, `recall_answer`, en `memory_timeline` waar nog niet aanwezig. Duidelijke description ("default false — only current facts").

### 1c. Write-path interacties die de read-fix BLOOTLEGT (correctheid)
1. **Re-store van een gesuperseerde fact** (Codex Task1 #1 — ✓ geverifieerd): [store.ts:117](src/tools/store.ts) exact-dedup en [store.ts:153](src/tools/store.ts) semantic-dedup matchen op `is_deleted=0` en geven `matched:true` zonder validity te resetten → ná de read-fix blijft de row onzichtbaar. **Beslis gedrag + implementeer:** als een dedup-match een gesuperseerde/verlopen row is, **revive** die row (zet `valid_to=NULL`, `superseded_by_id=NULL`, bump `valid_from`) i.p.v. een onzichtbare match terug te geven. Regressietest: A superseded door B → A opnieuw storen → A is weer current, B's contradiction-relatie consistent.
2. **Contradiction supersede-gate te los** (Codex Task1 #4 — ✓ geverifieerd): [contradiction.ts:41](src/cognitive/contradiction.ts) checkt dat beide predicaten in `MUTUALLY_EXCLUSIVE_PREDICATES` zitten maar **nooit dat ze gelijk zijn** → "uses React 18" kan door "requires Node 22" gesupersed worden. Vereis **gelijk genormaliseerd predicate** (`nt.predicate === ot.predicate` na normalisatie) OF een expliciete predicate-equivalence-map. Scherp ook de subject-match aan: `ns === os` of token-overlap i.p.v. kale substring (`includes`). Tests: React↔Node superseden NIET; echte same-predicate tegenspraak superseded WEL.

### 1d. Consolidation mag levende history niet slopen (Codex Task1 #2 — ✓ gekoppeld aan de invariant)
[dedup.ts:24](src/consolidation/dedup.ts), [decay.ts:35](src/consolidation/decay.ts), [sweep.ts:58](src/consolidation/sweep.ts) selecteren op `is_deleted=0`, niet op validity → superseded rows kunnen gemerged/decayed/gepruned worden, wat `valid_at`/historical recall breekt. **Beslis expliciet beleid** en implementeer consistent: superseded rows zijn "historical, bewaren" → sluit ze uit van dedup-merge en sweep-prune (of geef ze een aparte, tragere retentie). Test: een superseded row overleeft een consolidation-run en blijft opvraagbaar via `valid_at`.

### Verificatie Fase 1 (in reply, hard):
- Nieuwe suite `tests/unit/current-validity.test.ts` + uitbreidingen: RED-vóór en GREEN-ná per sub-taak.
- Dek de 7 scenario's uit de vorige planversie PLUS: candidate-starvation, chrono-pad, resources/stats, re-store-revive, React↔Node non-supersede, superseded-overleeft-consolidation.
- Volledige `npm test` groen; `npm run lint` exit 0; `npm run build` schoon; `npm run docs:tools:check` groen.
- **Live herbewijs** op de echte DB: herbouw+herstart daemon; `search_memory("git add diff cached stat deploy")` → GEEN `currently_valid:false` rijen meer; en een `valid_at`-query op een oud tijdstip geeft de historische row WEL.
- LongMemEval distractor `--limit 5 --distractors 200`: R@5 mag niet regresseren vs baseline (de chrono/candidate-wijziging raakt dit pad — dit is de belangrijkste no-regress-gate).

---

## FASE 1B — Losse atomiciteit/merge-safety bugs (Codex vond ze; eigen commits, zelfde release)

Deze staan LOS van supersession maar zijn echte data-loss-risico's. Elk eigen commit + test. 4.8 moet elke claim eerst zelf verifiëren tegen de code (regel-anchors zijn Codex' aanwijzing, niet bewezen door mij):

- **[HIGH] compress.ts ordering** ([compress.ts:101](src/consolidation/compress.ts) vs [:151](src/consolidation/compress.ts)): originals worden getombstoned + vectors verwijderd in de transactie, maar de digest wordt pas ná de transactie geëmbed/geïndexeerd. Crash ertussen = originals weg, digest niet zoekbaar. Fix: embed+vec+FTS van de digest vóór/binnen de commit, of maak de hele operatie herstelbaar (idempotent re-run).
- **[MEDIUM] store-batch.ts ordering** ([:193](src/tools/store-batch.ts) rows/FTS commit vóór vectors op [:300](src/tools/store-batch.ts)): bij vector-failure levende rows zonder vector. Maak atomair zoals `storeMemory()` al doet.
- **[MEDIUM] dedup keep-tracking** ([dedup.ts:35](src/consolidation/dedup.ts) + [executor.ts:60](src/consolidation/executor.ts)): één keep kan meerdere merge-proposals krijgen; laatste wint, tags/effective_importance van eerdere losers verdwijnen. Track keep-ids en merge tags/importance cumulatief.
- **[MEDIUM] entity-merge prefix false-positives** ([entity-merge.ts:95](src/consolidation/entity-merge.ts)): merget prefix-extensies binnen `entity_type` → "Apple"/"Apple Music", "Washington"/"Washington Post". Vereis extra bewijs (gedeelde memories / alias-metadata / exacte person-name pattern), niet kale prefix.
- **[MEDIUM] store-time dedup/contradiction global top-k** ([store.ts:146](src/tools/store.ts), [contradiction.ts:73](src/cognitive/contradiction.ts)): vector-zoek zonder namespace-pushdown, filtert later → in multi-namespace DB kunnen andere namespaces de top-k vullen en missen we dedup/contradictions in de eigen namespace. Push namespace in de vec-query (patroon bestaat al in search.ts).

Als een van deze bij verificatie niet reproduceert: noteer in FOUND-DURING-FIX.md met bewijs waarom niet, en sla over. Niet blind fixen.

---

## FASE 2 — Obsidian-bridge (ongewijzigd t.o.v. vorige plan, + Codex-hardening)

Zie vorige planversie voor de kern (`scripts/wiki-obsidian-bridge.mjs`, `related:` → `## Related` met `[[links]]`, idempotent, `--dry-run`, toekomstige writes emitten `[[links]]`, docs/OBSIDIAN.md). **Codex-toevoegingen:** sanitize `related`-waarden vóór `[[...]]` (geen `]]`/newline-injectie), behoud frontmatter byte-exact, test CRLF + trailing-newline, unit-tests uitsluitend tegen temp-dirs (nooit de echte wiki).

---

## FASE 3 — Daemon web-view (`/ui`) — met Codex' security-hardening

Kern zoals vorige planversie (`/api/graph`, `/api/timeline`, `/api/memory/:id`, `/ui` self-contained, read-only, achter host/origin-guard). **Verplichte toevoegingen uit de review:**

1. **XSS**: alle memory/entity-strings via `textContent`/DOM-API, NOOIT `innerHTML` met content. Test met een memory die `<img onerror=alert(1)>` bevat → mag niet uitvoeren.
2. **CSP-header** op `/ui`: `default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'` (alleen wat nodig is). Alles inline/same-origin, geen externe fetch.
3. **Non-loopback escape-hatch** ([daemon.ts:61](src/daemon.ts) `NEUROMCP_DAEMON_INSECURE_NON_LOOPBACK=1`): `/ui` + de read-APIs MOETEN dan **uit** staan (of auth vereisen) — anders publiceer je een unauthenticated memory-browser. Test: met de env-var aan geeft `/ui` 403/404.
4. **Geen error-detail-lek**: volg het `/api/store`-patroon (generieke message), NIET `/api/store-batch` ([http.ts:355](src/transport/http.ts) lekt `detail: msg`). Hard maken in tests.
5. **`namespace=*`**: `queryGraph` gebruikt `WHERE e.namespace = ?` ([graph.ts:128](src/tools/graph.ts)) → `/api/graph?namespace=*` wordt leeg. Handel `*` expliciet af (alle namespaces samen) of weiger met 400.

---

## GLOBALE GATES & OPLEVERING (v0.29.0)
1. `npm run lint` exit 0. 2. `npm run build` schoon. 3. `npm test` volledig groen. 4. `npm run docs:tools:check` groen. 5. LongMemEval distractor `--limit 5 --distractors 200` geen R@5-regressie vs baseline (**cruciaal** — Fase 1a raakt het chrono/candidate-pad). 6. CHANGELOG `[0.29.0]`: FIX (current-validity invariant end-to-end, contradiction-gate, consolidation-history-behoud, atomiciteitsbugs) + Added (Obsidian-bridge, web-view). Eerlijk, geen "known limitation". 7. Release-keten: version-bump + server.json + tag `v0.29.0` + GitHub release (triggert OIDC registry-workflow) + `npm publish` (vers token nodig — Adel). 8. Scope-creep → FOUND-DURING-FIX.md.

## Acceptatiecriteria waarop Jarvis toetst
- [ ] ALLE leespaden (search hybrid + chrono, recall, recall-answer, timeline, resources recent/namespace, stats) verbergen default superseded/verlopen rows; `valid_at` + `include_superseded` geven ze wel; id-lookup bypasst. Live herbewezen.
- [ ] Candidate-starvation-test groen (verborgen rows verdringen actuele niet uit top-k).
- [ ] Coexist-rows blijven zichtbaar (regressietest).
- [ ] Re-store van gesuperseerde fact → weer current (revive), niet onzichtbaar.
- [ ] React↔Node worden NIET gesupersed; same-predicate tegenspraak WEL.
- [ ] Superseded row overleeft consolidation en blijft via `valid_at` opvraagbaar.
- [ ] Fase 1B: elke bug gefixt-met-test of gemotiveerd afgeschreven in FOUND-DURING-FIX.
- [ ] Obsidian-grafiek gevuld, bridge idempotent, slug-sanitized.
- [ ] `/ui` read-only, XSS-veilig (textContent + CSP), uit bij non-loopback, geen error-detail-lek, `namespace=*` afgehandeld.
- [ ] Alle gates groen; v0.29.0 live op npm + registry + GitHub; geen R@5-regressie; CHANGELOG eerlijk.
