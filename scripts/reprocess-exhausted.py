#!/usr/bin/env python3
"""Re-audit consolidation batches that were exhausted before 0.30.3.

Until 0.30.3 the auditor rejected a whole batch for one unsupported line, so
thousands of mostly-correct summaries sit in ~/.neuromcp/review-queue/exhausted/.
This tool re-audits each stored summary against its source sessions, prunes the
lines the auditor flags (consolidate-sessions.prune_summary) and keeps only what
the auditor then approves. Nothing reaches the wiki unaudited.

Exhausted files written since 0.30.3 record their source sessions and are
re-audited against exactly those. Older files do not; with
--accept-guessed-sources their sources are guessed from ~/.neuromcp/raw/sessions:
sessions of the same project on the dates the summary names (else up to the
file's date) that contain its distinctive words. The auditor still rejects
claims those sessions do not support, but guessed provenance is weaker: a claim
true for another session can be attributed to the wrong date. Recovered
sections therefore carry the source list in an HTML comment, and no facts are
extracted from them (a fact stored "as of today" could supersede a newer one).

Modes (default --estimate, which makes NO model calls):
  --estimate                 counts per project + expected model calls
  --pilot N                  process N batches, write results to
                             review-queue/reprocess-pilot/ — the wiki is NOT touched
  --apply [--limit N]        append approved sections to the wiki, then move each
                             file to exhausted/recovered/ or exhausted/unrecoverable/
  --accept-guessed-sources   also process pre-0.30.3 files (guessed sources)
  --project P                only this project
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import json
import re
import shutil
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("consolidate_sessions", _HERE / "consolidate-sessions.py")
cs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cs)  # type: ignore[union-attr]

EXHAUSTED_DIR: Path = cs.EXHAUSTED_DIR
RAW_DIR: Path = cs.SESSIONS_DIR
PILOT_DIR: Path = cs.REVIEW_QUEUE / "reprocess-pilot"
RECOVERED_DIR = EXHAUSTED_DIR / "recovered"
UNRECOVERABLE_DIR = EXHAUSTED_DIR / "unrecoverable"

MAX_SOURCES = 15             # same cap as a normal consolidation batch
MIN_SOURCE_HITS = 2          # distinctive words a session must contain to count as a source
COVERED_THRESHOLD = 0.6      # share of claim lines already present in the wiki -> skip
# Model calls per processed batch: audit + (re-audit after pruning).
CALLS_LOW, CALLS_HIGH = 1, 2

_DATE_RE = re.compile(r"\b(20\d{2}-\d{2}-\d{2})\b")
_STAMP_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})_(.+)_batch(\d+)\.md$")
_SOURCE_LINE_RE = re.compile(r"^Source: (.+)$", re.M)
_QUOTED_RE = re.compile(r"[\"“'‘`]([^\"”'’`\n]{4,80})[\"”'’`]")
_TOKEN_RE = re.compile(r"\b(?:v?\d+\.\d+(?:\.\d+)?|[\w-]+\.(?:md|py|ts|tsx|js|mjs|cjs|swift|json|sh|3mf|yml|yaml|toml)|[a-z]+[A-Z]\w+|[a-z]+_[a-z_]+)\b")
_EMPTY_MARKERS = ("no technical substance", "(no summary produced", "no substantive", "nothing substantive")


@dataclass
class Exhausted:
    path: Path
    project: str
    stamp: datetime
    reason: str
    summary: str
    sources: list[str] = field(default_factory=list)   # recorded (0.30.3+)
    status: str = "pending"
    detail: str = ""


def parse(path: Path) -> Exhausted | None:
    m = _STAMP_RE.match(path.name)
    if not m:
        return None
    text = path.read_text(errors="replace")
    reason = re.search(r"^> (.*)$", text, re.M)
    summary = text.split("\n---\n", 1)[1].strip() if "\n---\n" in text else ""
    return Exhausted(
        path=path,
        project=m.group(2),
        stamp=datetime.strptime(m.group(1), "%Y-%m-%dT%H-%M-%S"),
        reason=reason.group(1) if reason else "",
        summary=summary,
        sources=_SOURCE_LINE_RE.findall(text.split("\n---\n", 1)[0]),
    )


def distinctive_terms(summary: str) -> set[str]:
    terms = {q.strip().lower() for q in _QUOTED_RE.findall(summary) if len(q.strip()) >= 4}
    terms |= {t.lower() for t in _TOKEN_RE.findall(summary)}
    return {t for t in terms if len(t) >= 4}


def is_no_summary(e: Exhausted) -> bool:
    """Exhausted because the claude CLI never produced a summary (outage)."""
    return e.summary.strip().startswith("(no summary produced")


def is_empty(e: Exhausted) -> bool:
    low = e.summary.lower()
    claims = [ln for ln in e.summary.splitlines() if cs._is_claim_line(ln)]
    return (not claims) or (any(marker in low for marker in _EMPTY_MARKERS) and len(claims) <= 1)


class RawIndex:
    """Raw sessions by date; project attribution cached, text read on demand."""

    def __init__(self, raw_dir: Path):
        self.by_date: dict[str, list[Path]] = defaultdict(list)
        for p in sorted(raw_dir.glob("*.md")):
            d = cs.SESSION_DATE_RE.match(p.name)
            if d:
                self.by_date[d.group(1)].append(p)
        self._projects: dict[Path, list[str]] = {}

    @staticmethod
    def text(p: Path) -> str:
        return p.read_text(errors="replace")

    def projects(self, p: Path) -> list[str]:
        if p not in self._projects:
            self._projects[p] = cs.detect_projects(self.text(p))
        return self._projects[p]

    def candidate_days(self, e: Exhausted) -> list[str]:
        """Days whose sessions may be sources. Backlog runs summarised sessions
        months old (a 170-day window on 2026-10-13), so a fixed look-back
        found the wrong sessions. When the summary names dates, ONLY those
        (±1 day) are searched; otherwise every day up to the file's date."""
        named: set[str] = set()
        for d in _DATE_RE.findall(e.summary):
            try:
                base = datetime.strptime(d, "%Y-%m-%d")
            except ValueError:
                continue
            for delta in (-1, 0, 1):
                named.add((base + timedelta(days=delta)).strftime("%Y-%m-%d"))
        last = e.stamp.strftime("%Y-%m-%d")
        if named:
            return sorted(d for d in named if d <= last and d in self.by_date)
        return [d for d in self.by_date if d <= last]

    def recorded_sources(self, e: Exhausted) -> list[Path]:
        """Source lines written by 0.30.3+: plain session file names only."""
        out = []
        for name in e.sources:
            base = Path(name.strip()).name
            if base != name.strip() or not cs.SESSION_DATE_RE.match(base):
                continue
            p = RAW_DIR / base
            if p.is_file() and p.resolve().parent == RAW_DIR.resolve():
                out.append(p)
        return out

    def guess_sources(self, e: Exhausted) -> list[Path]:
        terms = distinctive_terms(e.summary)
        if not terms:
            return []
        scored: list[tuple[int, Path]] = []
        for day in self.candidate_days(e):
            for p in self.by_date.get(day, []):
                if e.project not in self.projects(p):
                    continue
                low = self.text(p).lower()
                hits = sum(1 for t in terms if t in low)
                if hits >= MIN_SOURCE_HITS:
                    scored.append((hits, p))
        scored.sort(key=lambda x: (-x[0], x[1].name))
        return sorted({p for _, p in scored[:MAX_SOURCES]}, key=lambda p: p.name)


