import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// @ts-expect-error — plain-ESM helper in bin/, no type declarations shipped
import {
  parseInitArgs,
  getClientConfigPath,
  detectClients,
  resolveTargets,
  mergeNeuromcpEntry,
  buildBackupPath,
  configureClient,
  checkOllama,
  NEUROMCP_SERVER_ENTRY,
} from '../../bin/init.mjs';

/**
 * `neuromcp init` — one-command setup replacing the five manual steps:
 * client config wiring (Claude Desktop / Claude Code / Cursor / Windsurf),
 * wiki init, and Ollama advice. These tests exercise the pure helpers with
 * injected fs/fetch boundaries against temp dirs — NEVER the real home
 * configs.
 */

const ENTRY = { command: 'npx', args: ['-y', 'neuromcp'] };

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neuromcp-init-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── parseInitArgs ─────────────────────────────────────────────────────

describe('parseInitArgs', () => {
  it('defaults to auto-detect, no dry-run, no yes', () => {
    expect(parseInitArgs([])).toEqual({ client: null, dryRun: false, yes: false });
  });

  it('parses --client, --dry-run and --yes together', () => {
    expect(parseInitArgs(['--client', 'claude-desktop', '--dry-run', '--yes'])).toEqual({
      client: 'claude-desktop',
      dryRun: true,
      yes: true,
    });
  });

  it('rejects an unknown client name', () => {
    expect(() => parseInitArgs(['--client', 'vscode'])).toThrow(/client/i);
  });

  it('rejects --client without a value', () => {
    expect(() => parseInitArgs(['--client'])).toThrow(/client/i);
  });

  it('rejects unknown flags', () => {
    expect(() => parseInitArgs(['--frobnicate'])).toThrow(/unknown/i);
  });
});

// ─── getClientConfigPath ───────────────────────────────────────────────

