#!/usr/bin/env node
'use strict';

/**
 * neuromcp-context-inject.js — SessionStart hook
 *
 * Injects wiki index + relevant project page + last session context.
 * Wiki-first approach: index.md is the primary knowledge source.
 *
 * Install: Add to ~/.claude/settings.json under hooks.SessionStart
 */

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE || '/tmp';
const WIKI_DIR = path.join(HOME, '.neuromcp', 'wiki');
const INDEX_PATH = path.join(WIKI_DIR, 'index.md');
const SCHEMA_PATH = path.join(WIKI_DIR, 'schema.md');

const raw = fs.readFileSync(0, 'utf8');

function readFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (content.length > 0) return content;
    }
  } catch {}
  return null;
}

function getProjectPage() {
  const cwd = process.cwd();
  const projectsDir = path.join(WIKI_DIR, 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  try {
    const files = fs.readdirSync(projectsDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const slug = file.replace('.md', '');
      if (cwd.toLowerCase().includes(slug.toLowerCase())) {
        return { slug, content: readFile(path.join(projectsDir, file)) };
      }
    }
  } catch {}
  return null;
}

/**
 * Find the most recently modified wiki project page (within last 48h).
 * Catches the "active project" even when cwd doesn't match — e.g. when
 * the user runs Claude from their home directory while working on a
 * project whose files live elsewhere.
 */
function getActiveProjectPage() {
  const projectsDir = path.join(WIKI_DIR, 'projects');
  if (!fs.existsSync(projectsDir)) return null;
  try {
    const now = Date.now();
    const fortyEightHoursMs = 48 * 60 * 60 * 1000;
    const candidates = fs.readdirSync(projectsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({
        slug: f.replace('.md', ''),
        fullPath: path.join(projectsDir, f),
        mtime: fs.statSync(path.join(projectsDir, f)).mtimeMs,
      }))
      .filter((c) => now - c.mtime < fortyEightHoursMs)
      .sort((a, b) => b.mtime - a.mtime);
    if (candidates.length === 0) return null;
    const top = candidates[0];
    return { slug: top.slug, content: readFile(top.fullPath), mtime: top.mtime };
  } catch {
    return null;
  }
}

function getUserPage() {
  const peopleDir = path.join(WIKI_DIR, 'people');
  if (!fs.existsSync(peopleDir)) return null;
  try {
    const files = fs.readdirSync(peopleDir).filter(f => f.endsWith('.md'));
    if (files.length > 0) return readFile(path.join(peopleDir, files[0]));
  } catch {}
  return null;
}

function getLastSessionLog() {
  const sessDir = path.join(HOME, '.neuromcp', 'raw', 'sessions');
  if (!fs.existsSync(sessDir)) return null;
  try {
    const files = fs.readdirSync(sessDir)
      .filter(f => f.endsWith('.md') && !f.includes('checkpoint'))
      .sort().reverse();
    if (files.length === 0) return null;
    return { name: files[0], content: readFile(path.join(sessDir, files[0])) };
  } catch {}
  return null;
}

function getRecentLog() {
  const logPath = path.join(WIKI_DIR, 'log.md');
  const content = readFile(logPath);
  if (!content) return null;
  return content.length > 500 ? content.slice(-500) : content;
}

// Build context
const parts = [];

const schema = readFile(SCHEMA_PATH);
if (schema) parts.push(`<neuromcp-schema>\n${schema}\n</neuromcp-schema>`);

const index = readFile(INDEX_PATH);
if (index) parts.push(`<neuromcp-index>\n${index}\n</neuromcp-index>`);

const user = getUserPage();
if (user) parts.push(`<neuromcp-user>\n${user}\n</neuromcp-user>`);

// Active project — most recently edited wiki page (last 48h).
// Ground truth of "what are we working on" regardless of cwd.
const activeProject = getActiveProjectPage();
if (activeProject && activeProject.content) {
  const ago = Math.round((Date.now() - activeProject.mtime) / 60000);
  parts.push(`<active-project slug="${activeProject.slug}" updated="${ago}m ago">\n${activeProject.content}\n</active-project>`);
}

// cwd-matched project page (only if different from active project)
const project = getProjectPage();
if (project && project.content && (!activeProject || project.slug !== activeProject.slug)) {
  parts.push(`<neuromcp-project slug="${project.slug}">\n${project.content}\n</neuromcp-project>`);
}

const lastSession = getLastSessionLog();
const recentLog = getRecentLog();
if (lastSession || recentLog) {
  let caption = `<last-session>`;
  if (lastSession && lastSession.content) {
    caption += `\n## Last session (${lastSession.name})\n${lastSession.content}`;
  }
  if (recentLog) {
    caption += `\n## Recent wiki changes\n${recentLog}`;
  }
  caption += `\nIf the user's first message is ambiguous or they ask "where were we", use this context to resume seamlessly.\n</last-session>`;
  parts.push(caption);
}

if (parts.length > 0) {
  const contextBlock = '\n' + parts.join('\n\n');
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      parsed.additionalContext = (parsed.additionalContext || '') + contextBlock;
      process.stdout.write(JSON.stringify(parsed));
    } else {
      process.stdout.write(raw + contextBlock);
    }
  } catch {
    process.stdout.write(raw + contextBlock);
  }
} else {
  process.stdout.write(raw);
}
