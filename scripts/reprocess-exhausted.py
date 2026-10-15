#!/usr/bin/env python3
"""Re-audit consolidation batches that were exhausted before 0.30.3.

Until 0.30.3 the auditor rejected a whole batch for one unsupported line, so
thousands of mostly-correct summaries sit in ~/.neuromcp/review-queue/exhausted/.
This tool re-audits each stored summary against its source sessions, prunes the
lines the auditor flags (consolidate-sessions.prune_summary) and keeps only what
the auditor then approves. Nothing reaches the wiki unaudited.

Exhausted files written before 0.30.3 do not record their sources. They are
recovered from ~/.neuromcp/raw/sessions: sessions of the same project, dated in
the window before the file was written, that contain the summary's distinctive
words (quoted phrases, `code`, file names, versions). A wrong guess is safe —
the auditor then rejects whatever the sources do not support.

Modes (default --estimate, which makes NO model calls):
  --estimate            counts per project + expected model calls
  --pilot N             process N batches, write results to
                        review-queue/reprocess-pilot/ — the wiki is NOT touched
  --apply [--limit N]   process and append approved sections to the wiki,
                        persist facts, then move each file to
                        exhausted/recovered/ or exhausted/unrecoverable/
  --project P           only this project
"""
from __future__ import annotations

import argparse
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

SOURCE_WINDOW_DAYS = 10      # sessions considered: up to this many days before the file
MAX_SOURCES = 15             # same cap as a normal consolidation batch
MIN_SOURCE_HITS = 2          # distinctive words a session must contain to count as a source
COVERED_THRESHOLD = 0.6      # share of claim lines already present in the wiki -> skip
# Model calls per processed batch: audit + (re-audit after pruning) + fact extraction.
CALLS_LOW, CALLS_HIGH = 2, 3

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


def is_empty(e: Exhausted) -> bool:
    low = e.summary.lower()
    claims = [ln for ln in e.summary.splitlines() if cs._is_claim_line(ln)]
    return not claims or any(marker in low for marker in _EMPTY_MARKERS) and len(claims) <= 1


class RawIndex:
    """Raw sessions by date, lower-cased text cached on demand."""

    def __init__(self, raw_dir: Path):
        self.by_date: dict[str, list[Path]] = defaultdict(list)
        for p in sorted(raw_dir.glob("*.md")):
            d = cs.SESSION_DATE_RE.match(p.name)
            if d:
                self.by_date[d.group(1)].append(p)
        self._text: dict[Path, str] = {}
        self._projects: dict[Path, list[str]] = {}

    def text(self, p: Path) -> str:
        if p not in self._text:
            self._text[p] = p.read_text(errors="replace")
        return self._text[p]

    def projects(self, p: Path) -> list[str]:
        if p not in self._projects:
            self._projects[p] = cs.detect_projects(self.text(p))
        return self._projects[p]

    def find_sources(self, e: Exhausted) -> list[Path]:
        if e.sources:
            found = [RAW_DIR / name for name in e.sources]
            return [p for p in found if p.exists()]
        terms = distinctive_terms(e.summary)
        if not terms:
            return []
        scored: list[tuple[int, Path]] = []
        for back in range(SOURCE_WINDOW_DAYS + 1):
            day = (e.stamp - timedelta(days=back)).strftime("%Y-%m-%d")
            for p in self.by_date.get(day, []):
                if e.project not in self.projects(p):
                    continue
                low = self.text(p).lower()
                hits = sum(1 for t in terms if t in low)
                if hits >= MIN_SOURCE_HITS:
                    scored.append((hits, p))
        scored.sort(key=lambda x: (-x[0], x[1].name))
        return sorted({p for _, p in scored[:MAX_SOURCES]}, key=lambda p: p.name)


def already_covered(e: Exhausted) -> bool:
    page = cs.WIKI_DIR / "projects" / f"{e.project}.md"
    if not page.exists():
        page = cs.WIKI_DIR / "systems" / f"{e.project}.md"
    if not page.exists():
        return False
    wiki = page.read_text(errors="replace").lower()
    claims = [ln for ln in e.summary.splitlines() if cs._is_claim_line(ln)]
    if not claims:
        return False
    covered = 0
    for ln in claims:
        words = cs._claim_words(ln)
        if words and sum(1 for w in words if w in wiki) / len(words) >= 0.8:
            covered += 1
    return covered / len(claims) >= COVERED_THRESHOLD


def plan(project: str | None) -> tuple[list[Exhausted], Counter, Counter]:
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
        if is_empty(e):
            e.status = "skip_empty"
        elif already_covered(e):
            e.status = "skip_in_wiki"
        else:
            sources = index.find_sources(e)
            if not sources:
                e.status = "skip_no_sources"
            else:
                key = e.project + "|" + hashlib.sha1("|".join(p.name for p in sources).encode()).hexdigest()
                if key in seen_sources:
                    e.status = "skip_duplicate"
                else:
                    e.status = "process"
                    e.detail = json.dumps([p.name for p in sources])
                    seen_sources[key] = e
                    todo.append(e)
        by_status[e.status] += 1
        if e.status == "process":
            by_project[e.project] += 1
    return todo, by_status, by_project


