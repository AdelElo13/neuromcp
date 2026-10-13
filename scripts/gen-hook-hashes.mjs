#!/usr/bin/env node
/**
 * Regenerate templates/hooks/shipped-hashes.json: the sha256 of every hook
 * template version that was RELEASED (present at a `v*` tag, under its .js or
 * .cjs name), plus the current working-tree version (the next release).
 * Branches, stashes and unreleased commits are deliberately ignored: a hook
 * that only ever existed there was never shipped, so it may hold a user's own
 * work and must never be treated as an unmodified older version.
 *
 * neuromcp-init-wiki uses it to tell an UNMODIFIED older hook (safe to
 * update automatically, with a backup) from a hook the user edited (only
 * reported). Run it whenever a file in templates/hooks/ changes:
 *
 *   node scripts/gen-hook-hashes.mjs
 *
 * tests/integration/init-wiki-hooks.test.ts fails when the current templates
 * are missing from the file.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_DIR = join(ROOT, 'templates', 'hooks');
const OUT = join(HOOKS_DIR, 'shipped-hashes.json');
const HOOKS = [
  'neuromcp-persist',
  'neuromcp-auto-capture',
  'neuromcp-context-inject',
  'neuromcp-auto-retrieve',
  'neuromcp-critic',
  'neuromcp-health-check',
];

/** @param {Buffer} buf */
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
/** @param {string[]} args @returns {Buffer} */
const git = (args) =>
  execFileSync('git', ['-C', ROOT, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

const tags = git(['tag', '--list', 'v*']).toString().split('\n').filter(Boolean);
if (tags.length === 0) {
  console.error('No v* tags found — run in a full clone (git fetch --tags), not a shallow checkout.');
  process.exit(1);
}
/** @type {Record<string, string[]>} */
const result = {};
for (const hook of HOOKS) {
  const hashes = new Set();
  for (const ext of ['.js', '.cjs']) {
    const rel = `templates/hooks/${hook}${ext}`;
    for (const tag of tags) {
      try {
        hashes.add(sha256(git(['show', `${tag}:${rel}`])));
      } catch {
        /* hook absent at that release */
      }
    }
    const current = join(HOOKS_DIR, `${hook}${ext}`);
    if (existsSync(current)) hashes.add(sha256(readFileSync(current)));
  }
  result[hook] = [...hashes].sort();
}

writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
console.log(`Wrote ${OUT}: ${HOOKS.map((h) => `${h}=${result[h].length}`).join(', ')}`);
