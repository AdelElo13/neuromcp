import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NEUROMCP_VERSION } from '../../src/version.js';

describe('version', () => {
  it('matches package.json version', () => {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    expect(NEUROMCP_VERSION).toBe(pkg.version);
  });

  it('follows semver format', () => {
    expect(NEUROMCP_VERSION).toMatch(/^\d+\.\d+\.\d+(-.+)?$/);
  });

  it('is not "unknown"', () => {
    expect(NEUROMCP_VERSION).not.toBe('unknown');
  });
});
