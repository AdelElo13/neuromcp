import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain-ESM helper in bin/, no type declarations shipped
import { seedObsidianVault } from '../../bin/obsidian-vault.mjs';

/**
 * The hard safety rule (Adel): if a user has ALREADY set up ~/.neuromcp/wiki
 * as an Obsidian vault, our init must NEVER overwrite their .obsidian
 * settings. These tests lock that in.
 */
describe('seedObsidianVault', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nmcp-obs-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('creates a minimal .obsidian config in a fresh wiki', () => {
    const r = seedObsidianVault(dir);
    expect(r).toBe('created');
    expect(existsSync(join(dir, '.obsidian', 'app.json'))).toBe(true);
    const plugins = JSON.parse(readFileSync(join(dir, '.obsidian', 'core-plugins.json'), 'utf8'));
    expect(plugins).toContain('graph');
    // Graph colour groups so the Obsidian graph is coloured by category
    // out-of-the-box (Obsidian's default graph is monochrome).
    const graph = JSON.parse(readFileSync(join(dir, '.obsidian', 'graph.json'), 'utf8'));
    expect(Array.isArray(graph.colorGroups)).toBe(true);
    expect(graph.colorGroups.length).toBeGreaterThanOrEqual(6);
    expect(graph.colorGroups.map((g: { query: string }) => g.query)).toContain('path:projects/');
  });

  it('NEVER overwrites an existing .obsidian setup (returns skipped, files byte-identical)', () => {
    // Simulate a user who already opened the wiki as a vault with custom settings.
    const obs = join(dir, '.obsidian');
    mkdirSync(obs, { recursive: true });
    const customApp = '{"theme":"obsidian","cssTheme":"Minimal","MY_CUSTOM":true}';
    const customPlugins = '["graph","canvas","daily-notes","my-plugin"]';
    const customExtra = '{"accentColor":"#ff0000"}';
    writeFileSync(join(obs, 'app.json'), customApp);
    writeFileSync(join(obs, 'core-plugins.json'), customPlugins);
    writeFileSync(join(obs, 'appearance.json'), customExtra);

    const r = seedObsidianVault(dir);

    expect(r).toBe('skipped');
    // Every existing file is untouched, byte for byte.
    expect(readFileSync(join(obs, 'app.json'), 'utf8')).toBe(customApp);
    expect(readFileSync(join(obs, 'core-plugins.json'), 'utf8')).toBe(customPlugins);
    expect(readFileSync(join(obs, 'appearance.json'), 'utf8')).toBe(customExtra);
  });

  it('is idempotent — a second run after creating does not rewrite', () => {
    expect(seedObsidianVault(dir)).toBe('created');
    const before = readFileSync(join(dir, '.obsidian', 'app.json'), 'utf8');
    expect(seedObsidianVault(dir)).toBe('skipped');
    expect(readFileSync(join(dir, '.obsidian', 'app.json'), 'utf8')).toBe(before);
  });

  it('only writes inside <wikiDir>/.obsidian — never elsewhere', () => {
    seedObsidianVault(dir);
    // The only thing created under dir is the .obsidian folder.
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    expect(readdirSync(dir)).toEqual(['.obsidian']);
  });
});
