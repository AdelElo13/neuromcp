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

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
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
    // Migration (v0.22.0): neuromcp-persist renamed .js → .cjs to force
    // CommonJS regardless of parent package.json. Archive the old file so
    // the new one installs cleanly, and below we patch settings.json to
    // point at the new filename.
    const oldPersistHook = join(claudeHooksDir, 'neuromcp-persist.js');
    if (existsSync(oldPersistHook)) {
      const archived = `${oldPersistHook}.bak-pre-cjs-${Date.now()}`;
      renameSync(oldPersistHook, archived);
      log(`Migrated: archived old neuromcp-persist.js → ${archived}`);
    }
    for (const hook of ['neuromcp-context-inject.js', 'neuromcp-persist.cjs', 'neuromcp-auto-capture.js', 'neuromcp-auto-retrieve.cjs', 'neuromcp-critic.cjs', 'neuromcp-health-check.cjs']) {
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
    'SessionStart:health-check': {
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `node "${claudeHooksDir}/neuromcp-health-check.cjs"`,
        timeout: 8,
      }],
    },
    PostToolUse: {
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `CLAUDE_HOOK_EVENT=PostToolUse node "${claudeHooksDir}/neuromcp-persist.cjs"`,
        timeout: 5,
        async: true,
      }],
    },
    Stop: {
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `CLAUDE_HOOK_EVENT=Stop node "${claudeHooksDir}/neuromcp-persist.cjs"`,
        timeout: 10,
      }],
    },
    'Stop:auto-capture': {
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `node "${claudeHooksDir}/neuromcp-auto-capture.js"`,
        timeout: 15,
        async: true,
      }],
    },
    'Stop:neuromcp-critic': {
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `node "${claudeHooksDir}/neuromcp-critic.cjs"`,
        timeout: 30,
        async: true,
      }],
    },
    UserPromptSubmit: {
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `node "${claudeHooksDir}/neuromcp-auto-retrieve.cjs"`,
        timeout: 2,
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

    // Migration (v0.22.0): rewrite stale .js commands to .cjs after rename.
    let migratedCommands = 0;
    for (const evt of Object.values(settings.hooks)) {
      if (!Array.isArray(evt)) continue;
      for (const entry of evt) {
        if (!Array.isArray(entry.hooks)) continue;
        for (const h of entry.hooks) {
          if (h.command && h.command.includes('neuromcp-persist.js')) {
            h.command = h.command.replace(/neuromcp-persist\.js/g, 'neuromcp-persist.cjs');
            migratedCommands++;
          }
        }
      }
    }
    if (migratedCommands > 0) {
      log(`Migrated ${migratedCommands} settings.json command(s) from neuromcp-persist.js → .cjs`);
    }

    let added = 0;

    for (const [eventType, entry] of Object.entries(neuromcpHooks)) {
      // Stop:auto-capture is registered under the Stop event type;
      // SessionStart:health-check under the SessionStart event type.
      const actualEventType = eventType.startsWith('Stop:') ? 'Stop'
        : eventType.startsWith('SessionStart:') ? 'SessionStart'
        : eventType;
      if (!settings.hooks[actualEventType]) settings.hooks[actualEventType] = [];
      const marker = eventType === 'SessionStart' ? 'neuromcp-context-inject'
        : eventType.includes('health-check') ? 'neuromcp-health-check'
        : eventType.includes('auto-capture') ? 'neuromcp-auto-capture'
        : eventType.includes('neuromcp-critic') ? 'neuromcp-critic'
        : eventType === 'UserPromptSubmit' ? 'neuromcp-auto-retrieve'
        : 'neuromcp-persist';
      if (!hasNeuromcpHook(settings.hooks[actualEventType], marker)) {
        settings.hooks[actualEventType].push(entry);
        log(`Added ${eventType} hook to settings.json`);
        added++;
      } else {
        skip(`${eventType} hook in settings.json`);
      }
    }

    if (added > 0 || migratedCommands > 0) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      log(`Saved ${settingsPath.replace(HOME, '~')}`);
    }
  } catch (err) {
    warn(`Could not auto-configure hooks in settings.json: ${err.message}`);
    console.log('  Add them manually — see https://github.com/AdelElo13/neuromcp#hooks\n');
  }

  // ─── Auto-install zombie-cleanup (macOS only, opt-OUT via --no-zombie-cleanup) ──
  // The Claude desktop app persists session metadata before any user message
  // exists, creating "No messages yet" zombies in Recents. We auto-install
  // a launchd reaper to keep that clean. See anthropics/claude-code#59134.
  // Failures here never break init-wiki — the user can run it manually later.
  const skipZombie = args.includes('--no-zombie-cleanup');
  if (!skipZombie && platform() === 'darwin') {
    console.log('');
    console.log('🧹 Auto-installing Claude desktop-app zombie-session cleanup…');
    try {
      const installerPath = join(__dirname, 'enable-zombie-cleanup.mjs');
      execFileSync('node', [installerPath], { stdio: 'inherit' });
    } catch (err) {
      warn(`zombie-cleanup auto-install skipped: ${err.message || 'see above'}`);
      console.log('  Run later: npx neuromcp-enable-zombie-cleanup');
    }
  } else if (!skipZombie) {
    console.log('');
    console.log(`  · zombie-cleanup skipped — macOS only (your platform: ${platform()})`);
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

console.log('💡 Optional: enable auto-consolidation (raw sessions → wiki every 4h):');
console.log('   npx neuromcp-enable-consolidation\n');
console.log('   Requires the `claude` CLI (Claude Code) + python3 on PATH.\n');
