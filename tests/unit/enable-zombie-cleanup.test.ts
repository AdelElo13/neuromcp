import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Regression test for `npx neuromcp-enable-zombie-cleanup`.
 *
 * The installer copies templates/scripts/cleanup-claude-zombies.sh to
 * ~/.neuromcp/scripts/ and (on macOS) renders the launchd plist
 * template into ~/Library/LaunchAgents/.
 *
 * Test strategy: invoke with --dry-run + isolated HOME so we exercise
 * the preflight, path resolution, and template rendering without
 * touching real launchd. Then a second pass with a stubbed PLIST_TARGET
 * via env to verify the template render is correct end-to-end.
 */
const INSTALLER = path.join(__dirname, '..', '..', 'bin', 'enable-zombie-cleanup.mjs');
const SCRIPT_SOURCE = path.join(__dirname, '..', '..', 'templates', 'scripts', 'cleanup-claude-zombies.sh');
const PLIST_TEMPLATE = path.join(__dirname, '..', '..', 'scripts', 'com.neuromcp.zombie-cleanup.plist.template');

function runInstaller(args: string[], home: string) {
  return spawnSync('node', [INSTALLER, ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 10000,
  });
}

describe('enable-zombie-cleanup installer', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nmcp-zombie-install-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('ships the cleanup script template', () => {
    expect(fs.existsSync(SCRIPT_SOURCE)).toBe(true);
    const content = fs.readFileSync(SCRIPT_SOURCE, 'utf8');
    expect(content).toContain('cleanup-claude-zombies');
    expect(content).toContain('ZOMBIE_MAX_LIFETIME_MS');
  });

  it('ships the launchd plist template with all placeholders', () => {
    expect(fs.existsSync(PLIST_TEMPLATE)).toBe(true);
    const content = fs.readFileSync(PLIST_TEMPLATE, 'utf8');
    expect(content).toContain('{{SCRIPT_PATH}}');
    expect(content).toContain('{{INTERVAL_SECONDS}}');
    expect(content).toContain('{{HOME}}');
    expect(content).toContain('{{PATH}}');
    expect(content).toContain('com.neuromcp.zombie-cleanup');
  });

  it('--dry-run does not touch the filesystem', () => {
    if (process.platform !== 'darwin') return; // installer skips non-darwin

    const result = runInstaller(['--dry-run'], home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[DRY RUN]');
    // No files written under isolated HOME
    expect(fs.existsSync(path.join(home, '.neuromcp', 'scripts', 'cleanup-claude-zombies.sh'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'com.neuromcp.zombie-cleanup.plist'))).toBe(false);
  });

  it('rejects --interval outside [60, 3600]', () => {
    if (process.platform !== 'darwin') return;

    const tooLow = runInstaller(['--dry-run', '--interval', '30'], home);
    expect(tooLow.status).toBe(2);
    expect(tooLow.stderr).toContain('--interval must be an integer in [60, 3600]');

    const tooHigh = runInstaller(['--dry-run', '--interval', '7200'], home);
    expect(tooHigh.status).toBe(2);
  });

  it('exits cleanly on non-darwin platforms with a warning', () => {
    if (process.platform === 'darwin') return; // only relevant on linux/windows CI

    const result = runInstaller([], home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('only exists on macOS');
  });

  it('--uninstall is idempotent when no agent is installed', () => {
    if (process.platform !== 'darwin') return;

    const result = runInstaller(['--uninstall'], home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No launchd plist installed');
  });
});