_WORD_SPLIT_RE = re.compile(r"[\w][\w.\-/]*", re.U)


def already_covered(e: Exhausted) -> bool:
    """A line counts as covered only when its numbers/versions/identifiers
    and 80% of its content words occur as WHOLE tokens on the wiki page."""
    page = cs.WIKI_DIR / "projects" / f"{e.project}.md"
    if not page.exists():
        page = cs.WIKI_DIR / "systems" / f"{e.project}.md"
    if not page.exists():
        return False
    wiki_tokens = {w.lower().strip(".-/") for w in _WORD_SPLIT_RE.findall(page.read_text(errors="replace"))}
    claims = [ln for ln in e.summary.splitlines() if cs._is_claim_line(ln)]
    if not claims:
        return False
    covered = 0
    for ln in claims:
        words = cs._claim_words(ln)
        if not words:
            continue
        distinct = cs._distinct_tokens(words)
        if distinct and not distinct <= wiki_tokens:
            continue
        if len(words & wiki_tokens) / len(words) >= 0.8:
            covered += 1
    return covered / len(claims) >= COVERED_THRESHOLD


def plan(project: str | None, accept_guessed: bool) -> tuple[list[Exhausted], Counter, Counter]:
    """Classify every exhausted file without model calls."""
    files = sorted(p for p in EXHAUSTED_DIR.glob("*.md"))
    index = RawIndex(RAW_DIR)
    todo: list[Exhausted] = []
    by_status: Counter = Counter()
    by_project: Counter = Counter()
    seen_sources: dict[str, Exhausted] = {}
    parsed = [e for e in (parse(f) for f in files) if e and (project is None or e.project == project)]
    # Newest first, so a duplicate keeps its latest summary.
    for e in sorted(parsed, key=lambda x: x.stamp, reverse=True):
        if is_no_summary(e):
            e.status = "skip_outage_no_summary"
        elif is_empty(e):
            e.status = "skip_empty"
        elif already_covered(e):
            e.status = "skip_in_wiki"
        else:
            sources = index.recorded_sources(e)
            guessed = not e.sources
            if guessed:
                sources = index.guess_sources(e) if accept_guessed else []
            if not sources:
                e.status = "skip_needs_guessed_sources" if guessed and not accept_guessed else "skip_no_sources"
            else:
                key = e.project + "|" + hashlib.sha1("|".join(p.name for p in sources).encode()).hexdigest()
                if key in seen_sources:
                    e.status = "skip_duplicate"
                else:
                    e.status = "process"
                    e.detail = json.dumps({"sources": [p.name for p in sources], "guessed": guessed})
                    seen_sources[key] = e
                    todo.append(e)
        by_status[e.status] += 1
        if e.status == "process":
            by_project[e.project] += 1
    return todo, by_status, by_project


