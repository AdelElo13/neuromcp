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
 * Read the most recent session .tmp file to get richer context
 * about what was happening in this session.
 */
function getSessionContent() {
  const sessDir = path.join(
    HOME,
    ".claude",
    "session-data"
  );
  if (!fs.existsSync(sessDir)) return null;
  try {
    const files = fs
      .readdirSync(sessDir)
      .filter((f) => f.endsWith("-session.tmp"))
      .map((f) => ({
        name: f,
        mtime: fs.statSync(path.join(sessDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    return fs.readFileSync(path.join(sessDir, files[0].name), "utf8");
  } catch {
    return null;
  }
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
    const text = fs.readFileSync(transcriptPath, "utf8");
    let count = 0;
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        const isUser =
          e.type === "user" || e.role === "user" || e.message?.role === "user";
        if (!isUser) continue;
        const c = e.message?.content ?? e.content;
        const body = typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.map((x) => (x && x.text) || "").join("")
            : "";
        if (body.trim()) count++;
      } catch {}
    }
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
    parts.push(`Working directory: ${process.cwd()}`);

    // Include session .tmp content (has tasks, tools used, files modified)
    const sessionContent = getSessionContent();
    let tasksMatch = null;
    let toolsMatch = null;
    let filesMatch = null;
    let notesMatch = null;
    if (sessionContent) {
      // Extract the useful parts from the session .tmp
      tasksMatch = sessionContent.match(
        /### Tasks\n([\s\S]*?)(?=\n###|\n---)/
      );
      toolsMatch = sessionContent.match(
        /### Tools Used\n([\s\S]*?)(?=\n###|\n---)/
      );
      filesMatch = sessionContent.match(
        /### Files Modified\n([\s\S]*?)(?=\n###|\n---)/
      );
      notesMatch = sessionContent.match(
        /### Notes for Next Session\n([\s\S]*?)(?=\n###|\n---)/
      );

      if (tasksMatch) parts.push(`User messages: ${tasksMatch[1].trim()}`);
      if (toolsMatch) parts.push(`Tools used: ${toolsMatch[1].trim()}`);
      if (filesMatch) parts.push(`Files modified: ${filesMatch[1].trim()}`);
      if (notesMatch && notesMatch[1].trim() !== "-")
        parts.push(`Notes: ${notesMatch[1].trim()}`);
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
      const time = new Date().toISOString().split("T")[1].replace(/:/g, "").slice(0, 4);
      const logFile = path.join(RAW_SESSIONS_DIR, `${today}-${time}.md`);

      const logParts = [];
      logParts.push(`---`);
      logParts.push(`date: ${today}`);
      logParts.push(`directory: ${process.cwd()}`);
      logParts.push(`---`);
      logParts.push(``);
      for (const p of parts) {
        logParts.push(p);
      }
      fs.writeFileSync(logFile, logParts.join("\n"));

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
          return s
            .replace(/##\s+Active Project[\s\S]*?(?=\n##\s|\Z)/g, "")
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