describe('getClientConfigPath', () => {
  it('resolves the Claude Desktop path on macOS', () => {
    expect(getClientConfigPath('claude-desktop', { home: '/Users/x', plat: 'darwin', env: {} }))
      .toBe('/Users/x/Library/Application Support/Claude/claude_desktop_config.json');
  });

  it('resolves the Claude Desktop path on Linux', () => {
    expect(getClientConfigPath('claude-desktop', { home: '/home/x', plat: 'linux', env: {} }))
      .toBe('/home/x/.config/Claude/claude_desktop_config.json');
  });

  it('resolves the Claude Desktop path on Windows via APPDATA', () => {
    expect(
      getClientConfigPath('claude-desktop', {
        home: 'C:\\Users\\x',
        plat: 'win32',
        env: { APPDATA: join('C:', 'Users', 'x', 'AppData', 'Roaming') },
      }),
    ).toBe(join('C:', 'Users', 'x', 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'));
  });

  it('resolves Claude Code, Cursor and Windsurf paths under home', () => {
    const ctx = { home: '/Users/x', plat: 'darwin', env: {} };
    expect(getClientConfigPath('claude-code', ctx)).toBe('/Users/x/.claude.json');
    expect(getClientConfigPath('cursor', ctx)).toBe('/Users/x/.cursor/mcp.json');
    expect(getClientConfigPath('windsurf', ctx)).toBe('/Users/x/.codeium/windsurf/mcp_config.json');
  });
});

// ─── detectClients ─────────────────────────────────────────────────────

describe('detectClients', () => {
  it('reports exists=true only for configs that are present on disk', () => {
    // Fake home with only Claude Code + Cursor configs present.
    writeFileSync(join(tmp, '.claude.json'), '{}');
    mkdirSync(join(tmp, '.cursor'), { recursive: true });
    writeFileSync(join(tmp, '.cursor', 'mcp.json'), '{}');

    const found = detectClients({ home: tmp, plat: 'darwin', env: {} }, { existsSync });
    const byId = Object.fromEntries(found.map((c: { id: string; exists: boolean }) => [c.id, c.exists]));
    expect(byId['claude-code']).toBe(true);
    expect(byId['cursor']).toBe(true);
    expect(byId['claude-desktop']).toBe(false);
    expect(byId['windsurf']).toBe(false);
  });
});

// ─── resolveTargets ────────────────────────────────────────────────────

describe('resolveTargets', () => {
  it('auto-detect targets only clients whose config exists', () => {
    writeFileSync(join(tmp, '.claude.json'), '{}');
    const targets = resolveTargets(null, { home: tmp, plat: 'darwin', env: {} }, { existsSync });
    expect(targets.map((t: { id: string }) => t.id)).toEqual(['claude-code']);
    expect(targets[0].createIfMissing).toBe(false);
  });

  it('an explicit --client targets that client even when its config is missing', () => {
    const targets = resolveTargets('windsurf', { home: tmp, plat: 'darwin', env: {} }, { existsSync });
    expect(targets.map((t: { id: string }) => t.id)).toEqual(['windsurf']);
    expect(targets[0].createIfMissing).toBe(true);
  });

  it('--client all targets every known client', () => {
    const targets = resolveTargets('all', { home: tmp, plat: 'darwin', env: {} }, { existsSync });
    expect(targets.map((t: { id: string }) => t.id).sort()).toEqual(
      ['claude-code', 'claude-desktop', 'cursor', 'windsurf'],
    );
    expect(targets.every((t: { createIfMissing: boolean }) => t.createIfMissing)).toBe(true);
  });
});

// ─── mergeNeuromcpEntry ────────────────────────────────────────────────

describe('mergeNeuromcpEntry', () => {
  it('adds the neuromcp entry when mcpServers is absent', () => {
    const res = mergeNeuromcpEntry('{}', ENTRY, { yes: false });
    expect(res.changed).toBe(true);
    expect(res.reason).toBe('added');
    expect(res.next.mcpServers.neuromcp).toEqual(ENTRY);
  });

  it('preserves other servers and unrelated top-level keys (claude-code shape)', () => {
    const existing = {
      numStartups: 42,
      projects: { '/Users/x/proj': { history: ['a', 'b'] } },
      mcpServers: {
        github: { command: 'gh-mcp', args: [] },
        exa: { command: 'npx', args: ['exa-mcp'] },
      },
    };
    const res = mergeNeuromcpEntry(JSON.stringify(existing), ENTRY, { yes: false });
    expect(res.changed).toBe(true);
    expect(res.next.mcpServers.github).toEqual(existing.mcpServers.github);
    expect(res.next.mcpServers.exa).toEqual(existing.mcpServers.exa);
    expect(res.next.mcpServers.neuromcp).toEqual(ENTRY);
    expect(res.next.numStartups).toBe(42);
    expect(res.next.projects).toEqual(existing.projects);
  });

  it('leaves an existing neuromcp entry alone without --yes', () => {
    const existing = { mcpServers: { neuromcp: { type: 'http', url: 'http://127.0.0.1:3200/mcp' } } };
    const res = mergeNeuromcpEntry(JSON.stringify(existing), ENTRY, { yes: false });
    expect(res.changed).toBe(false);
    expect(res.reason).toBe('already-configured');
  });

  it('overwrites an existing neuromcp entry with --yes', () => {
    const existing = { mcpServers: { neuromcp: { command: 'old' } } };
    const res = mergeNeuromcpEntry(JSON.stringify(existing), ENTRY, { yes: true });
    expect(res.changed).toBe(true);
    expect(res.reason).toBe('updated');
    expect(res.next.mcpServers.neuromcp).toEqual(ENTRY);
  });

  it('reports already-configured (unchanged) with --yes when the entry is identical', () => {
    const existing = { mcpServers: { neuromcp: ENTRY } };
    const res = mergeNeuromcpEntry(JSON.stringify(existing), ENTRY, { yes: true });
    expect(res.changed).toBe(false);
    expect(res.reason).toBe('already-configured');
  });

  it('throws a clear error on invalid JSON', () => {
    expect(() => mergeNeuromcpEntry('{ not json', ENTRY, { yes: false })).toThrow(/JSON/i);
  });

  it('throws a clear error when the config root is not an object', () => {
    expect(() => mergeNeuromcpEntry('[1,2,3]', ENTRY, { yes: false })).toThrow(/object/i);
  });
});

// ─── buildBackupPath ───────────────────────────────────────────────────

describe('buildBackupPath', () => {
  it('appends .bak-<ISO date> to the config path', () => {
    const p = buildBackupPath('/x/config.json', () => new Date('2026-07-02T10:00:00Z'));
    expect(p).toBe('/x/config.json.bak-2026-07-02');
  });
});

// ─── configureClient (real fs, temp dir) ───────────────────────────────

describe('configureClient', () => {
  it('merges the entry, creates a dated backup of the original first', () => {
    const configPath = join(tmp, 'claude_desktop_config.json');
    const original = JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2);
    writeFileSync(configPath, original);

    const res = configureClient(
      { id: 'claude-desktop', configPath, yes: false, dryRun: false, createIfMissing: false },
      { now: () => new Date('2026-07-02T10:00:00Z') },
    );

    expect(res.status).toBe('added');
    expect(res.backupPath).toBe(`${configPath}.bak-2026-07-02`);
    expect(readFileSync(res.backupPath, 'utf8')).toBe(original);
    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(written.mcpServers.other).toEqual({ command: 'x' });
    expect(written.mcpServers.neuromcp).toEqual(ENTRY);
  });

  it('does not write anything in --dry-run mode', () => {
    const configPath = join(tmp, 'mcp.json');
    const original = '{}';
    writeFileSync(configPath, original);

    const res = configureClient(
      { id: 'cursor', configPath, yes: false, dryRun: true, createIfMissing: false },
      {},
    );

    expect(res.status).toBe('would-add');
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    // No backup, no other file appeared.
    expect(readdirSync(tmp)).toEqual(['mcp.json']);
  });

  it('reports already-configured without touching the file', () => {
    const configPath = join(tmp, 'mcp.json');
    const original = JSON.stringify({ mcpServers: { neuromcp: { type: 'http', url: 'http://127.0.0.1:3200/mcp' } } });
    writeFileSync(configPath, original);

    const res = configureClient(
      { id: 'cursor', configPath, yes: false, dryRun: false, createIfMissing: false },
      {},
    );

    expect(res.status).toBe('already-configured');
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(readdirSync(tmp)).toEqual(['mcp.json']);
  });

  it('leaves a corrupt config file byte-identical and reports a clear error', () => {
    const configPath = join(tmp, 'mcp.json');
    const corrupt = '{ "mcpServers": { broken';
    writeFileSync(configPath, corrupt);

    const res = configureClient(
      { id: 'cursor', configPath, yes: true, dryRun: false, createIfMissing: false },
      {},
    );

    expect(res.status).toBe('invalid-json');
    expect(res.message).toMatch(/JSON/i);
    expect(readFileSync(configPath, 'utf8')).toBe(corrupt);
    expect(readdirSync(tmp)).toEqual(['mcp.json']);
  });

  it('creates a fresh config (and parent dirs) when missing and createIfMissing is set', () => {
    const configPath = join(tmp, '.codeium', 'windsurf', 'mcp_config.json');

    const res = configureClient(
      { id: 'windsurf', configPath, yes: false, dryRun: false, createIfMissing: true },
      {},
    );

    expect(res.status).toBe('created');
    expect(res.backupPath).toBeUndefined();
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ mcpServers: { neuromcp: ENTRY } });
  });

  it('skips a missing config when createIfMissing is not set', () => {
    const configPath = join(tmp, 'nope.json');
    const res = configureClient(
      { id: 'cursor', configPath, yes: false, dryRun: false, createIfMissing: false },
      {},
    );
    expect(res.status).toBe('skipped-missing');
    expect(existsSync(configPath)).toBe(false);
  });

  it('accepts injected fs operations (no disk writes)', () => {
    const files: Record<string, string> = { '/fake/cfg.json': '{}' };
    const fsDeps = {
      existsSync: (p: string) => p in files,
      readFileSync: (p: string) => files[p],
      writeFileSync: (p: string, data: string) => { files[p] = data; },
      copyFileSync: (src: string, dest: string) => { files[dest] = files[src]; },
      mkdirSync: () => undefined,
      now: () => new Date('2026-07-02T10:00:00Z'),
    };
    const res = configureClient(
      { id: 'cursor', configPath: '/fake/cfg.json', yes: false, dryRun: false, createIfMissing: false },
      fsDeps,
    );
    expect(res.status).toBe('added');
    expect(files['/fake/cfg.json.bak-2026-07-02']).toBe('{}');
    expect(JSON.parse(files['/fake/cfg.json']).mcpServers.neuromcp).toEqual(ENTRY);
  });
});

// ─── checkOllama ───────────────────────────────────────────────────────

describe('checkOllama', () => {
  it('reports reachable + model present', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'nomic-embed-text:latest' }, { name: 'llama3:8b' }] }),
    });
    await expect(checkOllama({ fetchImpl })).resolves.toEqual({ reachable: true, hasModel: true });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags', expect.anything());
  });

  it('reports reachable but model missing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3:8b' }] }),
    });
    await expect(checkOllama({ fetchImpl })).resolves.toEqual({ reachable: true, hasModel: false });
  });

  it('reports unreachable when fetch rejects (never throws)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(checkOllama({ fetchImpl })).resolves.toEqual({ reachable: false, hasModel: false });
  });
});

// ─── NEUROMCP_SERVER_ENTRY shape ───────────────────────────────────────

describe('NEUROMCP_SERVER_ENTRY', () => {
  it('is the npx stdio entry documented in the README', () => {
    expect(NEUROMCP_SERVER_ENTRY).toEqual({ command: 'npx', args: ['-y', 'neuromcp'] });
  });
});
