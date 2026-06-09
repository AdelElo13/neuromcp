import { describe, it, expect } from 'vitest';

// @ts-expect-error — plain-ESM helper in bin/, no type declarations shipped
import { resolveStableNodeBin } from '../../bin/resolve-node-bin.mjs';

/**
 * Regression: the launchd daemon plist baked node's path from
 * process.execPath, which realpath-resolves to Homebrew's version-pinned
 * Cellar path (e.g. /opt/homebrew/Cellar/node@22/22.22.2_1/bin/node).
 * A `brew upgrade node@22` deletes that dir, so launchd can no longer
 * exec node → daemon dies with EX_CONFIG and never restarts.
 *
 * Fix: rewrite a *versioned* Homebrew Cellar path to the prefix's
 * version-independent opt symlink, which Homebrew re-points on every
 * upgrade while staying within the same Node major (so native-module ABI
 * is preserved). The unversioned `node` formula is deliberately left
 * alone — its opt symlink follows the latest major and could jump ABIs.
 */
const yes = () => true;
const only = (target: string) => (p: string) => p === target;

describe('resolveStableNodeBin', () => {
  it('rewrites a versioned Cellar path to the opt symlink (Apple Silicon)', () => {
    expect(
      resolveStableNodeBin('/opt/homebrew/Cellar/node@22/22.22.2_1/bin/node', {
        isExecutable: only('/opt/homebrew/opt/node@22/bin/node'),
      }),
    ).toBe('/opt/homebrew/opt/node@22/bin/node');
  });

  it('handles a different major (node@20)', () => {
    expect(
      resolveStableNodeBin('/opt/homebrew/Cellar/node@20/20.11.0/bin/node', {
        isExecutable: only('/opt/homebrew/opt/node@20/bin/node'),
      }),
    ).toBe('/opt/homebrew/opt/node@20/bin/node');
  });

  it('handles the Intel prefix for a versioned formula', () => {
    expect(
      resolveStableNodeBin('/usr/local/Cellar/node@22/22.3.0/bin/node', {
        isExecutable: only('/usr/local/opt/node@22/bin/node'),
      }),
    ).toBe('/usr/local/opt/node@22/bin/node');
  });

  it('is prefix-agnostic — handles a custom Homebrew prefix', () => {
    expect(
      resolveStableNodeBin('/Users/me/homebrew/Cellar/node@22/22.3.0/bin/node', {
        isExecutable: only('/Users/me/homebrew/opt/node@22/bin/node'),
      }),
    ).toBe('/Users/me/homebrew/opt/node@22/bin/node');
  });

  it('leaves the UNVERSIONED node formula unchanged (opt/node could jump majors → native-ABI risk)', () => {
    const execPath = '/opt/homebrew/Cellar/node/24.3.0/bin/node';
    expect(resolveStableNodeBin(execPath, { isExecutable: yes })).toBe(execPath);
  });

  it('leaves a non-Cellar node path unchanged (nvm, system, asdf, …)', () => {
    const execPath = '/Users/a/.nvm/versions/node/v22.3.0/bin/node';
    expect(resolveStableNodeBin(execPath, { isExecutable: yes })).toBe(execPath);
  });

  it('does not match trailing segments after /bin/node', () => {
    const execPath = '/opt/homebrew/Cellar/node@22/22.3.0/bin/node/oops';
    expect(resolveStableNodeBin(execPath, { isExecutable: yes })).toBe(execPath);
  });

  it('keeps the original path when the opt target is absent or not executable', () => {
    const execPath = '/opt/homebrew/Cellar/node@22/22.22.2_1/bin/node';
    expect(resolveStableNodeBin(execPath, { isExecutable: () => false })).toBe(execPath);
  });
});
