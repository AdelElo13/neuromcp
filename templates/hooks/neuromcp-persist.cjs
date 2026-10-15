#!/usr/bin/env node
/**
 * neuromcp-persist.cjs — Crash-resilient memory persistence hook
 *
 * Note: explicit .cjs extension required because consumers may install
 * this hook into a directory whose nearest package.json has
 * "type": "module" (e.g. when running inside the neuromcp repo). The
 * .cjs extension forces CommonJS regardless of context.
 *
 * Writes session context directly to neuromcp's SQLite database.
 * Works as both Stop hook (session summary) and PostToolUse hook (periodic checkpoint + reminder).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const HOME = process.env.HOME || process.env.USERPROFILE || "/tmp";
const DB_PATH = path.join(HOME, ".neuromcp", "memory.db");
const CHECKPOINT_STATE = path.join(HOME, ".neuromcp", ".checkpoint-state.json");
const RAW_SESSIONS_DIR = path.join(HOME, ".neuromcp", "raw", "sessions");
const CHECKPOINT_INTERVAL = 5;
const REMINDER_INTERVAL = 8;
const SESSION_DIR = path.join(HOME, ".neuromcp");

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Own-transcript summary (2026-10-15). The hook used to read the newest
 * ~/.claude/session-data/*-session.tmp, which belongs to whichever session
 * stopped last (one merged file per directory per day). Raw logs then carried
 * another session's tasks and file list, and consolidation filed the work under
 * the wrong project. Now everything comes from THIS session's transcript, and
 * only from the part added since this session's previous Stop (byte offset per
 * session in OFFSETS_FILE), so repeated Stops do not repeat old content.
 */
const OFFSETS_FILE = path.join(HOME, ".neuromcp", "raw", ".transcript-offsets.json");
const PROJECTS_ROOT = path.join(HOME, "projects");
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const RELEASE_RE = /\b(git\s+(commit|tag|push)|gh\s+(release|pr\s+(create|merge))|npm\s+(publish|version)|cargo\s+publish|twine\s+upload)\b/;

