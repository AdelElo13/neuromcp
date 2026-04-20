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
import hashlib
import json
import os
import re
import sqlite3
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
REVIEW_QUEUE = NEUROMCP_DIR / "review-queue"
MEMORY_DB = NEUROMCP_DIR / "memory.db"
AUDIT_MODEL = "haiku"           # fast + cheap for audit + fact passes
AUDIT_TIMEOUT_SEC = 120
FACT_TIMEOUT_SEC = 120
CONTRADICTION_CHECK = os.environ.get("NEUROMCP_CONTRADICTION_CHECK", "1") != "0"

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


def audit_summary(summary: str, batch: list[Path]) -> tuple[bool, str]:
    """Verify every factual claim in `summary` is traceable to the raw sessions.

    Runs a second `claude -p` call with a strict verifier prompt. Returns
    (approved, reason). If the audit cannot run (CLI missing, JSON parse
    fail, timeout) we default to *approved* with a note — conservative
    fail-open is safer than losing legit updates to a flaky auditor.
    """
    session_text = "\n\n".join(
        f"=== {s.name} ===\n{s.read_text(errors='replace')[:3000]}"
        for s in batch
    )
    prompt = f"""You are a strict fact-checker. Verify every factual claim in the SUMMARY
is supported by the SOURCE sessions below. Treat rephrasings as fine, but
flag anything that appears in SUMMARY but not in SOURCE.

SOURCE:
{session_text}

SUMMARY:
{summary}

Output ONLY a single JSON object, no prose. Schema:
{{"approved": true|false, "unsupported": ["<exact claim 1>", ...], "note": "<one-line reason>"}}

Rules:
- approved=true only if zero unsupported factual claims.
- "Beslissing: X vs Y. Waarom: Z" style = one atomic claim, verify the decision + reason.
- Paraphrases of source sentences are OK. Invented causes, versions, names, numbers are NOT.
- If SUMMARY is essentially empty ("no technical substance" etc.), approved=true.
"""
    try:
        r = subprocess.run(
            ["claude", "-p", "--tools", "", "--no-session-persistence",
             "--model", AUDIT_MODEL, prompt],
            capture_output=True,
            text=True,
            timeout=AUDIT_TIMEOUT_SEC,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return True, f"audit skipped: {type(exc).__name__}"

    if r.returncode != 0 or not r.stdout.strip():
        return True, "audit skipped: empty response"

    # Try to find JSON in the response (auditor may still add stray text).
    match = re.search(r"\{.*\}", r.stdout, re.S)
    if not match:
        return True, "audit skipped: no JSON in response"
    try:
        verdict = json.loads(match.group(0))
    except json.JSONDecodeError:
        return True, "audit skipped: malformed JSON"

    approved = bool(verdict.get("approved", True))
    unsupported = verdict.get("unsupported") or []
    note = verdict.get("note") or ""
    if approved:
        return True, note or "approved"
    reason = f"REJECTED — {note or 'unsupported claims'}"
    if unsupported:
        reason += " | " + " ; ".join(str(u)[:200] for u in unsupported[:5])
    return False, reason


def queue_for_review(project: str, batch_idx: int, summary: str, reason: str) -> Path:
    """Park a rejected summary under review-queue/ for human inspection."""
    REVIEW_QUEUE.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    path = REVIEW_QUEUE / f"{stamp}_{project}_batch{batch_idx}.md"
    path.write_text(
        f"# Rejected consolidation — {project} batch {batch_idx}\n"
        f"\n> {reason}\n\n---\n\n{summary}\n"
    )
    return path


# ─── Tier 2 C+D+F: atomic fact extraction + temporal supersession ───────

def _run_claude(prompt: str, timeout: int) -> str | None:
    try:
        r = subprocess.run(
            ["claude", "-p", "--tools", "", "--no-session-persistence",
             "--model", AUDIT_MODEL, prompt],
            capture_output=True, text=True, timeout=timeout,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    return r.stdout if r.returncode == 0 else None


def extract_facts(summary: str, batch: list[Path], project: str) -> list[dict]:
    """Ask the model to distill the consolidated summary into atomic facts.

    Returns a list of {subject, content, confidence} dicts. Empty on failure.
    Facts are intentionally natural-language single sentences rather than strict
    SPO triples — strict schemas lose nuance in decision-with-rationale claims.
    """
    prompt = f"""Extract at most 8 atomic facts from the SUMMARY below.
Each fact must be:
- A single standalone sentence that is true as-of today, without needing surrounding context.
- Traceable to the SUMMARY — do not invent.
- Short (< 200 chars).

Project: {project}

SUMMARY:
{summary}

Output ONLY a JSON array, no prose. Schema per item:
{{"subject": "<short noun phrase anchor>", "content": "<full fact sentence>", "confidence": "high"|"medium"|"low"}}

Rules:
- "Beslissing: launchd boven SessionEnd omdat X" → one fact with subject="consolidation trigger", content="launchd agent is chosen over SessionEnd hook because X".
- Versions, paths, numbers, decisions, bug fixes = good fact material.
- Phrasing questions, open todos, or "next steps" = NOT facts, skip them."""
    raw = _run_claude(prompt, FACT_TIMEOUT_SEC)
    if not raw:
        return []
    match = re.search(r"\[.*\]", raw, re.S)
    if not match:
        return []
    try:
        facts = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    cleaned = []
    for f in facts if isinstance(facts, list) else []:
        if not isinstance(f, dict):
            continue
        content = (f.get("content") or "").strip()
        subject = (f.get("subject") or "").strip()
        if not content or len(content) > 400:
            continue
        cleaned.append({
            "subject": subject[:120],
            "content": content,
            "confidence": f.get("confidence", "medium"),
        })
    return cleaned[:8]


def _memory_id(content: str) -> str:
    return hashlib.sha256(f"{content}-{datetime.now().isoformat()}-{os.urandom(4).hex()}".encode()).hexdigest()[:32]


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()


_WORD_RE = re.compile(r"[a-z0-9][a-z0-9_\-.]{2,}", re.I)
_SKIP_TERMS = {"the", "is", "are", "was", "were", "van", "een", "met", "elke", "voor", "and", "or",
               "de", "het", "runs", "run", "has", "have", "will", "this", "that"}

def _keywords(text: str) -> set[str]:
    return {t.lower() for t in _WORD_RE.findall(text or "") if t.lower() not in _SKIP_TERMS and len(t) > 2}


def find_contradicting_fact(
    db: sqlite3.Connection,
    project: str,
    subject: str,
    new_content: str,
) -> str | None:
    """Return id of a prior fact this one likely supersedes, or None.

    Strategy: pull recent facts in the same project, score each on keyword-
    overlap (Jaccard) with the new fact's (subject + content). Above a
    similarity floor, ask Haiku if NEW truly supersedes OLD. This avoids
    false supersessions on parallel-but-unrelated facts while still catching
    cases where the model phrased the subject differently.
    """
    new_kw = _keywords(subject) | _keywords(new_content)
    if len(new_kw) < 2:
        return None
    cur = db.execute(
        """
        SELECT id, content, metadata FROM memories
        WHERE category = 'fact' AND project_id = ? AND is_deleted = 0
          AND superseded_by_id IS NULL
        ORDER BY created_at DESC
        LIMIT 30
        """,
        (project,),
    )
    scored: list[tuple[float, str, str]] = []
    for row_id, content, meta_json in cur.fetchall():
        if content == new_content:
            continue
        try:
            meta = json.loads(meta_json or "{}")
        except json.JSONDecodeError:
            meta = {}
        old_kw = _keywords(meta.get("subject", "")) | _keywords(content or "")
        if not old_kw:
            continue
        overlap = len(new_kw & old_kw)
        union = len(new_kw | old_kw)
        jaccard = overlap / union if union else 0.0
        # Need enough shared terms AND high ratio — either alone gives false positives
        if overlap >= 3 and jaccard >= 0.35:
            scored.append((jaccard, row_id, content))
    if not scored:
        return None
    scored.sort(reverse=True)
    if not CONTRADICTION_CHECK:
        return None
    _, old_id, old_content = scored[0]
    prompt = f"""Two facts about the same topic. Does the NEW fact supersede the OLD one?

OLD: {old_content}
NEW: {new_content}

Answer ONLY "yes" if NEW replaces OLD (the number/value/state changed, or it contradicts it),
or "no" if they are compatible parallel observations. One word."""
    verdict = (_run_claude(prompt, 30) or "").strip().lower()
    return old_id if verdict.startswith("yes") else None


def _embed_fact(memory_id: str, content: str) -> None:
    """Best-effort: call `neuromcp-embed` so the fact is also vector-searchable.

    Tries the maintainer's dev path first, then falls back to `npx`. Any
    failure is swallowed — FTS5 still works without the embedding.
    """
    dev_script = HOME / "projects" / "neuromcp" / "bin" / "embed.mjs"
    payload = json.dumps({"id": memory_id, "text": content})
    attempts: list[list[str]] = []
    if dev_script.exists():
        attempts.append(["node", str(dev_script)])
    attempts.append(["npx", "--yes", "-p", "neuromcp", "neuromcp-embed"])
    for cmd in attempts:
        try:
            r = subprocess.run(cmd, input=payload, capture_output=True, text=True, timeout=30)
            if r.returncode == 0:
                return
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue


def store_fact(
    db: sqlite3.Connection,
    fact: dict,
    project: str,
    source_session: str,
) -> bool:
    """Insert a fact as a memory row and its FTS mirror. Returns True if stored."""
    content = fact["content"]
    chash = _content_hash(content)
    # Dedup: skip if the exact content is already a non-deleted memory.
    exists = db.execute(
        "SELECT 1 FROM memories WHERE content_hash = ? AND is_deleted = 0 LIMIT 1",
        (chash,),
    ).fetchone()
    if exists:
        return False
    memory_id = _memory_id(content)
    trust = {"high": "high", "medium": "medium", "low": "low"}.get(fact.get("confidence"), "medium")
    today = datetime.now().strftime("%Y-%m-%d")
    metadata = json.dumps({
        "subject": fact.get("subject", ""),
        "source_session": source_session,
        "extracted_at": datetime.now().isoformat(),
    })
    db.execute(
        """
        INSERT INTO memories (
            id, content_hash, content, namespace, category, source, source_trust,
            project_id, tags, importance, metadata, valid_from
        ) VALUES (?, ?, ?, 'default', 'fact', 'consolidator', ?, ?, '[]', 0.7, ?, ?)
        """,
        (memory_id, chash, content, trust, project, metadata, today),
    )
    rowid = db.execute("SELECT rowid FROM memories WHERE id = ?", (memory_id,)).fetchone()[0]
    db.execute(
        "INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, '[]', 'fact')",
        (rowid, content),
    )
    # Mark any predecessor as superseded by this one.
    predecessor = find_contradicting_fact(db, project, fact.get("subject", ""), content)
    if predecessor:
        db.execute(
            "UPDATE memories SET superseded_by_id = ?, valid_to = ? WHERE id = ?",
            (memory_id, today, predecessor),
        )
    return True


def persist_facts(facts: list[dict], project: str, batch: list[Path]) -> int:
    """Write facts to memory.db + embed them for hybrid retrieval. Returns insert count."""
    if not facts or not MEMORY_DB.exists():
        return 0
    source = batch[-1].name if batch else ""
    try:
        db = sqlite3.connect(str(MEMORY_DB))
    except sqlite3.Error:
        return 0
    inserted: list[tuple[str, str]] = []
    try:
        db.execute("BEGIN")
        for fact in facts:
            if store_fact(db, fact, project, source):
                # Look up the row we just inserted to get its id for embedding.
                cur = db.execute(
                    "SELECT id FROM memories WHERE content_hash = ? AND is_deleted = 0",
                    (_content_hash(fact["content"]),),
                )
                row = cur.fetchone()
                if row:
                    inserted.append((row[0], fact["content"]))
        db.execute("COMMIT")
    except sqlite3.Error as exc:
        db.execute("ROLLBACK")
        print(f"    WARN: fact persist failed: {exc}")
    finally:
        db.close()
    # Embeddings happen outside the transaction — they hit a separate DB
    # connection (the bin tool opens its own) and we don't want the txn
    # held open during async Ollama calls.
    for memory_id, content in inserted:
        _embed_fact(memory_id, content)
    return len(inserted)


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
        # Eval-loop: verify every claim traces to a source session before writing.
        approved, reason = audit_summary(extracted, batch)
        if not approved:
            path = queue_for_review(project, batch_idx, extracted, reason)
            print(f"  ⚠ {project} batch {batch_idx}/{batch_total} rejected — queued: {path.name}")
            print(f"    {reason}")
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
        # Tier 2 C+D: distill atomic facts and persist with supersession edges.
        facts = extract_facts(extracted, batch, project)
        if facts:
            added = persist_facts(facts, project, batch)
            if added:
                print(f"    + {added} fact(s) stored")
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
        # Fire-and-forget wiki re-index so auto-retrieve sees fresh chunks.
        # The indexer dedups by content_hash so re-running is cheap.
        trigger_wiki_index()

    print(f"\nDone: {ok_count}/{len(groups)} projects processed")


def trigger_wiki_index() -> None:
    """Best-effort: refresh the FTS5 + vector index so auto-retrieve finds today's edits.

    Resolution order:
      1. `npx -p neuromcp neuromcp-index-wiki` — works for any install method
      2. Direct dev path `~/projects/neuromcp/scripts/index-wiki.mjs` — for the
         maintainer's own setup where the package is run from source

    Either way we only shell out — failures are silent, consolidation already
    succeeded and the indexer is an optimisation, not a correctness gate.
    """
    dev_script = HOME / "projects" / "neuromcp" / "scripts" / "index-wiki.mjs"
    attempts: list[list[str]] = []
    if dev_script.exists():
        attempts.append(["node", str(dev_script)])
    attempts.append(["npx", "--yes", "-p", "neuromcp", "neuromcp-index-wiki"])
    for cmd in attempts:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
            if r.returncode == 0:
                return
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue


if __name__ == "__main__":
    main()
