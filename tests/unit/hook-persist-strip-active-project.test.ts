import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Regression test for the `.work-state.md` Active-Project-strip corruption
 * (introduced in v0.22.0, commit 943c436).
 *
 * Background: the Stop hook rewrites `## Active Project` from wiki ground
 * truth on every session. To preserve any Claude-authored body, it first
 * strips the previous Active Project block via:
 *
 *     s.replace(/##\s+Active Project[\s\S]*?(?=\n##\s|\Z)/g, "")
 *
 * In Perl/Python `\Z` means end-of-string, but in JavaScript `\Z` is a
 * literal `Z` character. The Active-Project block contains an ISO 8601 UTC
 * timestamp (e.g. `2026-05-17T13:26:23.864Z`) — so the non-greedy match
 * terminates at that `Z`, leaving `Z\nWiki page: <path>\n\n...` as orphan
 * content. Each Stop run carries the orphan forward in `existingClaudeBody`
 * AND appends a fresh block, producing append-spam that grows by one
 * block per session.
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

function makeTranscript(home: string, name: string): string {
  const p = path.join(home, name);
  const lines = [
    JSON.stringify({ type: 'summary', summary: 'test' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' } }),
  ];
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('neuromcp-persist hook — stripActiveProject regex (\\Z bug)', () => {
  let home: string;
  let workStateFile: string;
  let projectsDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nmcp-strip-'));
    workStateFile = path.join(home, '.neuromcp', '.work-state.md');
    projectsDir = path.join(home, '.neuromcp', 'wiki', 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.mkdirSync(path.join(home, '.neuromcp', 'raw', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.neuromcp', 'wiki', 'log.md'), '');
    // Create a wiki project file so the hook detects an Active Project candidate.
    fs.writeFileSync(path.join(projectsDir, 'demo-project.md'), '# demo-project\n');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('does not leave orphan "Z" lines or duplicate "Wiki page:" lines after stripping', () => {
    // Seed a Claude-authored work-state.md that includes an Active Project
    // block (with the corrupting ISO timestamp ending in Z) plus Claude
    // sentinel headers, so the strip codepath actually runs and the result
    // is treated as `existingClaudeBody` to be preserved.
    const seed = [
      '## Active Project',
      'demo-project — last updated 2026-05-17T13:26:23.864Z',
      'Wiki page: ~/.neuromcp/wiki/projects/demo-project.md',
      '',
      '## Current Work',
      'Implementing the feature.',
      '',
      '## Next Steps',
      '- Step one',
      '- Step two',
      '',
      '## Key Files',
      '- src/foo.ts',
    ].join('\n');
    fs.writeFileSync(workStateFile, seed);

    const transcript = makeTranscript(home, 'real.jsonl');
    const { status } = runHook({ transcriptPath: transcript, home });
    expect(status).toBe(0);

    const after = fs.readFileSync(workStateFile, 'utf8');

    // 1. No orphan "Z" line left over from the ISO timestamp tail.
    expect(after).not.toMatch(/^Z$/m);

    // 2. Wiki page reference appears at most once (the freshly written one),
    //    not duplicated from the previous block's leftover.
    const wikiPageMatches = after.match(/^Wiki page: /gm) ?? [];
    expect(wikiPageMatches.length).toBeLessThanOrEqual(1);

    // 3. Active Project header appears at most once.
    const activeProjectMatches = after.match(/^## Active Project$/gm) ?? [];
    expect(activeProjectMatches.length).toBeLessThanOrEqual(1);
  });

  it('does not grow unboundedly across repeated Stop invocations (append-spam regression)', () => {
    // Simulate 5 back-to-back sessions. With the \Z bug each Stop carries
    // forward an orphan "Z\nWiki page: …" tail in existingClaudeBody AND
    // prepends a fresh block, so the file grows by one block per run.
    const seed = [
      '## Active Project',
      'demo-project — last updated 2026-05-17T13:26:23.864Z',
      'Wiki page: ~/.neuromcp/wiki/projects/demo-project.md',
      '',
      '## Current Work',
      'Iterating.',
      '',
      '## Next Steps',
      '- continue',
    ].join('\n');
    fs.writeFileSync(workStateFile, seed);

    const sizes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const transcript = makeTranscript(home, `run-${i}.jsonl`);
      const { status } = runHook({ transcriptPath: transcript, home });
      expect(status).toBe(0);
      sizes.push(fs.statSync(workStateFile).size);
    }

    // Final file size must not exceed the first-write size by more than a
    // small fudge factor (timestamps drift a few bytes per run).
    const first = sizes[0];
    const last = sizes[sizes.length - 1];
    expect(last - first).toBeLessThan(200);
  });
});
