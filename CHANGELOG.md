# Changelog

All notable changes to **neuromcp** are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.15.0] — 2026-04-20

### Added
- **Rescue script for rejected batches** (`scripts/rescue-rejected.py`).
  Parses the `> REJECTED — ...` reason, strips the unsupported claims
  from the summary, appends the cleaned content to the target wiki page,
  and archives the original file. No LLM calls — pure text surgery. Runs
  automatically after each consolidation pass.
- **Auto entity-linker** (`scripts/entity-linker.py`). Scans every wiki
  page for bare-word mentions of other registered entities
  (people/, projects/, systems/) and unions them into the page's
  `related:` frontmatter. Turns the wiki into a light knowledge graph
  without a separate graph database.
- **Auto index rebuilder** (`scripts/rebuild-index.py`). Generates
  `index.md` plus per-category `-index.md` files. Categories over 10
  pages are auto-split so `index.md` stays compact (the router loaded
  into every Claude session).
- **Consolidator prompt hardening.** The per-batch consolidation prompt
  now explicitly forbids: version numbers not quoted from sources, tier
  labels, roadmap speculation, decision rationales not in sources, root
  cause hypotheses, cross-references like `(zie boven)`, and any numbers
  not quoted from sources.
- **Auto-strip retry on audit rejection.** When `audit_summary` flags
  specific unsupported claims, `consolidate_batch` now strips those
  lines and re-audits once. If the stripped version passes, the clean
  summary is written. Prevents losing an entire batch over one or two
  speculative lines.

### Fixed
- **Auto-capture hook reliability.** `templates/hooks/neuromcp-auto-capture.js`
  no longer requires the `CLAUDE_HOOK_EVENT` env var — it now reads
  `hook_event_name` from the Stop payload on stdin, matching how
  current Claude Code runtimes dispatch hooks. Falls back to
  transcript-presence when neither signal is available.

### Changed
- **Consolidation runner orchestrates post-processing.**
  `scripts/run-consolidation.sh` now calls, in order:
  `consolidate-sessions.py` → `rescue-rejected.py` → `entity-linker.py`
  → `rebuild-index.py`. Each step is isolated (`|| true`) so a failure
  downstream does not block consolidation of new sessions.

## [0.14.2] — prior

Pre-existing release. See git history for details.