function readOffsets() {
  try { return JSON.parse(fs.readFileSync(OFFSETS_FILE, "utf8")) || {}; } catch { return {}; }
}
function writeOffsets(offsets) {
  try {
    fs.mkdirSync(path.dirname(OFFSETS_FILE), { recursive: true });
    const tmp = `${OFFSETS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(offsets));
    fs.renameSync(tmp, OFFSETS_FILE);
  } catch {}
}
// Projects that live outside ~/projects: ~/.neuromcp/project-dirs.json maps
// a wiki project name to directory prefixes, e.g.
//   { "desktop-quatro": ["~/Documents/ChatGPT/Ken/duo", "~/Documents/ChatGPT/Ken/macos"] }
// A path under a configured prefix (longest wins) belongs to that project.
const PROJECT_NAME_RE = /^[A-Za-z0-9_.-]+$/;
let projectDirsCache;
function validProjectDir(abs) {
  // Same footgun guard as consolidate-sessions.py: no "/", no HOME itself,
  // at least three path components.
  return abs.startsWith("/") && abs.split("/").filter(Boolean).length >= 3 && abs !== HOME;
}
function projectDirs() {
  if (projectDirsCache !== undefined) return projectDirsCache;
  projectDirsCache = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(HOME, ".neuromcp", "project-dirs.json"), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return projectDirsCache;
    for (const [name, dirs] of Object.entries(raw)) {
      if (!PROJECT_NAME_RE.test(name) || name.startsWith(".") || !Array.isArray(dirs)) continue;
      for (const entry of dirs) {
        if (typeof entry !== "string" || !entry.trim()) continue;
        const d = entry.trim();
        const abs = (d.startsWith("~/") ? path.join(HOME, d.slice(2)) : d).replace(/\/+$/, "");
        if (!validProjectDir(abs)) continue;
        const tilde = abs.startsWith(HOME + path.sep) ? "~" + abs.slice(HOME.length) : null;
        projectDirsCache.push({ name, prefixes: tilde ? [abs, tilde] : [abs] });
      }
    }
  } catch {}
  return projectDirsCache;
}
const RIGHT_BOUNDARY = new Set([..." \t\"'`;&|)/:,]}>="]);
const LEFT_BOUNDARY = new Set([..." \t\"'`=(:,[{<"]);
function configuredProjectOf(p) {
  let best = null;
  for (const { name, prefixes } of projectDirs()) {
    for (const prefix of prefixes) {
      for (let i = p.indexOf(prefix); i !== -1; i = p.indexOf(prefix, i + 1)) {
        if (i > 0 && !LEFT_BOUNDARY.has(p[i - 1])) continue;
        const next = p[i + prefix.length];
        if (next !== undefined && !RIGHT_BOUNDARY.has(next)) continue;
        if (!best || prefix.length > best.len) best = { name, len: prefix.length };
      }
    }
  }
  return best ? best.name : null;
}
function projectOf(p) {
  if (typeof p !== "string") return null;
  const configured = configuredProjectOf(p);
  if (configured) return configured;
  let prefix = PROJECTS_ROOT + path.sep;
  let i = p.indexOf(prefix);
  if (i === -1) { prefix = "~/projects/"; i = p.indexOf(prefix); }        // shell commands use ~
  if (i === -1) return null;
  const name = p.slice(i + prefix.length).split(/[\/\s"'`;&|)]/)[0];
  return name && !name.startsWith(".") ? name : null;
}
function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((x) => x && x.type === "text" && typeof x.text === "string").map((x) => x.text).join(" ");
}

/** Summary of transcript bytes [startOffset, EOF). Returns null when unreadable. */
function summarizeOwnTranscript(transcriptPath, startOffset) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const out = { userMessages: [], tools: new Set(), files: new Set(), releases: [], cwds: new Set(), projects: new Set(), end: startOffset };
  try {
    const { end } = forEachJsonlLine(transcriptPath, (line) => {
      let e; try { e = JSON.parse(line); } catch { return; }
      if (typeof e.cwd === "string") out.cwds.add(e.cwd);
      const role = e.message?.role ?? e.role ?? e.type;
      const content = e.message?.content ?? e.content;
      if (role === "user" && !e.isMeta) {
        const text = messageText(content).replace(/\s+/g, " ").trim();
        if (text) { out.userMessages.push(text.slice(0, 200)); if (out.userMessages.length > 30) out.userMessages.shift(); }   // keep the most recent
      }
      if (Array.isArray(content)) for (const part of content) {
        if (!part || part.type !== "tool_use" || typeof part.name !== "string") continue;
        out.tools.add(part.name);
        const input = part.input || {};
        const file = input.file_path ?? input.notebook_path;
        if (FILE_TOOLS.has(part.name) && typeof file === "string" && out.files.size < 100) out.files.add(file);
        if (part.name === "Bash" && typeof input.command === "string" && RELEASE_RE.test(input.command)) {
          out.releases.push(input.command.replace(/\s+/g, " ").trim().slice(0, 300));
          if (out.releases.length > 20) out.releases.shift();                     // keep the most recent
        }
      }
    }, startOffset);
    out.end = end;
  } catch { return null; }
  for (const f of out.files) { const p = projectOf(f); if (p) out.projects.add(p); }
  for (const r of out.releases) { const p = projectOf(r); if (p) out.projects.add(p); }
  return out;
}

// ─── Transcript streaming ──────────────────────────────────────────
// Reads a JSONL file line by line in fixed-size chunks. fs.readFileSync on
// the whole transcript throws once it passes V8's ~512 MB string limit
// (long sessions with screenshots reach 700 MB+), which silently disabled
// this hook for exactly the longest sessions. Lines are decoded only after
// they are complete, so multi-byte UTF-8 characters split across chunks
// stay intact. NEUROMCP_TRANSCRIPT_CHUNK_BYTES exists for tests.
const TRANSCRIPT_CHUNK_BYTES = Number(process.env.NEUROMCP_TRANSCRIPT_CHUNK_BYTES) > 0
  ? Number(process.env.NEUROMCP_TRANSCRIPT_CHUNK_BYTES)
  : 4 * 1024 * 1024;
