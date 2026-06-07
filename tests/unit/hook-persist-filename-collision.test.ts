import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Regression test surfaced by Codex review 2026-06-07.
 *
 * Background: the raw-log filename was constructed as `YYYY-MM-DD-HHMM.md`
 * (minute-precision). When two Stop hooks fire within the same minute — common
 * during fast iteration, hook-driven workflows, or rapid restart cycles — the
 * second invocation silently overwrites the first session's raw log. Loss is
 * invisible: no warning, no error, just one minute of work gone.
 *
 * Guard: filename uses second-precision (`HHMMSS`) plus a collision counter
 * suffix (`-1`, `-2`, ...) when even the second-precision name already exists.
 * Both deterministic across the wall-clock race window.
 */
const HOOK = path.join(__dirname, '..', '..', 'templates', 'hooks', 'neuromcp-persist.cjs');

function runHook(opts: { transcriptPath: string; home: string }): {
  stderr: string;
  stdout: string;
  status: number | null;
} {
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify({ transcript_path: opts.transcriptPath }),
    env: { ...process.env, CLAUDE_HOOK_EVENT: 'Stop', HOME: opts.home },
    encoding: 'utf8',
    timeout: 5000,
  });
  return { stderr: result.stderr ?? '', stdout: result.stdout ?? '', status: result.status };
}

function makeRealTranscript(home: string, name: string, content: string): string {
  const p = path.join(home, name);
  const lines = [
    JSON.stringify({ type: 'summary', summary: 'test' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'reply' } }),
  ];
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('neuromcp-persist hook — raw-log filename collision guard', () => {
  let home: string;
  let rawSessions: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nmcp-collision-'));
    rawSessions = path.join(home, '.neuromcp', 'raw', 'sessions');
    fs.mkdirSync(rawSessions, { recursive: true });
    fs.mkdirSync(path.join(home, '.neuromcp', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(home, '.neuromcp', 'wiki', 'log.md'), '');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('writes distinct files for back-to-back Stops within the same minute', () => {
    const t1 = makeRealTranscript(home, 'first.jsonl', 'first session content unique-aaa');
    const t2 = makeRealTranscript(home, 'second.jsonl', 'second session content unique-bbb');

    runHook({ transcriptPath: t1, home });
    runHook({ transcriptPath: t2, home });

    const files = fs.readdirSync(rawSessions).filter((n) => n.endsWith('.md'));
    expect(
      files.length,
      `each Stop hook must produce its own raw-log file (got ${files.length}: ${files.join(', ')})`,
    ).toBe(2);
  });

  it('files have distinct timestamps when written back-to-back', () => {
    // The raw-log itself is metadata-only (no user content) — what matters
    // for collision avoidance is that each Stop produces its own filename.
    // Distinct filenames AND distinct internal `Session ended:` timestamps
    // together prove the second call did not silently clobber the first.
    const t1 = makeRealTranscript(home, 'a.jsonl', 'one');
    const t2 = makeRealTranscript(home, 'b.jsonl', 'two');

    runHook({ transcriptPath: t1, home });
    runHook({ transcriptPath: t2, home });

    const files = fs.readdirSync(rawSessions)
      .filter((n) => n.endsWith('.md'))
      .sort();
    expect(files.length).toBe(2);

    // All filenames must be unique (Set-collapse check).
    const unique = new Set(files);
    expect(unique.size).toBe(files.length);

    // Internal session-end timestamps differ (sanity check that we read two
    // distinct hook invocations, not the same content twice).
    const contents = files.map((n) => fs.readFileSync(path.join(rawSessions, n), 'utf8'));
    const sessionEndMatches = contents.map((c) => c.match(/Session ended: (\S+)/)?.[1]).filter(Boolean);
    expect(new Set(sessionEndMatches).size).toBe(sessionEndMatches.length);
  });

  it('handles three rapid-fire Stops without losing any session', () => {
    const t1 = makeRealTranscript(home, '1.jsonl', 'one');
    const t2 = makeRealTranscript(home, '2.jsonl', 'two');
    const t3 = makeRealTranscript(home, '3.jsonl', 'three');

    runHook({ transcriptPath: t1, home });
    runHook({ transcriptPath: t2, home });
    runHook({ transcriptPath: t3, home });

    const files = fs.readdirSync(rawSessions).filter((n) => n.endsWith('.md'));
    expect(
      files.length,
      `each Stop must produce its own file (got ${files.length}: ${files.join(', ')})`,
    ).toBe(3);
    expect(new Set(files).size).toBe(3);
  });
});
