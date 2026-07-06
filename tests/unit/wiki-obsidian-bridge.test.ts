import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// The bridge is an ESM script that also exports pure helpers for testing.
import { transformContent, runBridge, sanitizeRelatedValue } from '../../scripts/wiki-obsidian-bridge.mjs';

/**
 * Obsidian bridge (v0.29 Fase 2). Converts `related: [...]` frontmatter into a
 * `## Related` section of [[wikilinks]]. Idempotent, frontmatter byte-exact,
 * sanitized against [[/]]/newline injection, CRLF-safe. Tests only touch
 * temp-dirs — never the real wiki.
 */

describe('transformContent', () => {
  it('adds a ## Related section with wikilinks from related frontmatter', () => {
    const input = [
      '---',
      'title: X',
      'related: [alpha, beta]',
      '---',
      '',
      '# X',
      '',
      'Body text.',
      '',
    ].join('\n');
    const out = transformContent(input);
    expect(out.changed).toBe(true);
    expect(out.content).toContain('## Related');
    expect(out.content).toContain('[[alpha]]');
    expect(out.content).toContain('[[beta]]');
    // Frontmatter preserved byte-exact.
    expect(out.content.startsWith('---\ntitle: X\nrelated: [alpha, beta]\n---\n')).toBe(true);
  });

  it('is idempotent — running twice does not duplicate the Related section', () => {
    const input = '---\nrelated: [a, b]\n---\n\n# Doc\n\nText.\n';
    const first = transformContent(input);
    const second = transformContent(first.content);
    expect(second.changed).toBe(false);
    // Only one ## Related occurrence.
    const count = (second.content.match(/## Related/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('sanitizes related values against ]] / [[ injection in frontmatter', () => {
    const input = '---\nrelated: ["evil]] injected", "[[nested"]\n---\n\nbody\n';
    const out = transformContent(input);
    // The generated ## Related block must not carry the raw brackets. (The
    // frontmatter is preserved byte-exact, so it still contains the original
    // value — check only the managed block below the closing fence.)
    const managed = out.content.slice(out.content.indexOf('## Related'));
    expect(managed).not.toContain('evil]] injected');
    expect(managed).toContain('[[evil injected]]');
    expect(managed).toContain('[[nested]]');
  });

  it('sanitizeRelatedValue collapses newlines and strips wikilink brackets', () => {
    expect(sanitizeRelatedValue('a]]b')).toBe('ab');
    expect(sanitizeRelatedValue('[[a')).toBe('a');
    expect(sanitizeRelatedValue('line\nbreak')).toBe('line break');
    expect(sanitizeRelatedValue('  trim  me  ')).toBe('trim me');
  });

  it('no-ops when there is no related frontmatter', () => {
    const input = '---\ntitle: Y\n---\n\n# Y\n\nbody\n';
    const out = transformContent(input);
    expect(out.changed).toBe(false);
    expect(out.content).toBe(input);
  });

  it('handles CRLF line endings and preserves the trailing newline', () => {
    const input = '---\r\nrelated: [a]\r\n---\r\n\r\n# Doc\r\n\r\nText.\r\n';
    const out = transformContent(input);
    expect(out.changed).toBe(true);
    expect(out.content).toContain('[[a]]');
    // Trailing newline preserved.
    expect(out.content.endsWith('\n')).toBe(true);
  });

  it('updates the Related section when related changes', () => {
    const first = transformContent('---\nrelated: [a]\n---\n\nbody\n').content;
    const updated = transformContent(first.replace('related: [a]', 'related: [a, c]'));
    expect(updated.changed).toBe(true);
    expect(updated.content).toContain('[[a]]');
    expect(updated.content).toContain('[[c]]');
    expect((updated.content.match(/## Related/g) ?? []).length).toBe(1);
  });
});

describe('runBridge (temp-dir only)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'obsidian-bridge-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites files with related frontmatter and reports counts', () => {
    writeFileSync(join(dir, 'a.md'), '---\nrelated: [x, y]\n---\n\n# A\n\nbody\n');
    writeFileSync(join(dir, 'b.md'), '---\ntitle: B\n---\n\n# B\n\nbody\n');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'c.md'), '---\nrelated: [z]\n---\n\n# C\n\nbody\n');

    const result = runBridge(dir, { dryRun: false });
    expect(result.changed).toBe(2); // a.md and sub/c.md
    expect(result.scanned).toBe(3);

    const a = readFileSync(join(dir, 'a.md'), 'utf8');
    expect(a).toContain('[[x]]');
    expect(a).toContain('[[y]]');
  });

  it('dry-run does not modify files', () => {
    const file = join(dir, 'a.md');
    const original = '---\nrelated: [x]\n---\n\n# A\n\nbody\n';
    writeFileSync(file, original);

    const result = runBridge(dir, { dryRun: true });
    expect(result.changed).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(original); // unchanged on disk
  });

  it('re-running on already-bridged files is a no-op (idempotent on disk)', () => {
    const file = join(dir, 'a.md');
    writeFileSync(file, '---\nrelated: [x, y]\n---\n\n# A\n\nbody\n');
    runBridge(dir, { dryRun: false });
    const afterFirst = readFileSync(file, 'utf8');
    const result = runBridge(dir, { dryRun: false });
    expect(result.changed).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(afterFirst);
  });
});