const TRANSCRIPT_MAX_LINE_BYTES = 256 * 1024 * 1024;

/**
 * Calls onLine(string) for every non-empty line from startOffset on; onLine may
 * return false to stop early. Returns { skipped: oversized lines, end: byte position read }.
 */
function forEachJsonlLine(filePath, onLine, startOffset = 0) {
  const fd = fs.openSync(filePath, 'r');
  let skipped = 0;
  let position = startOffset;
  try {
    const buf = Buffer.alloc(TRANSCRIPT_CHUNK_BYTES);
    let pieces = [];
    let pending = 0;
    let oversized = false;
    let stopped = false;
    const flush = () => {
      if (oversized) skipped++;
      else if (pending > 0) {
        const line = Buffer.concat(pieces, pending).toString('utf8');
        if (line.trim() && onLine(line) === false) stopped = true;
      }
      pieces = [];
      pending = 0;
      oversized = false;
    };
    const add = (piece) => {
      if (oversized || piece.length === 0) return;
      if (pending + piece.length > TRANSCRIPT_MAX_LINE_BYTES) {
        oversized = true;
        pieces = [];
        pending = 0;
        return;
      }
      pieces.push(Buffer.from(piece));
      pending += piece.length;
    };
    let n;
    while (!stopped && (n = fs.readSync(fd, buf, 0, TRANSCRIPT_CHUNK_BYTES, position)) > 0) {
      position += n;
      const chunk = buf.subarray(0, n);
      let start = 0;
      let nl;
      while (!stopped && (nl = chunk.indexOf(0x0a, start)) !== -1) {
        add(chunk.subarray(start, nl));
        flush();
        start = nl + 1;
      }
      if (!stopped) add(chunk.subarray(start));
    }
    if (!stopped) flush();
  } finally {
    fs.closeSync(fd);
  }
  return { skipped, end: position };
}

/**
 * Count real user messages in a session transcript.
 * Returns 0 if transcript missing/unreadable, or if the session had no
 * user-role entries with non-empty content. Used to skip raw-log writes
 * for "empty sessions" (claude spawned without input — by the desktop
 * app, a launchd trigger, or a hook loop). See ~/.neuromcp/raw/sessions/
 * growth from spurious spawns; fixes the leak documented in
 * wiki:home#[2026-04-28 batch 1/2].
 */
function countUserMessages(transcriptPath) {
  if (!transcriptPath) return 0;
  try {
    if (!fs.existsSync(transcriptPath)) return 0;
    let count = 0;
    forEachJsonlLine(transcriptPath, (line) => {
      try {
        const e = JSON.parse(line);
        const isUser =
          e.type === "user" || e.role === "user" || e.message?.role === "user";
        if (!isUser) return;
        const c = e.message?.content ?? e.content;
        const body = typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.map((x) => (x && x.text) || "").join("")
            : "";
        if (body.trim()) {
          count++;
          return false; // callers only distinguish 0 from >0 — stop reading
        }
      } catch {}
    });
    return count;
  } catch {
    return 0;
  }
}

/**
 * Read the neuromcp work-state file, which Claude proactively writes
 * during sessions with rich context about decisions and progress.
 * @param {boolean} clear - If true, clear the file after reading (only on Stop)
 */
function getWorkState(clear = false) {
  const workStateFile = path.join(
    HOME,
    ".neuromcp",
    ".work-state.md"
  );
  try {
    if (fs.existsSync(workStateFile)) {
      const content = fs.readFileSync(workStateFile, "utf8");
      if (clear) {
        fs.writeFileSync(workStateFile, "");
      }
      return content;
    }
  } catch {}
  return null;
}

