import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { wikiIngest } from '../../src/tools/wiki.js';
import type { NeuromcpConfig } from '../../src/config.js';
import type { Logger } from '../../src/observability/logger.js';

/**
 * Regression: CWE-22 path traversal in wiki_ingest (CRITICAL).
 *
 * `wikiIngest` joined the raw `filename` tool input straight onto
 * `<wikiDir>/raw-sources` with `path.join`, which normalises `../`
 * sequences right out of the base directory:
 *
 *   join('/x/wiki/raw-sources', '../../../../etc/passwd') → '/etc/passwd'
 *
 * Because the full file content is returned in `IngestResult.content`,
 * any MCP client (or a prompt-injected LLM driving one) could read
 * arbitrary files on the host — SSH keys, .env files, credentials —
 * through a single tool call. The fix rejects any filename that is not a
 * plain basename inside raw-sources/, BEFORE touching the filesystem.
 */

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

describe('wiki_ingest path traversal (CWE-22)', () => {
  let baseDir: string;
  let wikiDir: string;
  let deps: { config: NeuromcpConfig; logger: Logger };

  beforeAll(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'neuromcp-wiki-sec-'));
    wikiDir = join(baseDir, 'wiki');
    mkdirSync(join(wikiDir, 'raw-sources'), { recursive: true });
    // A legitimate raw source inside the sandbox…
    writeFileSync(join(wikiDir, 'raw-sources', 'note.md'), '# Note\n\nlegit content\n');
    // …and a "secret" OUTSIDE raw-sources that must never be readable.
    writeFileSync(join(baseDir, 'secret.txt'), 'TOP-SECRET-DO-NOT-LEAK');
    deps = { config: { wikiDir } as NeuromcpConfig, logger: noopLogger };
  });

  afterAll(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('reads a plain filename inside raw-sources/ (happy path)', () => {
    const result = wikiIngest({ filename: 'note.md' }, deps);
    expect(result.content).toContain('legit content');
  });

  it('rejects a ../ traversal to an existing file outside raw-sources/', () => {
    // NOTE: ../secret.txt EXISTS — the rejection must come from filename
    // validation, not from a file-not-found fallthrough.
    expect(() => wikiIngest({ filename: '../secret.txt' }, deps)).toThrow(/invalid filename/i);
  });

  it('rejects a deep ../ chain reaching for system files', () => {
    expect(() =>
      wikiIngest({ filename: '../../../../../../../../etc/passwd' }, deps),
    ).toThrow(/invalid filename/i);
  });

  it('rejects an embedded traversal (dir/../../escape)', () => {
    expect(() => wikiIngest({ filename: 'foo/../../secret.txt' }, deps)).toThrow(/invalid filename/i);
  });

  it('rejects an absolute path', () => {
    expect(() => wikiIngest({ filename: '/etc/hosts' }, deps)).toThrow(/invalid filename/i);
  });

  it('rejects a Windows-style backslash traversal', () => {
    expect(() => wikiIngest({ filename: '..\\secret.txt' }, deps)).toThrow(/invalid filename/i);
  });

  it('rejects an empty filename', () => {
    expect(() => wikiIngest({ filename: '' }, deps)).toThrow(/invalid filename/i);
  });

  it('still reports file-not-found for a clean but missing basename', () => {
    expect(() => wikiIngest({ filename: 'does-not-exist.md' }, deps)).toThrow(/not found/i);
  });
});
