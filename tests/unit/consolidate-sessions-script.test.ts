import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, '..', '..', 'scripts', 'consolidate-sessions.py');
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf-8');

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