function generateId() {
  return crypto.randomBytes(16).toString("hex");
}

function contentHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function insertMemory(content, category, tags, importance, source) {
  if (!fs.existsSync(DB_PATH)) {
    process.stderr.write(
      "[neuromcp-persist] DB not found at " + DB_PATH + "\n"
    );
    return false;
  }

  const id = generateId();
  const hash = contentHash(content);
  const now = new Date().toISOString();
  const tagsJSON = JSON.stringify(tags);

  // Check for duplicate by content hash
  const checkSql = `SELECT COUNT(*) FROM memories WHERE content_hash='${hash}' AND is_deleted=0`;
  try {
    const count = execFileSync("sqlite3", [DB_PATH, checkSql], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (parseInt(count, 10) > 0) {
      return false;
    }
  } catch {
    // If check fails, proceed anyway
  }

  // Write SQL to temp file to avoid shell escaping issues
  const sql = `INSERT INTO memories (id, content_hash, content, namespace, source, source_trust, category, tags, importance, created_at, updated_at)
VALUES ('${id}', '${hash}', '${content.replace(/'/g, "''")}', 'default', '${source}', 'medium', '${category.replace(/'/g, "''")}', '${tagsJSON.replace(/'/g, "''")}', ${importance}, '${now}', '${now}');`;

  const tmpFile = path.join("/tmp", `neuromcp-${id}.sql`);
  try {
    fs.writeFileSync(tmpFile, sql);
    execFileSync("sqlite3", [DB_PATH, `.read ${tmpFile}`], {
      encoding: "utf8",
      timeout: 5000,
    });
    fs.unlinkSync(tmpFile);
    return true;
  } catch (err) {
    process.stderr.write(
      "[neuromcp-persist] Insert failed: " + err.message + "\n"
    );
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    return false;
  }
}

function getCheckpointState() {
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_STATE, "utf8"));
  } catch {
    return { toolCallCount: 0, lastCheckpoint: null };
  }
}

function saveCheckpointState(state) {
  try {
    fs.writeFileSync(CHECKPOINT_STATE, JSON.stringify(state));
  } catch {}
}

const hookEvent = process.env.CLAUDE_HOOK_EVENT || "";
const isStopHook = hookEvent === "Stop" || hookEvent === "SessionEnd";
const raw = readStdin();

if (isStopHook) {
  process.stdout.write(raw);
}

