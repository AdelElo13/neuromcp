import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guards for .github/workflows/npm-publish.yml — Trusted Publishing (OIDC).
 *
 * The whole point is to remove stored npm tokens. These lock in that the
 * workflow (a) grants the OIDC id-token permission and (b) never falls back
 * to a token secret, so a future edit can't silently reintroduce the
 * token dance this replaced.
 */
const workflow = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/npm-publish.yml', import.meta.url)),
  'utf8',
);

describe('npm-publish workflow — Trusted Publishing (OIDC)', () => {
  it('grants id-token: write (required for OIDC)', () => {
    expect(workflow).toMatch(/id-token:\s*write/);
  });

  it('never references a stored npm token', () => {
    expect(workflow).not.toMatch(/NODE_AUTH_TOKEN/);
    expect(workflow).not.toMatch(/NPM_TOKEN/);
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/_authToken/);
  });

  it('does not configure registry-url on setup-node (it injects a placeholder NODE_AUTH_TOKEN that preempts OIDC)', () => {
    // Root cause of the v0.29.2 publish failure: setup-node with
    // `registry-url` writes an .npmrc with `_authToken=${NODE_AUTH_TOKEN}`
    // and exports the literal placeholder XXXXX-XXXXX-XXXXX-XXXXX for that
    // var. npm then authenticates with the bogus token and never attempts
    // Trusted Publishing — the registry answers E404 on PUT. For OIDC the
    // job must have NO npm auth config at all.
    expect(workflow).not.toMatch(/registry-url/);
  });

  it('publishes on a GitHub release', () => {
    expect(workflow).toMatch(/release:\s*\n\s*types:\s*\[published\]/);
  });

  it('upgrades npm to a version that supports OIDC publishing (>=11.5.1)', () => {
    // node@22 ships an older npm; OIDC landed in 11.5.1.
    expect(workflow).toMatch(/npm install -g npm@\^?11/);
  });
});
