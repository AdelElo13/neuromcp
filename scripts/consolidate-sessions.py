#!/usr/bin/env python3
"""
neuromcp — session consolidation pipeline

Reads raw session logs from ~/.neuromcp/raw/sessions/ and synthesises them
into per-project wiki pages under ~/.neuromcp/wiki/ via `claude -p`.

Portable: all paths derive from $HOME. Requires:
  - python3 (>= 3.8)
  - the Claude Code CLI on PATH (command: `claude`)

Usage:
  python3 scripts/consolidate-sessions.py
  python3 scripts/consolidate-sessions.py --since 2026-04-13
  python3 scripts/consolidate-sessions.py --last 10
  python3 scripts/consolidate-sessions.py --dry-run
  python3 scripts/consolidate-sessions.py --project mac-control-mcp
  python3 scripts/consolidate-sessions.py --max-sessions 60
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

HOME = Path.home()
NEUROMCP_DIR = HOME / ".neuromcp"
SESSIONS_DIR = NEUROMCP_DIR / "raw" / "sessions"
WIKI_DIR = NEUROMCP_DIR / "wiki"
LEDGER_FILE = NEUROMCP_DIR / "consolidation-ledger.json"

# Project detection: only paths under <HOME>/projects/<NAME> count as project signal.
PROJECT_PATH_RE = re.compile(
    rf"{re.escape(str(HOME))}/projects/([A-Za-z0-9_\-.]+)"
)

# Markdown fence with (optional) language hint
FENCE_RE = re.compile(r"```(?:markdown|md)?\s*\n(.*?)\n```", re.S)

# Apology / narration trigger words — if these appear inside the fence, reject output
APOLOGY_PATTERNS = re.compile(
    r"(?i)(I'll update|I will update|Let me|Based on|"
    r"Omdat ik|geef toestemming|geef groen licht|"
    r"ik probeer het opnieuw|ik zal|bevestig dat ik|geblokkeerd door|"
    r"Wil je dat ik|Geef Write|Geef Edit|permissie-instelling)"
)


def load_ledger() -> set[str]:
    if LEDGER_FILE.exists():
        return set(json.loads(LEDGER_FILE.read_text()).get("processed", []))
    return set()


def save_ledger(processed: set[str]) -> None:
    LEDGER_FILE.parent.mkdir(parents=True, exist_ok=True)
    LEDGER_FILE.write_text(json.dumps({"processed": sorted(processed)}, indent=2))


def get_unprocessed(since: str | None = None, last_n: int | None = None) -> list[Path]:
    ledger = load_ledger()
    if not SESSIONS_DIR.exists():
        return []
    sessions = sorted(s for s in SESSIONS_DIR.glob("*.md") if "checkpoint" not in s.name)
    if since:
        sessions = [s for s in sessions if s.name >= since]
    if last_n:
        sessions = sessions[-last_n:]
    return [s for s in sessions if s.name not in ledger]


def detect_project(content: str) -> str:
    """Return project name for a session.

    Only `<HOME>/projects/<NAME>` counts as a real project. Everything else
    falls back to "home" (the control-centre / dotfiles workspace).
    """
    matches = PROJECT_PATH_RE.findall(content)
    if matches:
        return Counter(matches).most_common(1)[0][0]
    return "home"


def group_by_project(sessions: list[Path]) -> dict[str, list[Path]]:
    groups: dict[str, list[Path]] = {}
    for s in sessions:
        project = detect_project(s.read_text(errors="replace"))
        groups.setdefault(project, []).append(s)
    return groups


def extract_markdown(raw: str) -> str | None:
    """Return clean markdown from the first fenced block, or None if missing/contaminated."""
    m = FENCE_RE.search(raw)
    if not m:
        return None
    content = m.group(1).strip()
    if not content:
        return None
    if APOLOGY_PATTERNS.search(content):
        return None
    return content


def consolidate_batch(
    project: str,
    batch: list[Path],
    batch_idx: int,
    batch_total: int,
) -> tuple[bool, list[Path]]:
    """Run a single `claude -p` call for one batch. Returns (ok, processed_sessions)."""
    session_text = "\n\n".join(
        f"=== {s.name} ===\n{s.read_text(errors='replace')[:1500]}"
        for s in batch
    )
    wiki_path = WIKI_DIR / "projects" / f"{project}.md"
    if not wiki_path.exists():
        wiki_path = WIKI_DIR / "systems" / f"{project}.md"
    current = wiki_path.read_text()[:2000] if wiki_path.exists() else "(no wiki page yet)"
    today = datetime.now().strftime("%Y-%m-%d")
    label = f"{today} batch {batch_idx}/{batch_total}" if batch_total > 1 else today
    prompt = f"""You are a memory consolidation agent. You produce ONLY markdown that is appended verbatim to a wiki file.

Project: {project} | Sessions in batch: {len(batch)} (batch {batch_idx}/{batch_total})