try {
  let parsed = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {}
  }

  if (isStopHook) {
    stopHookBody: {
    // Skip empty sessions (0 real user messages) — prevents raw-stub leak
    // when claude is spawned by the desktop app / launchd / a hook with
    // no actual conversation. Adel decision 2026-05-14: strict threshold.
    if (countUserMessages(parsed.transcript_path) === 0) {
      process.stderr.write("[neuromcp-persist] Skipping empty session (0 user messages)\n");
      break stopHookBody;
    }
    // Build a rich session summary from all available sources
    const parts = [];
    parts.push(`Session ended: ${new Date().toISOString()}`);
    const sessionCwd = typeof parsed.cwd === "string" && parsed.cwd ? parsed.cwd : process.cwd();
    parts.push(`Working directory: ${sessionCwd}`);

    // Summary of THIS session only, since its previous Stop.
    const sessionKey = parsed.session_id || parsed.transcript_path;
    const offsets = readOffsets();
    let startOffset = 0;
    try {
      const prev = offsets[sessionKey];
      const size = fs.statSync(parsed.transcript_path).size;
      if (prev && prev.path === parsed.transcript_path && prev.offset <= size) startOffset = prev.offset;
    } catch {}
    const own = summarizeOwnTranscript(parsed.transcript_path, startOffset);
    if (own && own.userMessages.length === 0 && own.tools.size === 0) {
      offsets[sessionKey] = { path: parsed.transcript_path, offset: own.end };
      writeOffsets(offsets);
      process.stderr.write("[neuromcp-persist] Nothing new since previous Stop; no raw log\n");
      break stopHookBody;
    }
    const files = own ? [...own.files] : [];
    const tools = own ? [...own.tools] : [];
    const filesMatch = files.length ? [null, files.map((f) => `- ${f}`).join("\n")] : null;
    const toolsMatch = tools.length ? [null, tools.join(", ")] : null;
    if (parsed.session_id) parts.push(`Session ID: ${parsed.session_id}`);
    if (own) {
      if (own.userMessages.length) parts.push(`User messages:\n${own.userMessages.map((m) => `- ${m}`).join("\n")}`);
      if (tools.length) parts.push(`Tools used: ${tools.join(", ")}`);
      if (files.length) parts.push(`Files modified:\n${filesMatch[1]}`);
      if (own.releases.length) parts.push(`Release commands:\n${own.releases.map((r) => `- ${r}`).join("\n")}`);
      const cwdProject = projectOf(sessionCwd + path.sep);
      const projects = new Set(own.projects);
      if (!projects.size && cwdProject) projects.add(cwdProject);
      if (projects.size) parts.push(`Projects: ${[...projects].join(", ")}`);
    }

    // Read wiki log for session context (replaces work-state.md)
    const wikiLogFile = path.join(HOME, ".neuromcp", "wiki", "log.md");
    try {
      if (fs.existsSync(wikiLogFile)) {
        const wikiLog = fs.readFileSync(wikiLogFile, "utf8").trim();
        if (wikiLog.length > 0) {
          // Get last ~500 chars of log
          const recentLog = wikiLog.length > 500 ? wikiLog.slice(-500) : wikiLog;
          parts.push(`\n--- Recent Wiki Activity ---\n${recentLog}`);
        }
      }
    } catch {}

    // NOTE: Session summaries are NO LONGER written to SQLite.
    // They were 89% of all memories and polluted every search query.
    // Session context is preserved in:
    //   1. ~/.neuromcp/raw/sessions/ (raw logs below)
    //   2. ~/.neuromcp/.work-state.md (Claude writes proactively)
    //   3. ~/.neuromcp/wiki/ (persistent knowledge)

    // v2: Also write raw session log to wiki
    try {
      if (!fs.existsSync(RAW_SESSIONS_DIR)) {
        fs.mkdirSync(RAW_SESSIONS_DIR, { recursive: true });
      }
      const today = new Date().toISOString().split("T")[0];
      // Codex review 2026-06-07: HHMMSS (was HHMM) + collision counter so that
      // two Stop hooks within the same minute/second do not silently overwrite
      // each other's raw-log. Regression: tests/unit/hook-persist-filename-collision.test.ts.
      const time = new Date().toISOString().split("T")[1].replace(/:/g, "").slice(0, 6);
      let logFile = path.join(RAW_SESSIONS_DIR, `${today}-${time}.md`);
      let collisionSuffix = 1;
      while (fs.existsSync(logFile)) {
        logFile = path.join(RAW_SESSIONS_DIR, `${today}-${time}-${collisionSuffix}.md`);
        collisionSuffix++;
      }

      const logParts = [];
      logParts.push(`---`);
      logParts.push(`date: ${today}`);
      logParts.push(`directory: ${sessionCwd}`);
      logParts.push(`---`);
      logParts.push(``);
      for (const p of parts) {
        logParts.push(p);
      }
      fs.writeFileSync(logFile, logParts.join("\n"));
      if (own) { offsets[sessionKey] = { path: parsed.transcript_path, offset: own.end }; writeOffsets(offsets); }

      // v4: Auto-update .work-state.md so next session has fresh context.
      // Contract: `## Current Work`, `## Next Steps`, `## Decisions Made`,
      // `## Key Files`, `## Completed This Session` are CLAUDE-OWNED
      // sections — Adel's CLAUDE.md instructs Claude to write them via the
      // Write tool. The Stop hook must NEVER overwrite them with raw
      // user-message dumps from the transcript. Stop hook owns only the
      // `## Active Project` header at the top and a `## Recent Activity`
      // appendix with telemetry. Recursion-safe: previous session content
      // is collapsed into a single non-self-recursive block.
      try {
        const workStateFile = path.join(SESSION_DIR, ".work-state.md");

        // Headers the Stop hook NEVER writes — presence of any one is
        // a high-precision signal that Claude authored the body via the
        // Write tool. `## Current Work` and `## Completed This Session`
        // were both written by the old hook so they cannot serve as the
        // discriminator (any junk file from prior runs would echo them).
        const claudeOnlyHeads = [
          "## Next Steps",
          "## Decisions Made",
          "## Key Files",
        ];
        const stripPrevContext = (s) => {
          // Drop any nested "## Previous Session Context" + everything after
          // to break the compounding recursion bug.
          const idx = s.indexOf("## Previous Session Context");
          return idx >= 0 ? s.slice(0, idx).trimEnd() : s;
        };
        const stripActiveProject = (s) => {
          // Drop the "## Active Project" header block — Stop hook re-writes
          // it from wiki ground truth on every session.
          //
          // NOTE: `\Z` is NOT end-of-string in JavaScript regex (it matches a
          // literal `Z` character). We use `$` without the `m` flag, which
          // anchors to end-of-string. The non-greedy `[\s\S]*?` ensures we
          // stop at the first following `\n## ` header (next section) when
          // one exists, otherwise at end-of-string.
          return s
            .replace(/##\s+Active Project[\s\S]*?(?=\n##\s|$)/g, "")
            .replace(/^\s*\n+/, "");
        };

        let existingClaudeBody = "";
        let previousWork = "";
        try {
          if (fs.existsSync(workStateFile)) {
            const raw = fs.readFileSync(workStateFile, "utf8").trim();
            if (raw.length > 0) {
              const cleaned = stripPrevContext(stripActiveProject(raw));
              const looksClaudeOwned = claudeOnlyHeads.some((h) =>
                cleaned.includes(h)
              );
              if (looksClaudeOwned) {
                existingClaudeBody = cleaned;
              } else {
                previousWork = cleaned.slice(0, 800);
              }
            }
          }
        } catch {}

        const wsLines = [];

        // Active Project — derived from most recently modified wiki project page.
        // Stop hook always rewrites this; not Claude-owned.
        try {
          const projectsDir = path.join(HOME, ".neuromcp", "wiki", "projects");
          if (fs.existsSync(projectsDir)) {
            const now = Date.now();
            const twoHoursMs = 2 * 60 * 60 * 1000;
            const candidates = fs.readdirSync(projectsDir)
              .filter((f) => f.endsWith(".md"))
              .map((f) => ({
                slug: f.replace(".md", ""),
                mtime: fs.statSync(path.join(projectsDir, f)).mtimeMs,
              }))
              .filter((c) => now - c.mtime < twoHoursMs)
              .sort((a, b) => b.mtime - a.mtime);
            if (candidates.length > 0) {
              wsLines.push(`## Active Project`);
              wsLines.push(`${candidates[0].slug} — last updated ${new Date(candidates[0].mtime).toISOString()}`);
              wsLines.push(`Wiki page: ~/.neuromcp/wiki/projects/${candidates[0].slug}.md`);
              wsLines.push("");
            }
          }
        } catch {}

        if (existingClaudeBody) {
          // Claude wrote the structured body — preserve verbatim.
          wsLines.push(existingClaudeBody);
        } else {
          // No Claude-owned body — degrade to telemetry-only stub so next
          // session has at least an Active Project header. Do NOT fabricate
          // a "Current Work" block from raw user messages; that's how the
          // semanticize-prompt content leaked into <active-goal> for days.
          wsLines.push("## Current Work");
          wsLines.push("(no Claude-authored summary for last session — see Recent Activity)");
          wsLines.push("");
        }

        // Recent Activity — telemetry-only appendix. Distinct heading so the
        // working-context auto-refresh in working-context.py only ever reads
        // the Claude-owned `## Current Work` block.
        wsLines.push("");
        wsLines.push("## Recent Activity");
        if (filesMatch) {
          const now = Date.now();
          const twoHoursMs = 2 * 60 * 60 * 1000;
          const raw = filesMatch[1].trim().split("\n");
          const recent = [];
          for (const line of raw) {
            const p = line.replace(/^- /, "").trim();
            if (!p || !p.startsWith("/")) continue;
            try {
              const mt = fs.statSync(p).mtimeMs;
              if (now - mt < twoHoursMs) recent.push(`- ${p}`);
            } catch {}
            if (recent.length >= 15) break;
          }
          if (recent.length > 0) {
            wsLines.push("**Files modified (last 2h):**");
            for (const r of recent) wsLines.push(r);
          } else {
            wsLines.push("- (no files modified in last 2h)");
          }
        }
        if (toolsMatch) {
          wsLines.push("");
          wsLines.push("**Tools used:** " + toolsMatch[1].trim().replace(/\s+/g, " ").slice(0, 400));
        }

        // Carry forward only when previous file was NOT Claude-owned and is
        // actually informative. Recursion-safe via stripPrevContext above.
        if (previousWork) {
          wsLines.push("");
          wsLines.push("## Previous Session Context");
          wsLines.push(previousWork);
        }

        fs.writeFileSync(workStateFile, wsLines.join("\n") + "\n");
      } catch (wsErr) {
        process.stderr.write("[neuromcp-persist] work-state update failed: " + wsErr.message + "\n");
      }

      // Auto-commit wiki changes
      const wikiDir = path.join(HOME, ".neuromcp", "wiki");
      if (fs.existsSync(path.join(wikiDir, ".git"))) {
        try {
          execFileSync("git", ["-C", wikiDir, "add", "-A"], { timeout: 5000 });
          execFileSync("git", ["-C", wikiDir, "commit", "-m", `session: ${today}`, "--allow-empty"], { timeout: 5000 });
        } catch {}
      }
    } catch (logErr) {
      process.stderr.write("[neuromcp-persist] Wiki log failed: " + logErr.message + "\n");
    }
    } // close stopHookBody label block
  } else {
    const state = getCheckpointState();
    state.toolCallCount = (state.toolCallCount || 0) + 1;

    // Periodic checkpoint — write to wiki raw sessions (NOT SQLite)
    if (state.toolCallCount % CHECKPOINT_INTERVAL === 0) {
      const toolName = parsed.tool_name || "unknown";
      try {
        if (!fs.existsSync(RAW_SESSIONS_DIR)) {
          fs.mkdirSync(RAW_SESSIONS_DIR, { recursive: true });
        }
        const today = new Date().toISOString().split("T")[0];
        const checkpointFile = path.join(RAW_SESSIONS_DIR, `${today}-checkpoint.md`);
        const line = `- ${new Date().toISOString()} | ${state.toolCallCount} tool calls | last: ${toolName} | cwd: ${process.cwd()}\n`;
        fs.appendFileSync(checkpointFile, line);
      } catch {}
      state.lastCheckpoint = new Date().toISOString();
    }

    // Periodic reminder — nudge Claude to update wiki
    if (state.toolCallCount % REMINDER_INTERVAL === 0) {
      process.stdout.write(
        "\n[WIKI REMINDER] If you learned something persistent this session (new project info, decisions, error patterns, procedures), update the relevant wiki page in ~/.neuromcp/wiki/ now. Check schema.md for what qualifies as persistent.\n"
      );
    }

    saveCheckpointState(state);
  }
} catch (err) {
  process.stderr.write("[neuromcp-persist] Error: " + err.message + "\n");
}
