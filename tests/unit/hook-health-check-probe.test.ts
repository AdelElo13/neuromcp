import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * neuromcp-health-check's `claude -p` auth probe.
 *
 * It used to run `claude -p --tools ''` synchronously on EVERY SessionStart
 * with a 5 s timeout:
 *  - the current CLI rejects an empty --tools value, so the probe could not
 *    succeed;
 *  - the nested CLI ran the user's hooks again — including this SessionStart
 *    hook, which spawned another probe;
 *  - a cold `claude -p` takes longer than 5 s, so most sessions started with
 *    a false "no response in 5s" warning and a 5 s delay.
 *
 * Now: the hook never runs inside its own probe, the probe is isolated (no
 * hooks/CLAUDE.md/skills/MCP, user settings kept) and runs in the BACKGROUND
 * at most every 6 h; SessionStart only reports the cached result.
 */
const HOOK = path.join(__dirname, '..', '..', 'templates', 'hooks', 'neuromcp-health-check.cjs');

describe('neuromcp-health-check claude -p probe', () => {
  let home: string;
  let bin: string;
  let marker: string;
  let cache: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nmcp-health-'));
    bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    marker = path.join(home, 'claude-argv.txt');
    cache = path.join(home, '.neuromcp', 'health-probe.json');
    fs.mkdirSync(path.join(home, '.neuromcp'), { recursive: true });
    // Fake `claude`: records its argv and child-guard env, answers "ok".
    fs.writeFileSync(
      path.join(bin, 'claude'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${marker}"\nprintf 'child=%s\\n' "$NEUROMCP_HEALTH_CHECK_CHILD" >> "${marker}"\necho ok\n`,
    );
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const run = (extraEnv: Record<string, string> = {}) =>
    spawnSync('node', [HOOK], {
      input: '{"hook_event_name":"SessionStart"}',
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ...extraEnv },
      encoding: 'utf8',
      timeout: 15000,
    });

  const waitFor = async (cond: () => boolean, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !cond()) await new Promise((r) => setTimeout(r, 100));
    return cond();
  };

  it('does nothing when it runs inside its own probe (no recursion)', () => {
    const r = run({ NEUROMCP_HEALTH_CHECK_CHILD: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('does not block SessionStart: the probe runs in the background, isolated, and is cached', async () => {
    const started = Date.now();
    const r = run();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.stdout).not.toMatch(/no response in 5s/);

    expect(await waitFor(() => fs.existsSync(cache) && JSON.parse(fs.readFileSync(cache, 'utf8')).status !== 'probing')).toBe(true);
    const argv = fs.readFileSync(marker, 'utf8');
    expect(argv).toMatch(/--setting-sources user/);
    expect(argv).toMatch(/--strict-mcp-config/);
    expect(argv).toMatch(/--disable-slash-commands/);
    expect(argv).toMatch(/disableAllHooks/);
    expect(argv).not.toMatch(/--tools/);
    expect(argv).toMatch(/child=1/);
    expect(JSON.parse(fs.readFileSync(cache, 'utf8')).status).toBe('ok');
  });

  it('reports a cached auth failure without probing again', () => {
    fs.writeFileSync(cache, JSON.stringify({ status: 'auth-broken', checkedAt: new Date().toISOString(), detail: 'Not logged in · Please run /login' }));
    const r = run();
    expect(r.stdout).toMatch(/claude -p subprocess auth broken/);
    expect(r.stdout).toMatch(/Not logged in/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a fresh ok result is reused (at most one probe per 6 h)', () => {
    fs.writeFileSync(cache, JSON.stringify({ status: 'ok', checkedAt: new Date().toISOString() }));
    const r = run();
    expect(r.stdout).not.toMatch(/auth broken|no response/);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
