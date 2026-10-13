import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, '..', '..', 'scripts', 'consolidate-sessions.py');
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf-8');
const PLIST_TEMPLATE = readFileSync(
  join(HERE, '..', '..', 'scripts', 'com.neuromcp.consolidate.plist.template'),
  'utf-8',
);
const INSTALLER = readFileSync(join(HERE, '..', '..', 'bin', 'enable-consolidation.mjs'), 'utf-8');

describe('consolidation launchd environment', () => {
  it('passes USER and LOGNAME to the agent (claude -p needs them to find its keychain login)', () => {
    // Without USER, `claude -p` under launchd prints "Not logged in · Please
    // run /login" and exits 1 — every consolidation run failed silently from
    // 2026-08-05 to 2026-10-13.
    expect(PLIST_TEMPLATE).toMatch(/<key>USER<\/key>\s*<string>\{\{USER\}\}<\/string>/);
    expect(PLIST_TEMPLATE).toMatch(/<key>LOGNAME<\/key>\s*<string>\{\{USER\}\}<\/string>/);
    expect(INSTALLER).toMatch(/replaceAll\('\{\{USER\}\}'/);
  });
});

describe('consolidate-sessions.py — isolated claude -p calls', () => {
  it('runs every claude -p call without hooks, CLAUDE.md, settings or MCP servers', () => {
    // The user's UserPromptSubmit hooks injected <working-context>/<neuromcp-recall>
    // (e.g. an unrelated "active goal") into the summarizer prompt; the
    // summary repeated it and the auditor rejected the batch as unsupported.
    // CLAUDE.md files leaked the same way. MCP servers are pure overhead and
    // opened daemon sessions per call.
    const blocks = SCRIPT.split(/subprocess\.run\(/).slice(1);
    const claudeBlocks = blocks.filter((b) => /"claude",\s*"-p"/.test(b));
    expect(claudeBlocks.length).toBeGreaterThan(0);
    for (const [i, block] of claudeBlocks.entries()) {
      const head = block.slice(0, 500);
      expect(head, `claude -p call #${i + 1} missing *CLAUDE_ISOLATION_ARGS`).toMatch(/\*CLAUDE_ISOLATION_ARGS/);
      expect(head, `claude -p call #${i + 1} missing env=CLAUDE_ISOLATED_ENV`).toMatch(/env\s*=\s*CLAUDE_ISOLATED_ENV/);
    }
    expect(SCRIPT).toMatch(/"disableAllHooks":\s*True/);
    expect(SCRIPT).toMatch(/"--setting-sources",\s*""/);
    expect(SCRIPT).toMatch(/"--strict-mcp-config"/);
    expect(SCRIPT).toMatch(/CLAUDE_CODE_DISABLE_CLAUDE_MDS/);
  });
});

describe('consolidate-sessions.py — failure diagnostics', () => {
  it('logs why a claude -p call failed instead of only "no output"', () => {
    // The summary loop used to print "no output" and drop stderr/stdout, which
    // hid the auth failure above for 10 weeks.
    expect(SCRIPT).toMatch(/def _cli_diag\(/);
    expect(SCRIPT).toMatch(/no output for .*: \{diag\}/);
    expect(SCRIPT).toMatch(/empty response from auditor \(exit=\{r\.returncode\}: \{_cli_diag\(r\)\}\)/);
    expect(SCRIPT).not.toMatch(/return r\.stdout if r\.returncode == 0 else None/);
  });
});

describe('consolidate-sessions.py — claude -p invocation regressions', () => {
  it('does not pass --tools "" (regression: API 400 tools.N.input_schema)', () => {
    // Claude CLI >= 2.x rejects any --tools value because a registered MCP
    // tool has a top-level oneOf/allOf/anyOf schema the Anthropic API refuses
    // ("API Error 400 tools.N.custom.input_schema: input_schema does not
    // support oneOf, allOf, or anyOf at the top level"). Default (no flag)
    // yields prompt-only completion, which is what audit/summary/facts need.
    expect(SCRIPT).not.toMatch(/"--tools",\s*""/);
  });

  it('passes stdin=DEVNULL on every claude -p subprocess.run call', () => {
    // Without stdin=subprocess.DEVNULL, launchd / non-TTY parents cause a 3s
    // stdin-handshake stall and `claude -p` exits 1 with
    // "Warning: no stdin data received in 3s, proceeding without it".
    const blocks = SCRIPT.split(/subprocess\.run\(/).slice(1);
    const claudeBlocks = blocks.filter((b) => /"claude",\s*"-p"/.test(b));
    expect(
      claudeBlocks.length,
      'expected at least one claude -p call in the script',
    ).toBeGreaterThan(0);
    for (const [i, block] of claudeBlocks.entries()) {
      // Look at the call header — args + kwargs up to the close paren of
      // subprocess.run(...). 500 chars is generous for the longest invocation.
      const head = block.slice(0, 500);
      expect(
        head,
        `claude -p subprocess.run call #${i + 1} missing stdin=subprocess.DEVNULL`,
      ).toMatch(/stdin\s*=\s*subprocess\.DEVNULL/);
    }
  });
});