def process(e: Exhausted) -> tuple[str, str, str]:
    """(outcome, section, note) — outcome is recovered | unrecoverable."""
    sources = [RAW_DIR / n for n in json.loads(e.detail)]
    approved, reason, unsupported, infra = cs.audit_summary_detailed(e.summary, sources)
    if infra:
        return "error", "", reason
    if approved:
        return "recovered", e.summary, "approved as-is"
    pruned, removed, unmatched = cs.prune_summary(e.summary, unsupported)
    if pruned is None:
        return "unrecoverable", "", f"cannot prune ({'unmatched: ' + '; '.join(unmatched)[:200] if unmatched else 'too much flagged'}) | {reason[:200]}"
    ok, re_reason, _u, infra2 = cs.audit_summary_detailed(pruned, sources)
    if infra2:
        return "error", "", re_reason
    if ok:
        return "recovered", pruned, f"pruned {len(removed)} line(s): " + " / ".join(r.strip()[:80] for r in removed)
    return "unrecoverable", "", f"still rejected after pruning | {re_reason[:200]}"


def label(section: str, e: Exhausted) -> str:
    """Mark a recovered section so readers know it was re-audited later."""
    lines = section.splitlines()
    if lines and lines[0].startswith("## ["):
        lines[0] = lines[0].rstrip() + f" (recovered {datetime.now():%Y-%m-%d}, re-audited)"
    else:
        lines.insert(0, f"## [{e.stamp:%Y-%m-%d}] (recovered {datetime.now():%Y-%m-%d}, re-audited)")
    return "\n".join(lines)


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


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--estimate", action="store_true", help="counts only, no model calls (default)")
    mode.add_argument("--pilot", type=int, metavar="N", help="process N batches into review-queue/reprocess-pilot/")
    mode.add_argument("--apply", action="store_true", help="process and write approved sections to the wiki")
    ap.add_argument("--limit", type=int, help="with --apply: at most N batches")
    ap.add_argument("--project", help="only this project")
    args = ap.parse_args()

    todo, by_status, by_project = plan(args.project)
    total = sum(by_status.values())
    print(f"exhausted files: {total}")
    for status in ("process", "skip_duplicate", "skip_in_wiki", "skip_empty", "skip_no_sources"):
        print(f"  {status:<16} {by_status.get(status, 0)}")
    print("to process per project: " + ", ".join(f"{p} {n}" for p, n in by_project.most_common()))
    print(f"estimated model calls: {len(todo) * CALLS_LOW}–{len(todo) * CALLS_HIGH} "
          f"({cs.AUDIT_MODEL}; audit + re-audit when pruned + fact extraction)")

    if not args.pilot and not args.apply:
        return

    batch = todo[: args.pilot] if args.pilot else (todo[: args.limit] if args.limit else todo)
    outcomes: Counter = Counter()
    if args.pilot:
        PILOT_DIR.mkdir(parents=True, exist_ok=True)
    for i, e in enumerate(batch, 1):
        outcome, section, note = process(e)
        outcomes[outcome] += 1
        print(f"[{i}/{len(batch)}] {e.path.name}: {outcome} — {note[:160]}")
        if args.pilot:
            out = PILOT_DIR / e.path.name
            body = label(section, e) if section else "(nothing approved)"
            out.write_text(
                f"# Reprocess pilot — {e.project} ({outcome})\n\n> {note}\n\n"
                f"Sources: {', '.join(json.loads(e.detail))}\n\n---\n\n{body}\n"
            )
            continue
        if outcome == "error":
            continue  # infrastructure hiccup: leave the file for the next run
        if outcome == "recovered":
            section = label(section, e)
            append_to_wiki(e, section)
            facts = cs.extract_facts(section, [RAW_DIR / n for n in json.loads(e.detail)], e.project)
            if facts:
                cs.persist_facts(facts, e.project, [RAW_DIR / n for n in json.loads(e.detail)])
        dest = RECOVERED_DIR if outcome == "recovered" else UNRECOVERABLE_DIR
        dest.mkdir(parents=True, exist_ok=True)
        shutil.move(str(e.path), str(dest / e.path.name))
    print("outcomes: " + ", ".join(f"{k} {v}" for k, v in outcomes.most_common()))
    if args.pilot:
        print(f"pilot results: {PILOT_DIR} (wiki untouched)")
    elif outcomes.get("recovered"):
        cs.trigger_wiki_index()


if __name__ == "__main__":
    sys.exit(main())
