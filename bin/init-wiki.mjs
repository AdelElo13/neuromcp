#!/usr/bin/env node
/**
 * neuromcp init-wiki — Initialize the wiki knowledge base
 *
 * Creates:
 *   ~/.neuromcp/wiki/           (git-tracked compiled knowledge)
 *   ~/.neuromcp/raw/sessions/   (raw session logs)
 *
 * Copies template files and initializes git.
 * Safe to run multiple times — won't overwrite existing files.
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
    console.log(`  ⚠ Git init failed: ${err.message}`);
  }
} else {
  skip('wiki/.git');
}

// Copy hooks
const hooksDir = join(TEMPLATES_DIR, 'hooks');
const claudeHooksDir = join(HOME, '.claude', 'scripts', 'hooks');
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

// Print setup instructions
console.log('\n📋 Next steps:\n');
console.log('Add these hooks to ~/.claude/settings.json:\n');
console.log(`{
  "hooks": {
    "SessionStart": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "node \\"${claudeHooksDir}/neuromcp-context-inject.js\\"",
        "timeout": 5
      }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "CLAUDE_HOOK_EVENT=PostToolUse node \\"${claudeHooksDir}/neuromcp-persist.js\\"",
        "timeout": 5,
        "async": true
      }]
    }],
    "Stop": [{
      "matcher": "*",
      "hooks": [{
        "type": "command",
        "command": "CLAUDE_HOOK_EVENT=Stop node \\"${claudeHooksDir}/neuromcp-persist.js\\"",
        "timeout": 10
      }]
    }]
  }
}`);

console.log('\n✅ Wiki ready at ~/.neuromcp/wiki/');
console.log('   Start a Claude Code session — your wiki will be injected automatically.\n');
