import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * neuromcp-init-wiki hook installation and upgrades.
 *
 *  - auto-capture and context-inject are CommonJS; as `.js` they crash when a
 *    parent package.json says "type": "module" (persist was renamed to .cjs
 *    for the same reason in v0.22). Installs migrate .js → .cjs, archive the
 *    old file and rewrite the settings.json commands.
 *  - Hooks were never overwritten, so existing users never received hook
 *    fixes (e.g. transcript streaming). Init now reports drift and
 *    `--update-hooks` replaces drifted hooks, keeping a backup.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const INIT = join(HERE, '..', '..', 'bin', 'init-wiki.mjs');
const TEMPLATES = join(HERE, '..', '..', 'templates', 'hooks');

function runInit(home: string, args: string[] = []) {
  // --no-zombie-cleanup: init-wiki otherwise registers a REAL launchd agent
  // (global label, macOS) pointing at this temp HOME.
  return spawnSync('node', [INIT, '--editor', 'claude', '--no-zombie-cleanup', ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 30000,
  });
}

describe('neuromcp-init-wiki hooks', () => {
  let home: string;
  let hooksDir: string;
  let settingsPath: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nmcp-init-'));
    hooksDir = join(home, '.claude', 'scripts', 'hooks');
    settingsPath = join(home, '.claude', 'settings.json');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('a fresh install uses .cjs for every CommonJS hook', () => {
    const r = runInit(home);
    expect(r.status).toBe(0);
    const files = readdirSync(hooksDir);
    expect(files).toContain('neuromcp-auto-capture.cjs');
    expect(files).toContain('neuromcp-context-inject.cjs');
    expect(files.filter((f) => f.endsWith('.js'))).toEqual([]);
    const settings = readFileSync(settingsPath, 'utf8');
    expect(settings).toContain('neuromcp-auto-capture.cjs');
    expect(settings).toContain('neuromcp-context-inject.cjs');
    expect(settings).not.toMatch(/neuromcp-(auto-capture|context-inject)\.js"/);
  });

  it('migrates an existing .js install: archives old files and rewrites settings.json', () => {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'neuromcp-auto-capture.js'), '// old\n');
    writeFileSync(join(hooksDir, 'neuromcp-context-inject.js'), '// old\n');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${hooksDir}/neuromcp-context-inject.js"` }] }],
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${hooksDir}/neuromcp-auto-capture.js"` }] }],
        },
      }),
    );

    const r = runInit(home);
    expect(r.status).toBe(0);
    const files = readdirSync(hooksDir);
    expect(files).toContain('neuromcp-auto-capture.cjs');
    expect(files).not.toContain('neuromcp-auto-capture.js');
    expect(files.some((f) => f.startsWith('neuromcp-auto-capture.js.bak-pre-cjs-'))).toBe(true);
    const settings = readFileSync(settingsPath, 'utf8');
    expect(settings).toContain('neuromcp-auto-capture.cjs');
    expect(settings).toContain('neuromcp-context-inject.cjs');
    expect(settings).not.toMatch(/neuromcp-(auto-capture|context-inject)\.js"/);
    // No duplicate registrations after the rewrite.
    expect(settings.match(/neuromcp-auto-capture\.cjs/g)?.length).toBe(1);
  });

  it('reports drifted hooks, and --update-hooks replaces them with a backup', () => {
    expect(runInit(home).status).toBe(0);
    const hook = join(hooksDir, 'neuromcp-persist.cjs');
    writeFileSync(hook, '// locally modified\n');

    const plain = runInit(home);
    expect(plain.stdout).toMatch(/neuromcp-persist\.cjs differs from the shipped version/);
    expect(readFileSync(hook, 'utf8')).toBe('// locally modified\n');

    const upd = runInit(home, ['--update-hooks']);
    expect(upd.status).toBe(0);
    expect(readFileSync(hook, 'utf8')).toBe(readFileSync(join(TEMPLATES, 'neuromcp-persist.cjs'), 'utf8'));
    const backups = readdirSync(hooksDir).filter((f) => f.startsWith('neuromcp-persist.cjs.bak-'));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(hooksDir, backups[0]!), 'utf8')).toBe('// locally modified\n');
    expect(existsSync(hook)).toBe(true);
  });
});
