#!/usr/bin/env node
/**
 * neuromcp-persist.js — Crash-resilient wiki persistence hook
 *
 * PostToolUse: periodic checkpoints to raw/sessions/ + wiki update reminders
 * Stop: writes session log to raw/sessions/ + auto-commits wiki changes
 *
 * Install: Add to ~/.claude/settings.json under hooks.PostToolUse and hooks.Stop
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = process.env.HOME || process.env.USERPROFILE || "/tmp";
const RAW_SESSIONS_DIR = path.join(HOME, ".neuromcp", "raw", "sessions");
const CHECKPOINT_STATE = path.join(HOME, ".neuromcp", ".checkpoint-state.json");
const CHECKPOINT_INTERVAL = 5;
const REMINDER_INTERVAL = 8;

function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}

function getSessionContent() {
  const sessDir = path.join(HOME, ".claude", "session-data");
  if (!fs.existsSync(sessDir)) return null;
  try {
    const files = fs.readdirSync(sessDir)
      .filter((f) => f.endsWith("-session.tmp"))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(sessDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    return fs.readFileSync(path.join(sessDir, files[0].name), "utf8");
  } catch { return null; }
}

function getCheckpointState() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT_STATE, "utf8")); }
  catch { return { toolCallCount: 0, lastCheckpoint: null }; }
}

function saveCheckpointState(state) {
  try { fs.writeFileSync(CHECKPOINT_STATE, JSON.stringify(state)); } catch {}
}

const hookEvent = process.env.CLAUDE_HOOK_EVENT || "";
const isStopHook = hookEvent === "Stop" || hookEvent === "SessionEnd";
const raw = readStdin();

if (isStopHook) {
  process.stdout.write(raw);
}

try {
  let parsed = {};
  if (raw) { try { parsed = JSON.parse(raw); } catch {} }

  if (isStopHook) {
    const parts = [];
    parts.push(`Session ended: ${new Date().toISOString()}`);
    parts.push(`Working directory: ${process.cwd()}`);

    const sessionContent = getSessionContent();
    if (sessionContent) {
      const tasksMatch = sessionContent.match(/### Tasks\n([\s\S]*?)(?=\n###|\n---)/);
      const filesMatch = sessionContent.match(/### Files Modified\n([\s\S]*?)(?=\n###|\n---)/);
      if (tasksMatch) parts.push(`User messages: ${tasksMatch[1].trim()}`);
      if (filesMatch) parts.push(`Files modified: ${filesMatch[1].trim()}`);
    }

    // Read wiki log for context
    const wikiLogFile = path.join(HOME, ".neuromcp", "wiki", "log.md");
    try {
      if (fs.existsSync(wikiLogFile)) {
        const wikiLog = fs.readFileSync(wikiLogFile, "utf8").trim();
        if (wikiLog.length > 0) {
          const recentLog = wikiLog.length > 500 ? wikiLog.slice(-500) : wikiLog;
          parts.push(`\n--- Recent Wiki Activity ---\n${recentLog}`);
        }
      }
    } catch {}

    // Write raw session log
    try {
      if (!fs.existsSync(RAW_SESSIONS_DIR)) {
        fs.mkdirSync(RAW_SESSIONS_DIR, { recursive: true });
      }
      const today = new Date().toISOString().split("T")[0];
      const time = new Date().toISOString().split("T")[1].replace(/:/g, "").slice(0, 4);
      const logFile = path.join(RAW_SESSIONS_DIR, `${today}-${time}.md`);

      const logParts = [`---`, `date: ${today}`, `directory: ${process.cwd()}`, `---`, ``];
      for (const p of parts) logParts.push(p);
      fs.writeFileSync(logFile, logParts.join("\n"));

      // Auto-commit wiki changes
      const wikiDir = path.join(HOME, ".neuromcp", "wiki");
      if (fs.existsSync(path.join(wikiDir, ".git"))) {
        try {
          execFileSync("git", ["-C", wikiDir, "add", "-A"], { timeout: 5000 });
          execFileSync("git", ["-C", wikiDir, "commit", "-m", `session: ${today}`, "--allow-empty"], { timeout: 5000 });
        } catch {}
      }
    } catch (err) {
      process.stderr.write("[neuromcp-persist] Wiki log failed: " + err.message + "\n");
    }
  } else {
    const state = getCheckpointState();
    state.toolCallCount = (state.toolCallCount || 0) + 1;

    // Periodic checkpoint — write to file (not SQLite)
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

    // Periodic reminder — nudge LLM to update wiki
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
