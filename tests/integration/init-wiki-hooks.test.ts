import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * neuromcp-init-wiki hook installation and upgrades.
 *
 *  - auto-capture and context-inject are CommonJS; as `.js` they crash when a
 *    parent package.json says "type": "module". Installs migrate .js → .cjs
 *    and rewrite settings.json (with a backup). The old .js path becomes a
 *    tiny shim so other references (hooks.json, plugins) keep working.
 *  - A user's edits survive: a modified old .js moves to .cjs as-is.
 *  - An UNMODIFIED older hook (sha256 in templates/hooks/shipped-hashes.json)
 *    is updated automatically, with a backup; modified hooks are only
 *    reported unless `--update-hooks` is passed.
 *  - Nothing is moved when settings.json cannot be parsed.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const INIT = join(ROOT, 'bin', 'init-wiki.mjs');
const TEMPLATES = join(ROOT, 'templates', 'hooks');
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'hooks');

function runInit(home: string, args: string[] = []) {
  // --no-zombie-cleanup: init-wiki otherwise registers a REAL launchd agent
  // (global label, macOS) pointing at this temp HOME.
  return spawnSync('node', [INIT, '--editor', 'claude', '--no-zombie-cleanup', ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 30000,
  });
}

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('shipped-hashes.json', () => {
  it('contains the current version of every hook template (regenerate with scripts/gen-hook-hashes.mjs)', () => {
    const hashes = JSON.parse(readFileSync(join(TEMPLATES, 'shipped-hashes.json'), 'utf8')) as Record<string, string[]>;
    for (const file of readdirSync(TEMPLATES).filter((f) => /^neuromcp-.*\.cjs$/.test(f))) {
      const hook = file.replace(/\.cjs$/, '');
      expect(hashes[hook], hook).toContain(sha(join(TEMPLATES, file)));
    }
  });
});

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

  const oldSettings = () =>
    JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${hooksDir}/neuromcp-context-inject.js"` }] }],
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: `node "${hooksDir}/neuromcp-auto-capture.js"` }] },
          { matcher: '*', hooks: [{ type: 'command', command: `node "${hooksDir}/my-neuromcp-auto-capture.js"` }] },
        ],
      },
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

  it('migrates a MODIFIED .js hook without losing the user\'s edits, and keeps a shim at the old path', () => {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'neuromcp-auto-capture.js'), '// my own capture hook\n');
    writeFileSync(settingsPath, oldSettings());

    const r = runInit(home);
    expect(r.status).toBe(0);
    // The user's content moved to .cjs unchanged …
    expect(readFileSync(join(hooksDir, 'neuromcp-auto-capture.cjs'), 'utf8')).toBe('// my own capture hook\n');
    expect(r.stdout).toMatch(/neuromcp-auto-capture\.cjs differs from the shipped version/);
    // … the old path still works for other references (shim) …
    expect(readFileSync(join(hooksDir, 'neuromcp-auto-capture.js'), 'utf8')).toMatch(/neuromcp-auto-capture\.cjs/);
    // … and the original is backed up.
    expect(readdirSync(hooksDir).some((f) => f.startsWith('neuromcp-auto-capture.js.bak-pre-cjs-'))).toBe(true);

    const settings = readFileSync(settingsPath, 'utf8');
    expect(settings).toContain(`${hooksDir}/neuromcp-auto-capture.cjs`);
    expect(settings).toContain(`${hooksDir}/neuromcp-context-inject.cjs`);
    // A custom command whose name merely CONTAINS the hook name is untouched.
    expect(settings).toContain('my-neuromcp-auto-capture.js');
    expect(settings.match(/\/neuromcp-auto-capture\.cjs/g)?.length).toBe(1);
    // settings.json was backed up before the rewrite.
    expect(readdirSync(join(home, '.claude')).some((f) => f.startsWith('settings.json.bak-neuromcp-'))).toBe(true);
  });

  it('updates an UNMODIFIED older shipped hook automatically (with a backup)', () => {
    mkdirSync(hooksDir, { recursive: true });
    copyFileSync(join(FIXTURES, 'neuromcp-auto-capture-0.29.5.js'), join(hooksDir, 'neuromcp-auto-capture.js'));
    copyFileSync(join(FIXTURES, 'neuromcp-persist-0.29.5.cjs'), join(hooksDir, 'neuromcp-persist.cjs'));
    writeFileSync(settingsPath, oldSettings());

    const r = runInit(home);
    expect(r.status).toBe(0);
    for (const hook of ['neuromcp-auto-capture.cjs', 'neuromcp-persist.cjs']) {
      expect(readFileSync(join(hooksDir, hook), 'utf8'), hook).toBe(readFileSync(join(TEMPLATES, hook), 'utf8'));
    }
    expect(r.stdout).not.toMatch(/differs from the shipped version/);
    expect(readdirSync(hooksDir).some((f) => f.startsWith('neuromcp-persist.cjs.bak-'))).toBe(true);
  });

  it('the .js shim runs the .cjs hook, also under an ESM parent package.json', () => {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'neuromcp-auto-capture.js'), "process.stdout.write('ran-from-cjs');\n");
    writeFileSync(settingsPath, oldSettings());
    expect(runInit(home).status).toBe(0);

    writeFileSync(join(home, '.claude', 'package.json'), JSON.stringify({ type: 'module' }));
    const shim = spawnSync('node', [join(hooksDir, 'neuromcp-auto-capture.js')], { encoding: 'utf8', input: '' });
    expect(shim.status).toBe(0);
    expect(shim.stdout).toBe('ran-from-cjs');
  });

  it('moves nothing when settings.json cannot be parsed', () => {
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'neuromcp-auto-capture.js'), '// old\n');
    writeFileSync(settingsPath, '{ "hooks": { broken');

    const r = runInit(home);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/settings\.json/);
    expect(readFileSync(join(hooksDir, 'neuromcp-auto-capture.js'), 'utf8')).toBe('// old\n');
    expect(existsSync(join(hooksDir, 'neuromcp-auto-capture.cjs'))).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ "hooks": { broken');
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
  });
});
