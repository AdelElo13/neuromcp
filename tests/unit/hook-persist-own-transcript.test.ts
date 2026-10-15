import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Regression (2026-10-15): the Stop hook filled "User messages / Tools used /
 * Files modified" from the most recently modified ~/.claude/session-data/*-session.tmp
 * of ANY session (one merged file per directory per day). Raw logs therefore
 * carried another session's file list, and consolidation attributed work to the
 * wrong project (mac-control-mcp v0.10.2 released from a coffeeshopmakelaar
 * session never reached its wiki page). The hook must summarise only its own
 * transcript, and only the part added since its previous Stop.
 */
const HOOK = path.join(__dirname, '..', '..', 'templates', 'hooks', 'neuromcp-persist.cjs');

function runHook(home: string, input: Record<string, unknown>) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(input),
    env: { ...process.env, CLAUDE_HOOK_EVENT: 'Stop', HOME: home },
    encoding: 'utf8',
    timeout: 5000,
  });
}
const line = (o: unknown) => JSON.stringify(o) + '\n';

describe('neuromcp-persist hook — summary from its own transcript', () => {
  let home: string; let raw: string; let transcript: string;
  const sessionId = '11111111-2222-3333-4444-555555555555';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nmcp-own-'));
    raw = path.join(home, '.neuromcp', 'raw', 'sessions');
    fs.mkdirSync(raw, { recursive: true });
    fs.mkdirSync(path.join(home, '.neuromcp', 'wiki'), { recursive: true });
    fs.writeFileSync(path.join(home, '.neuromcp', 'wiki', 'log.md'), '');
    // Decoy: a newer merged summary of ANOTHER session that names other files.
    const sd = path.join(home, '.claude', 'session-data');
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, '2026-10-14-other-session.tmp'),
      `### Tasks\n- decoy task\n\n### Tools Used\nDecoyTool\n\n### Files Modified\n- ${home}/projects/neuromcp/src/decoy.ts\n\n---\n`);
    transcript = path.join(home, 't.jsonl');
    const cwd = `${home}/projects/coffeeshopmakelaar`;
    fs.writeFileSync(transcript,
      line({ type: 'user', sessionId, cwd, message: { role: 'user', content: 'publiceer mac-control-mcp v0.10.2' } }) +
      line({ type: 'assistant', sessionId, cwd, message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: `${home}/projects/mac-control-mcp/Sources/Zoo.swift` } },
        { type: 'tool_use', name: 'Bash', input: { command: `cd ${home}/projects/mac-control-mcp && git tag v0.10.2 && npm publish` } },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
      ] } }) +
      line({ type: 'user', sessionId, cwd, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const logs = () => fs.readdirSync(raw).sort().map(f => fs.readFileSync(path.join(raw, f), 'utf8'));

  it('uses only its own transcript: own files, release commands and projects; never the decoy', () => {
    runHook(home, { transcript_path: transcript, session_id: sessionId, cwd: `${home}/projects/coffeeshopmakelaar` });
    const [log] = logs();
    expect(log).toContain(`Session ID: ${sessionId}`);
    expect(log).toContain('publiceer mac-control-mcp v0.10.2');
    expect(log).toContain(`${home}/projects/mac-control-mcp/Sources/Zoo.swift`);
    expect(log).toMatch(/Release commands:[\s\S]*git tag v0\.10\.2 && npm publish/);
    expect(log).not.toContain('ls -la');
    expect(log).toMatch(/Projects: .*mac-control-mcp/);
    expect(log).not.toContain('decoy');
    expect(log).not.toContain('DecoyTool');
  });

  it('a second Stop summarises only what was added since the previous Stop', () => {
    runHook(home, { transcript_path: transcript, session_id: sessionId, cwd: home });
    fs.appendFileSync(transcript, line({ type: 'user', sessionId, message: { role: 'user', content: 'tweede vraag' } }));
    runHook(home, { transcript_path: transcript, session_id: sessionId, cwd: home });
    const all = logs();
    expect(all).toHaveLength(2);
    const second = all.filter(l => l.includes('tweede vraag'));                 // same-second collision names sort unpredictably
    expect(second).toHaveLength(1);
    expect(second[0]).not.toContain('publiceer mac-control-mcp');
  });

  it('a Stop with nothing new writes no raw log', () => {
    runHook(home, { transcript_path: transcript, session_id: sessionId, cwd: home });
    runHook(home, { transcript_path: transcript, session_id: sessionId, cwd: home });
    expect(logs()).toHaveLength(1);
  });

  it('keeps the most recent user messages and release commands of a long transcript', () => {
    let body = '';
    for (let i = 0; i < 40; i++) body += line({ type: 'user', sessionId, message: { role: 'user', content: `vraag ${i}` } });
    for (let i = 0; i < 25; i++) body += line({ type: 'assistant', sessionId, message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Bash', input: { command: `git tag v0.${i}.0` } }] } });
    fs.writeFileSync(transcript, body);
    runHook(home, { transcript_path: transcript, session_id: sessionId, cwd: home });
    const [log] = logs();
    expect(log).toContain('vraag 39'); expect(log).not.toContain('vraag 9\n');
    expect(log).toContain('git tag v0.24.0'); expect(log).not.toContain('git tag v0.4.0');
  });

  it('a release command with ~/projects/<name> alone names the project', () => {
    fs.writeFileSync(transcript,
      line({ type: 'user', sessionId, message: { role: 'user', content: 'release it' } }) +
      line({ type: 'assistant', sessionId, message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'cd ~/projects/agentrank && git tag v1.2.0 && git push --tags' } }] } }));
    runHook(home, { transcript_path: transcript, session_id: sessionId, cwd: home });
    expect(logs()[0]).toMatch(/^Projects: agentrank$/m);
  });
});
