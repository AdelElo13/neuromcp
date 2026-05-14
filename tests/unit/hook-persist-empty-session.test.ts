import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Regression test for the "empty session raw-log leak".
 *
 * Background: the Stop variant of templates/hooks/neuromcp-persist.js used to
 * write a stub to ~/.neuromcp/raw/sessions/ on every invocation, including
 * sessions where the user never sent a message (claude spawned by the desktop
 * app, a launchd trigger, or a hook loop with no input). This polluted the
 * consolidation queue.
 *
 * Guard added 2026-05-14: skip the raw-log write when the transcript contains
 * zero user-role entries with non-empty content.
 */
const HOOK = path.join(__dirname, '..', '..', 'templates', 'hooks', 'neuromcp-persist.cjs');

function runHook(opts: { transcriptPath: string; home: string }): { stderr: string; stdout: string; status: number | null } {
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify({ transcript_path: opts.transcriptPath }),
    env: { ...process.env, CLAUDE_HOOK_EVENT: 'Stop', HOME: opts.home },
    encoding: 'utf8',
    timeout: 5000,
  });
  return { stderr: result.stderr ?? '', stdout: result.stdout ?? '', status: result.status };
}

describe('neuromcp-persist hook — empty session guard', () => {
  let home: string;
  let rawSessions: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nmcp-hook-'));
    rawSessions = path.join(home, '.neuromcp', 'raw', 'sessions');
    fs.mkdirSync(rawSessions, { recursive: true });
    fs.mkdirSync(path.join(home, '.neuromcp', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(home, '.neuromcp', 'wiki', 'log.md'), '');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('skips raw-log write when transcript has zero user messages', () => {
    const transcript = path.join(home, 'empty.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'summary', summary: 'test' }) + '\n');

    const before = fs.readdirSync(rawSessions).length;
    const { stderr } = runHook({ transcriptPath: transcript, home });
    const after = fs.readdirSync(rawSessions).length;

    expect(after - before).toBe(0);
    expect(stderr).toContain('Skipping empty session');
  });

  it('writes raw-log when transcript has at least one user message', () => {
    const transcript = path.join(home, 'real.jsonl');
    const entry = { type: 'user', message: { role: 'user', content: 'hallo wereld' } };
    fs.writeFileSync(transcript, JSON.stringify(entry) + '\n');

    const before = fs.readdirSync(rawSessions).length;
    runHook({ transcriptPath: transcript, home });
    const after = fs.readdirSync(rawSessions).length;

    expect(after - before).toBe(1);
  });

  it('treats missing transcript_path as empty (no write)', () => {
    const before = fs.readdirSync(rawSessions).length;
    const { stderr } = runHook({ transcriptPath: '/nonexistent/path.jsonl', home });
    const after = fs.readdirSync(rawSessions).length;

    expect(after - before).toBe(0);
    expect(stderr).toContain('Skipping empty session');
  });

  it('ignores user entries with empty/whitespace content', () => {
    const transcript = path.join(home, 'whitespace.jsonl');
    const entries = [
      { type: 'user', message: { role: 'user', content: '   ' } },
      { type: 'user', message: { role: 'user', content: '' } },
    ];
    fs.writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const before = fs.readdirSync(rawSessions).length;
    runHook({ transcriptPath: transcript, home });
    const after = fs.readdirSync(rawSessions).length;

    expect(after - before).toBe(0);
  });
});
