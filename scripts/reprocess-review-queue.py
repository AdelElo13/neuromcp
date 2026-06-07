#!/usr/bin/env python3
"""
neuromcp — review-queue stale-file pruner

Walks `<NEUROMCP_DIR>/review-queue/*.md` and deletes any queued batch whose
project no longer has unprocessed sessions in the raw-sessions backlog. The
in-script retry loop in `consolidate-sessions.py` may eventually succeed in
a later launchd run (because the ledger does not advance on reject, so the
same sessions get retried each scheduled run), but the queue file from the
earlier failed run is not auto-removed. Without this pruner the queue grows
unboundedly even when the underlying batches have all succeeded.

Files in `review-queue/exhausted/` are never touched — those represent
batches that burned every in-script retry attempt and need human review.

Portable: paths derive from `$HOME` by default; both `$HOME` and
`$NEUROMCP_DIR` are environment-overridable (used by the integration test
to point the script at a tmpdir).

Usage:
  python3 scripts/reprocess-review-queue.py
  NEUROMCP_DIR=/tmp/foo python3 scripts/reprocess-review-queue.py
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

HOME = Path(os.environ.get("HOME", str(Path.home())))
NEUROMCP_DIR = Path(os.environ.get("NEUROMCP_DIR", str(HOME / ".neuromcp")))
REVIEW_QUEUE = NEUROMCP_DIR / "review-queue"
EXHAUSTED_DIR = REVIEW_QUEUE / "exhausted"
SESSIONS_DIR = NEUROMCP_DIR / "raw" / "sessions"
LEDGER_FILE = NEUROMCP_DIR / "consolidation-ledger.json"

# Filename format from consolidate-sessions.py `queue_for_review`:
#   <YYYY-MM-DDTHH-MM-SS>_<project>_batch<N>.md
QUEUE_FILE_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})_(.+)_batch(\d+)\.md$"
)
PROJECT_PATH_RE = re.compile(
    rf"{re.escape(str(HOME))}/projects/([A-Za-z0-9_\-.]+)"
)


def load_ledger() -> set[str]:
    if not LEDGER_FILE.exists():
        return set()
    try:
        data = json.loads(LEDGER_FILE.read_text())
        return {str(n) for n in data.get("processed", []) if isinstance(n, str)}
    except (json.JSONDecodeError, OSError):
        # Same fail-soft as consolidate-sessions.py: treat as empty, leave
        # everything in place this run.
        return set()


def detect_project(content: str) -> str:
    matches = PROJECT_PATH_RE.findall(content)
    if matches:
        return Counter(matches).most_common(1)[0][0]
    return "home"


def projects_with_pending_sessions() -> set[str]:
    """Return the set of project names that still have at least one session
    NOT in the ledger. A queue file pointing at such a project is *not* stale
    yet — the next consolidation run will give it another retry.
    """
    if not SESSIONS_DIR.exists():
        return set()
    ledger = load_ledger()
    projects: set[str] = set()
    for s in SESSIONS_DIR.glob("*.md"):
        if "checkpoint" in s.name:
            continue
        if s.name in ledger:
            continue
        try:
            projects.add(detect_project(s.read_text(errors="replace")))
        except OSError:
            continue
    return projects


def main() -> int:
    if not REVIEW_QUEUE.exists():
        print("review-queue/ does not exist — nothing to prune.")
        return 0

    pending_projects = projects_with_pending_sessions()
    pruned = 0
    kept = 0
    unparseable = 0

    for q in sorted(REVIEW_QUEUE.glob("*.md")):
        if not q.is_file():
            continue
        m = QUEUE_FILE_RE.match(q.name)
        if not m:
            unparseable += 1
            continue
        _stamp, project, _batch_idx = m.groups()
        if project in pending_projects:
            # Real pending work — leave alone, next consolidation will retry.
            kept += 1
            continue
        # All sessions for this project are in the ledger now — the batch
        # this file references has been superseded by a successful retry in
        # a later consolidation run. Safe to remove.
        try:
            q.unlink()
            pruned += 1
            print(f"  - pruned stale: {q.name}")
        except OSError as exc:
            print(f"  WARN: could not delete {q.name}: {exc}")

    exhausted_count = (
        sum(1 for p in EXHAUSTED_DIR.glob("*.md") if p.is_file())
        if EXHAUSTED_DIR.exists()
        else 0
    )
    print(
        f"Pruner: {pruned} stale removed, {kept} kept (still pending), "
        f"{unparseable} unparseable, {exhausted_count} in exhausted/"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
