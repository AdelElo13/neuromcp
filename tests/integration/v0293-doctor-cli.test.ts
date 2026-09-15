/**
 * v0.29.3 — `neuromcp-doctor` must always print a report.
 *
 * Bug as reported: on the owner's work Mac `neuromcp-doctor` printed NOTHING
 * and exited 0 in a non-interactive shell. Root cause found in the code (and
 * reproduced against a real `npm install -g neuromcp@0.29.2` on npm 11.12.1):
 * the direct-invocation guard compared `import.meta.url` with
 * `pathToFileURL(process.argv[1])`. npm exposes every bin as a SYMLINK, Node
 * resolves `import.meta.url` through realpath but leaves argv[1] as the
 * symlink — so main() never ran. Nothing to do with TTY detection.
 *
 * These tests run the CLI the way a user does: through a symlink, with
 * stdout piped (never a TTY), and additionally assert `--json` parses.
 *
 * `spawn` is used with an argument array and no shell.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isMainModule } from '../../bin/is-main.mjs';

const DOCTOR = resolve(process.cwd(), 'bin', 'doctor.mjs');

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(script: string, args: string[]): Promise<Run> {
  return new Promise((resolveRun, rejectRun) => {
    // stdio 'pipe' everywhere: stdout is NOT a TTY here, which is exactly
    // the environment where 0.29.2 printed nothing.
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

describe('v0.29.3 neuromcp-doctor CLI', () => {
  let dir: string;
  let linked: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'neuromcp-doctor-cli-'));
    // Mimic what `npm install -g` creates: <prefix>/bin/neuromcp-doctor is a
    // symlink into <prefix>/lib/node_modules/neuromcp/bin/doctor.mjs.
    linked = join(dir, 'neuromcp-doctor');
    symlinkSync(DOCTOR, linked);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints a non-empty report when stdout is a pipe (not a TTY)', async () => {
    const res = await run(DOCTOR, ['check']);
    expect(res.stdout.length).toBeGreaterThan(0);
    expect(res.stdout).toMatch(/node version/);
    expect(res.stdout).toMatch(/embedding route/);
    expect([0, 1, 2]).toContain(res.code);
  }, 30_000);

  it('prints the same report when invoked through a symlink (the global-install shape)', async () => {
    const res = await run(linked, ['check']);
    expect(res.stdout.length).toBeGreaterThan(0);
    expect(res.stdout).toMatch(/node version/);
  }, 30_000);

  it('--json emits parseable JSON with every check', async () => {
    const res = await run(DOCTOR, ['check', '--json']);
    const parsed = JSON.parse(res.stdout) as {
      version: string;
      exit_code: number;
      checks: Array<{ name: string; status: string; info: string }>;
    };
    expect(typeof parsed.version).toBe('string');
    expect([0, 1, 2]).toContain(parsed.exit_code);
    expect(parsed.checks.length).toBeGreaterThan(5);
    expect(parsed.checks.map((c) => c.name)).toContain('embedding index');
    for (const c of parsed.checks) {
      expect(['ok', 'warn', 'fail', 'skip']).toContain(c.status);
    }
  }, 30_000);

  it('--help prints usage', async () => {
    const res = await run(DOCTOR, ['--help']);
    expect(res.stdout).toMatch(/Usage:/);
    expect(res.code).toBe(0);
  }, 30_000);

  it('isMainModule matches through a symlink (the actual root cause)', () => {
    // Direct path and symlink path must both count as "this is main".
    expect(isMainModule(new URL(`file://${DOCTOR}`).href, DOCTOR)).toBe(true);
    expect(isMainModule(new URL(`file://${DOCTOR}`).href, linked)).toBe(true);
    expect(isMainModule(new URL(`file://${DOCTOR}`).href, '/some/other/file.mjs')).toBe(false);
    expect(isMainModule(new URL(`file://${DOCTOR}`).href, undefined)).toBe(false);
  });
});