def label(summary: str, e: Exhausted, sources: list[str], guessed: bool) -> str:
    """Recovery label + provenance, added BEFORE the audit so the auditor sees
    exactly the text that is written. The source list is an HTML comment."""
    lines = summary.splitlines()
    tag = f"(recovered {datetime.now():%Y-%m-%d}, re-audited)"
    if lines and lines[0].startswith("## ["):
        lines[0] = lines[0].rstrip() + " " + tag
    else:
        lines.insert(0, f"## [{e.stamp:%Y-%m-%d}] {tag}")
    kind = "guessed sources" if guessed else "sources"
    lines.insert(1, f"<!-- {kind}: {', '.join(sources)} -->")
    return "\n".join(lines)


def process(e: Exhausted) -> tuple[str, str, str]:
    """(outcome, section, note) — outcome is recovered | unrecoverable | error."""
    detail = json.loads(e.detail)
    names, guessed = detail["sources"], detail["guessed"]
    sources = [RAW_DIR / n for n in names]
    history = cs.git_history(e.project, sources)          # same evidence as the original audit
    text = label(e.summary, e, names, guessed)
    approved, reason, unsupported, infra = cs.audit_summary_detailed(text, sources, extra_sources=history)
    if infra:
        return "error", "", reason
    if approved:
        return "recovered", text, "approved as-is"
    pruned, removed, unmatched = cs.prune_summary(text, unsupported)
    if pruned is None:
        why = ("unmatched: " + "; ".join(unmatched))[:200] if unmatched else "too much flagged"
        return "unrecoverable", "", f"cannot prune ({why}) | {reason[:200]}"
    ok, re_reason, _u, infra2 = cs.audit_summary_detailed(pruned, sources, extra_sources=history)
    if infra2:
        return "error", "", re_reason
    still = cs.flagged_claims_remain(pruned, unsupported) if ok else []
    if ok and not still:
        return "recovered", pruned, f"pruned {len(removed)} line(s): " + " / ".join(r.strip()[:80] for r in removed)
    if still:
        return "unrecoverable", "", f"flagged claim still present after pruning: {'; '.join(still)[:200]}"
    return "unrecoverable", "", f"still rejected after pruning | {re_reason[:200]}"


def append_to_wiki(e: Exhausted, section: str) -> None:
    today = datetime.now().strftime("%Y-%m-%d")
    target = cs.WIKI_DIR / "projects" / f"{e.project}.md"
    if not target.exists() and (cs.WIKI_DIR / "systems" / f"{e.project}.md").exists():
        target = cs.WIKI_DIR / "systems" / f"{e.project}.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.write_text(cs.bump_updated(target.read_text(), today) + f"\n\n{section}\n")
    else:
        target.write_text(f"---\ntitle: {e.project}\ntype: project\ncreated: {today}\nupdated: {today}\n---\n\n{section}\n")


