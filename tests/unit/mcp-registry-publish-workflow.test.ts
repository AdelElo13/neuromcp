import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Supply-chain hardening guard for .github/workflows/mcp-registry-publish.yml.
 *
 * That job holds `id-token: write` — the OIDC credential that authorizes
 * publishing under the io.github.AdelElo13/* registry namespace. Any binary
 * it executes must therefore be pinned to an explicit release tag and
 * checksum-verified before it runs. "curl latest | tar" would execute
 * whatever the upstream release endpoint serves on that day.
 */

const workflowPath = fileURLToPath(
  new URL('../../.github/workflows/mcp-registry-publish.yml', import.meta.url),
);
const workflow = readFileSync(workflowPath, 'utf8');

describe('mcp-registry-publish workflow — mcp-publisher install hardening', () => {
  it('never downloads from the mutable releases/latest URL', () => {
    expect(workflow).not.toMatch(/releases\/latest\/download/);
  });

  it('pins an explicit mcp-publisher release tag in an env var', () => {
    expect(workflow).toMatch(/MCP_PUBLISHER_VERSION:\s*v\d+\.\d+\.\d+/);
  });

  it('never pipes curl straight into tar', () => {
    expect(workflow).not.toMatch(/curl[^\n]*\|\s*tar/);
  });

  it('verifies the tarball sha256 against the release checksums file BEFORE extracting', () => {
    const install = workflow.slice(workflow.indexOf('Install mcp-publisher'));
    expect(install).toMatch(/checksums\.txt/);
    expect(install).toMatch(/sha256sum\s+(--check|-c)/);
    const verifyAt = install.indexOf('sha256sum');
    const extractAt = install.indexOf('tar ');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(extractAt).toBeGreaterThan(verifyAt);
  });
});

describe('mcp-registry-publish workflow — npm propagation race', () => {
  // v0.29.0 release: the release-triggered run failed because it checked
  // `npm view` once, before npm registry propagation caught up with the
  // just-completed publish. The verify step must poll/retry so the
  // automatic run self-heals instead of needing a manual re-dispatch.
  it('polls npm for the version instead of checking exactly once', () => {
    const verify = workflow.slice(workflow.indexOf('Verify the npm package version'));
    // A retry loop: some for/while iterating with a sleep between attempts.
    expect(verify).toMatch(/for\s+\w+\s+in|while\s+/);
    expect(verify).toMatch(/sleep\s+/);
  });
});
