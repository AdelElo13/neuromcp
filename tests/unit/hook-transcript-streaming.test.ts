import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Hooks must stream the session transcript instead of reading it whole.
 *
 * fs.readFileSync(transcript, 'utf8') throws "Cannot create a string longer
 * than 0x1fffffe8 characters" once a transcript passes ~512 MB (long sessions
 * with screenshots reach 700 MB+). Each hook swallowed that error:
 *  - neuromcp-persist counted 0 user messages → treated the session as EMPTY
 *    and wrote no raw log, so the session never reached consolidation;
 *  - neuromcp-auto-capture logged "Failed to read transcript" and captured
 *    nothing (258 lost captures in one month on a real install);
 *  - neuromcp-critic skipped the session.
 *
 * A 512 MB fixture is impractical in a unit test, so the streaming path is
 * exercised with NEUROMCP_TRANSCRIPT_CHUNK_BYTES forcing tiny read chunks:
 * lines, multi-byte UTF-8 characters and CRLF endings all straddle chunk
 * boundaries.
 */
const HOOKS_DIR = path.join(__dirname, '..', '..', 'templates', 'hooks');
const TRANSCRIPT_HOOKS = ['neuromcp-persist.cjs', 'neuromcp-auto-capture.cjs', 'neuromcp-critic.cjs'];

function run(hook: string, home: string, transcriptPath: string, event = 'Stop') {
  return spawnSync('node', [path.join(HOOKS_DIR, hook)], {
    input: JSON.stringify({ transcript_path: transcriptPath, hook_event_name: event }),
    env: {
      ...process.env,
      HOME: home,
      NEUROMCP_DB_PATH: path.join(home, '.neuromcp', 'memory.db'),
      CLAUDE_HOOK_EVENT: event,
      NEUROMCP_TRANSCRIPT_CHUNK_BYTES: '7',
    },
    encoding: 'utf8',
    timeout: 15000,
  });
}

describe('hook transcript streaming', () => {
  it('no hook reads the whole transcript into one string', () => {
    for (const hook of TRANSCRIPT_HOOKS) {
      const src = fs.readFileSync(path.join(HOOKS_DIR, hook), 'utf8');
      expect(src, hook).not.toMatch(/readFileSync\(\s*(transcriptPath|path)\s*,/);
      expect(src, hook).toMatch(/function forEachJsonlLine\(/);
    }
  });

  describe('functional, with 7-byte read chunks', () => {
    let home: string;
    let transcript: string;

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'nmcp-stream-'));
      for (const d of ['raw/sessions', 'wiki']) fs.mkdirSync(path.join(home, '.neuromcp', d), { recursive: true });
      fs.writeFileSync(path.join(home, '.neuromcp', 'wiki', 'log.md'), '');
      transcript = path.join(home, 't.jsonl');
      const lines = [
        { type: 'user', message: { role: 'user', content: 'eerste vraag over café 漢字 en de groene filamentrol' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'antwoord één' }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(5000) }] } },
        { type: 'user', message: { role: 'user', content: 'tweede vraag — €100' } },
      ];
      // CRLF endings and no trailing newline on the last line.
      fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\r\n'));
    });

    afterEach(() => {
      fs.rmSync(home, { recursive: true, force: true });
    });

    it('neuromcp-persist still sees the user messages and writes the raw log', () => {
      const r = run('neuromcp-persist.cjs', home, transcript);
      expect(r.stderr).not.toContain('Skipping empty session');
      expect(fs.readdirSync(path.join(home, '.neuromcp', 'raw', 'sessions')).length).toBe(1);
    });

    it('neuromcp-auto-capture parses every entry', () => {
      run('neuromcp-auto-capture.cjs', home, transcript);
      const log = fs.readFileSync(path.join(home, '.neuromcp', 'auto-capture.log'), 'utf8');
      expect(log).not.toContain('Failed to read transcript');
      expect(log).toMatch(/4 entries/);
    });
  });
});