def move(e: Exhausted, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    shutil.move(str(e.path), str(dest / e.path.name))


MAX_CONSECUTIVE_ERRORS = 3


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--estimate", action="store_true", help="counts only, no model calls (default)")
    mode.add_argument("--pilot", type=int, metavar="N", help="process N batches into review-queue/reprocess-pilot/")
    mode.add_argument("--apply", action="store_true", help="process and write approved sections to the wiki")
    ap.add_argument("--limit", type=int, help="with --apply: at most N batches")
    ap.add_argument("--project", help="only this project")
    ap.add_argument("--accept-guessed-sources", action="store_true",
                    help="also process files without recorded sources (written before 0.30.3); "
                         "sources are guessed, so recovered sections have unverified provenance")
    args = ap.parse_args()

    todo, by_status, by_project = plan(args.project, args.accept_guessed_sources)
    total = sum(by_status.values())
    print(f"exhausted files: {total}")
    for status in ("process", "skip_duplicate", "skip_in_wiki", "skip_empty", "skip_no_sources",
                   "skip_needs_guessed_sources", "skip_outage_no_summary"):
        print(f"  {status:<27} {by_status.get(status, 0)}")
    if by_status.get("skip_outage_no_summary"):
        print("  (skip_outage_no_summary: the claude CLI never produced a summary — those sessions were "
              "marked processed without consolidation; this tool cannot recover them)")
    print("to process per project: " + ", ".join(f"{p} {n}" for p, n in by_project.most_common()))
    print(f"estimated model calls: {len(todo) * CALLS_LOW}–{len(todo) * CALLS_HIGH} "
          f"({cs.AUDIT_MODEL}; audit + re-audit when pruned)")

    if not args.pilot and not args.apply:
        return 0

    lock = None
    if args.apply:
        # Same kernel lock as run-consolidation.sh: never append to a wiki page
        # while the scheduled consolidation does a read-modify-write on it.
        lock = open(cs.NEUROMCP_DIR / "consolidation.flock", "a")
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print("consolidation is running (consolidation.flock is held) — try again later")
            return 1

    if args.pilot:
        batch = todo[: args.pilot]
    else:
        batch = todo if args.limit is None else todo[: max(args.limit, 0)]
    outcomes: Counter = Counter()
    if args.pilot:
        PILOT_DIR.mkdir(parents=True, exist_ok=True)
    errors_in_row = 0
    for i, e in enumerate(batch, 1):
        try:
            outcome, section, note = process(e)
        except Exception as exc:  # one bad file must not abort the run
            outcome, section, note = "error", "", f"{type(exc).__name__}: {exc}"
        outcomes[outcome] += 1
        print(f"[{i}/{len(batch)}] {e.path.name}: {outcome} — {note[:160]}")
        errors_in_row = errors_in_row + 1 if outcome == "error" else 0
        if errors_in_row >= MAX_CONSECUTIVE_ERRORS:
            print(f"stopping: {errors_in_row} errors in a row (claude CLI or auditor unavailable?)")
            break
        if args.pilot:
            (PILOT_DIR / e.path.name).write_text(
                f"# Reprocess pilot — {e.project} ({outcome})\n\n> {cs._one_line(note)}\n\n---\n\n"
                f"{section or '(nothing approved)'}\n"
            )
            continue
        if outcome == "error":
            continue  # left in place for the next run
        try:
            if outcome == "recovered":
                # Re-check: an earlier file in this run may have added the same content.
                if already_covered(Exhausted(e.path, e.project, e.stamp, "", section)):
                    move(e, RECOVERED_DIR)
                    print("    (already in the wiki now — not appended again)")
                    continue
                append_to_wiki(e, section)
                # No fact extraction here: recovered history must never supersede
                # current facts (facts are stored as valid from today).
            move(e, RECOVERED_DIR if outcome == "recovered" else UNRECOVERABLE_DIR)
        except OSError as exc:
            print(f"    could not finish {e.path.name}: {exc}")
    print("outcomes: " + ", ".join(f"{k} {v}" for k, v in outcomes.most_common()))
    if args.pilot:
        print(f"pilot results: {PILOT_DIR} (wiki untouched)")
    elif outcomes.get("recovered"):
        cs.trigger_wiki_index()
    return 0


if __name__ == "__main__":
    sys.exit(main())