CURRENT WIKI PAGE (context, do not repeat):
{current}

SESSIONS:
{session_text}

STRICT INSTRUCTIONS:
- Output MUST start with ```markdown and end with ``` (one single fenced block).
- Inside the fence: a ## [{label}] section, max 30 lines.
- Cover: version changes, bugs (root cause + fix), decisions (with rationale), what works / what doesn't, next steps.
- DO NOT write: "I'll ...", "Let me ...", "Based on ...", or any narration before/after the fence.
- DO NOT attempt tool use (no Edit/Write). Only return text.
- If there is nothing substantive: a single bullet inside the fence, e.g. "## [{label}]\\n- No technical substance this window." — nothing else.
"""
    try:
        r = subprocess.run(
            ["claude", "-p", "--tools", "", "--no-session-persistence", prompt],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if r.returncode != 0 or not r.stdout.strip():
            print(f"  WARN: no output for {project} batch {batch_idx}/{batch_total}")
            return False, []
        extracted = extract_markdown(r.stdout)
        if not extracted:
            print(f"  WARN: fence missing or contaminated for {project} batch {batch_idx}/{batch_total}")
            return False, []
        projects_dir = WIKI_DIR / "projects"
        systems_dir = WIKI_DIR / "systems"
        target = projects_dir / f"{project}.md"
        if not target.exists() and (systems_dir / f"{project}.md").exists():
            target = systems_dir / f"{project}.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            with target.open("a") as f:
                f.write(f"\n\n{extracted}\n")
            print(f"  ✓ {target.name} batch {batch_idx}/{batch_total} ({len(batch)} sessions)")
        else:
            target.write_text(
                f"---\ntitle: {project}\ntype: project\ncreated: {today}\n---\n\n{extracted}\n"
            )
            print(f"  ✓ {target.name} created batch {batch_idx}/{batch_total} ({len(batch)} sessions)")
        return True, list(batch)
    except subprocess.TimeoutExpired:
        print(f"  ERROR: timeout on {project} batch {batch_idx}/{batch_total}")
        return False, []
    except FileNotFoundError:
        print("  ERROR: 'claude' CLI not found on PATH. Install Claude Code first.")
        sys.exit(1)


def consolidate_project(
    project: str,
    sessions: list[Path],
    dry_run: bool = False,
    max_sessions: int = 15,
) -> tuple[bool, list[Path]]:
    batches = [sessions[i : i + max_sessions] for i in range(0, len(sessions), max_sessions)]
    if dry_run:
        print(
            f"  [DRY RUN] {project}: {len(sessions)} sessions → "
            f"{len(batches)} batch(es) of max {max_sessions}"
        )
        return True, []
    any_ok = False
    processed: list[Path] = []
    for idx, batch in enumerate(batches, 1):
        ok, done = consolidate_batch(project, batch, idx, len(batches))
        if ok:
            any_ok = True
            processed.extend(done)
    return any_ok, processed


def main() -> None:
    p = argparse.ArgumentParser(description="neuromcp session consolidator")
    p.add_argument("--since", help="Only sessions dated >= YYYY-MM-DD")
    p.add_argument("--last", type=int, help="Only the last N sessions")
    p.add_argument("--dry-run", action="store_true", help="Show grouping, make no calls")
    p.add_argument("--project", help="Only this project")
    p.add_argument(
        "--max-sessions",
        type=int,
        default=15,
        help="Max sessions per claude call (default 15, bump to 60+ for backlog runs)",
    )
    args = p.parse_args()

    print(f"neuromcp consolidation — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    sessions = get_unprocessed(since=args.since, last_n=args.last)
    if not sessions:
        print("Nothing to process.")
        return

    print(f"{len(sessions)} unprocessed sessions")
    groups = group_by_project(sessions)
    if args.project:
        groups = {k: v for k, v in groups.items() if k == args.project}
        if not groups:
            print(f"Project '{args.project}' has no unprocessed sessions.")
            return

    ledger = load_ledger()
    ok_count = 0
    for project, psessions in groups.items():
        print(f"  {project} ({len(psessions)} sessions)...")
        success, done = consolidate_project(
            project,
            psessions,
            dry_run=args.dry_run,
            max_sessions=args.max_sessions,
        )
        if success:
            if not args.dry_run:
                ledger.update(s.name for s in done)
            ok_count += 1

    if not args.dry_run:
        save_ledger(ledger)
        log_path = WIKI_DIR / "log.md"
        if log_path.parent.exists():
            with log_path.open("a") as f:
                f.write(f"\n## [{datetime.now().strftime('%Y-%m-%d')}] consolidation | auto\n")
                f.write(
                    f"- {len(sessions)} sessions seen, "
                    f"{ok_count}/{len(groups)} projects updated\n"
                )

    print(f"\nDone: {ok_count}/{len(groups)} projects processed")


if __name__ == "__main__":
    main()
