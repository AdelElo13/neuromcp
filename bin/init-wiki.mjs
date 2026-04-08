#!/usr/bin/env node
/**
 * neuromcp init-wiki — Initialize the wiki knowledge base
 *
 * Creates:
 *   ~/.neuromcp/wiki/           (git-tracked compiled knowledge)
 *   ~/.neuromcp/raw/sessions/   (raw session logs)
 *
 * Copies template files and initializes git.
 * Installs hooks (Claude Code) and rules (other editors).
 * Safe to run multiple times — won't overwrite existing files.
 *
 * Usage:
 *   npx neuromcp-init-wiki                    # auto-detect editors
 *   npx neuromcp-init-wiki --editor cursor    # explicit editor
 *   npx neuromcp-init-wiki --editor all       # install all rules
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const NEUROMCP_DIR = join(HOME, '.neuromcp');
const WIKI_DIR = join(NEUROMCP_DIR, 'wiki');
const RAW_DIR = join(NEUROMCP_DIR, 'raw', 'sessions');
const TEMPLATES_DIR = join(__dirname, '..', 'templates');

function log(msg) { console.log(`  ✓ ${msg}`); }
function skip(msg) { console.log(`  · ${msg} (already exists)`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }

// Parse --editor flag
const args = process.argv.slice(2);
const editorFlagIdx = args.indexOf('--editor');
const requestedEditor = editorFlagIdx !== -1 ? args[editorFlagIdx + 1]?.toLowerCase() : null;

console.log('\n🧠 neuromcp wiki — initializing knowledge base\n');

// Create directories
for (const dir of [
  join(WIKI_DIR, 'people'),
  join(WIKI_DIR, 'projects'),
  join(WIKI_DIR, 'systems'),
  join(WIKI_DIR, 'patterns'),
  join(WIKI_DIR, 'decisions'),
  join(WIKI_DIR, 'skills'),
  RAW_DIR,
]) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    log(`Created ${dir.replace(HOME, '~')}`);
  }
}

// Copy template files (don't overwrite)
const templates = ['wiki/index.md', 'wiki/schema.md', 'wiki/log.md'];
for (const tpl of templates) {
  const src = join(TEMPLATES_DIR, tpl);
  const dest = join(NEUROMCP_DIR, tpl);
  if (!existsSync(dest) && existsSync(src)) {
    copyFileSync(src, dest);
    log(`Created ${dest.replace(HOME, '~')}`);
  } else if (existsSync(dest)) {
    skip(dest.replace(HOME, '~'));
  }
}

// Init git on wiki
if (!existsSync(join(WIKI_DIR, '.git'))) {
  try {
    execFileSync('git', ['-C', WIKI_DIR, 'init'], { stdio: 'pipe' });
    execFileSync('git', ['-C', WIKI_DIR, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', WIKI_DIR, 'commit', '-m', 'neuromcp wiki initialized'], { stdio: 'pipe' });
    log('Initialized git in wiki/');
  } catch (err) {
    warn(`Git init failed: ${err.message}`);
  }
} else {
  skip('wiki/.git');
}

// ─── Claude Code: hooks ───────────────────────────────────────────────
const hooksDir = join(TEMPLATES_DIR, 'hooks');
const claudeHooksDir = join(HOME, '.claude', 'scripts', 'hooks');

if (!requestedEditor || requestedEditor === 'claude' || requestedEditor === 'all') {
  if (existsSync(hooksDir)) {
    if (!existsSync(claudeHooksDir)) {
      mkdirSync(claudeHooksDir, { recursive: true });
    }
    for (const hook of ['neuromcp-context-inject.js', 'neuromcp-persist.js']) {
      const src = join(hooksDir, hook);
      const dest = join(claudeHooksDir, hook);
      if (!existsSync(dest) && existsSync(src)) {
        copyFileSync(src, dest);
        log(`Installed hook: ${hook}`);
      } else if (existsSync(dest)) {
        skip(`Hook: ${hook}`);
      }
    }
  }

  // Auto-inject hooks into ~/.claude/settings.json
  const settingsPath = join(HOME, '.claude', 'settings.json');
  const neuromcpHooks = {
    SessionStart: {
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `node "${claudeHooksDir}/neuromcp-context-inject.js"`,
        timeout: 5,
      }],
    },
    PostToolUse: {
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `CLAUDE_HOOK_EVENT=PostToolUse node "${claudeHooksDir}/neuromcp-persist.js"`,
        timeout: 5,
        async: true,
      }],
    },
    Stop: {
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `CLAUDE_HOOK_EVENT=Stop node "${claudeHooksDir}/neuromcp-persist.js"`,
        timeout: 10,
      }],
    },
  };

  function hasNeuromcpHook(entries, command) {
    if (!Array.isArray(entries)) return false;
    return entries.some(entry =>
      Array.isArray(entry.hooks) && entry.hooks.some(h => h.command && h.command.includes(command))
    );
  }

  try {
    let settings = {};
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } else {
      mkdirSync(dirname(settingsPath), { recursive: true });
    }

    if (!settings.hooks) settings.hooks = {};
    let added = 0;

    for (const [eventType, entry] of Object.entries(neuromcpHooks)) {
      if (!settings.hooks[eventType]) settings.hooks[eventType] = [];
      const marker = eventType === 'SessionStart' ? 'neuromcp-context-inject' : 'neuromcp-persist';
      if (!hasNeuromcpHook(settings.hooks[eventType], marker)) {
        settings.hooks[eventType].push(entry);
        log(`Added ${eventType} hook to settings.json`);
        added++;
      } else {
        skip(`${eventType} hook in settings.json`);
      }
    }

    if (added > 0) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      log(`Saved ${settingsPath.replace(HOME, '~')}`);
    }
  } catch (err) {
    warn(`Could not auto-configure hooks in settings.json: ${err.message}`);
    console.log('  Add them manually — see https://github.com/AdelElo13/neuromcp#hooks\n');
  }
}

// ─── Other editors: rules ─────────────────────────────────────────────
const EDITORS = [
  { id: 'cursor',    name: 'Cursor',         dir: join(HOME, '.cursor', 'rules'),  file: 'neuromcp.mdc' },
  { id: 'windsurf',  name: 'Windsurf',       dir: join(HOME, '.windsurf', 'rules'), file: 'neuromcp.md' },
  { id: 'cline',     name: 'Cline',          dir: join(HOME, '.clinerules'),        file: 'neuromcp.md' },
  { id: 'copilot',   name: 'VS Code Copilot', dir: join(HOME, '.github'),           file: 'copilot-instructions.md' },
  { id: 'jetbrains', name: 'JetBrains',      dir: join(HOME, '.junie', 'rules'),    file: 'neuromcp.md' },
  { id: 'zed',       name: 'Zed',            dir: join(HOME, '.config', 'zed'),     file: '.rules' },
];

const rulesSource = join(TEMPLATES_DIR, 'rules', 'neuromcp.md');
if (existsSync(rulesSource)) {
  const rulesContent = readFileSync(rulesSource, 'utf-8');

  for (const editor of EDITORS) {
    // Skip if user requested a specific editor and this isn't it
    if (requestedEditor && requestedEditor !== 'all' && requestedEditor !== editor.id) continue;

    const dest = join(editor.dir, editor.file);

    if (requestedEditor === 'all' || requestedEditor === editor.id) {
      // Explicit request: create dir if needed
      if (!existsSync(editor.dir)) {
        mkdirSync(editor.dir, { recursive: true });
      }
      if (!existsSync(dest)) {
        writeFileSync(dest, rulesContent);
        log(`Installed ${editor.name} rules: ${dest.replace(HOME, '~')}`);
      } else {
        skip(`${editor.name} rules`);
      }
    } else if (!requestedEditor) {
      // Auto-detect: only install if dir already exists
      if (existsSync(editor.dir)) {
        if (!existsSync(dest)) {
          writeFileSync(dest, rulesContent);
          log(`Installed ${editor.name} rules: ${dest.replace(HOME, '~')}`);
        } else {
          skip(`${editor.name} rules`);
        }
      }
    }
  }
}

// ─── Summary ──────────────────────────────────────────────────────────
console.log('\n✅ Wiki ready at ~/.neuromcp/wiki/');
if (!requestedEditor) {
  console.log('   Claude Code: hooks installed automatically.');
  console.log('   Other editors: rules installed where detected.');
  console.log('   Use --editor <name|all> to target specific editors.\n');
  console.log('   Supported: cursor, windsurf, cline, copilot, jetbrains, zed\n');
} else {
  console.log(`   Configured for: ${requestedEditor}\n`);
}
