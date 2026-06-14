import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(__dirname, '..', '..', 'scripts', 'consolidate-sessions.py');
const source = readFileSync(SCRIPT, 'utf8');

describe('consolidate-sessions.py v0.26 reliability fixes', () => {
  describe('generator/auditor evidence symmetry (structural — LLM prompts)', () => {
    it('the generator prompt carries the evidence-grounding clauses', () => {
      expect(source).toContain('EVIDENCE RULES');
      // wiki page is de-dup context only — the core generator/auditor asymmetry fix
      expect(source).toMatch(/CURRENT WIKI PAGE[\s\S]*de-duplication ONLY/);
      expect(source).toContain('WRITE LESS');
    });

    it('the auditor is told the date/section header is a label, not a claim', () => {
      expect(source).toMatch(/SECTION HEADER is a label/i);
    });
  });

  describe('terminal state (no infinite 4h retry)', () => {
    it('exhausted batches return the batch (so the ledger advances) instead of an empty list', () => {
      // The exhaustion path must hand the batch back as terminal/processed.
      expect(source).toMatch(/return False, list\(batch\)/);
      expect(source).toMatch(/terminal; ledger advanced/);
    });

    it('main advances the ledger for terminal sessions regardless of success', () => {
      expect(source).toMatch(/if not args\.dry_run and done:/);
    });
  });

  describe('empty-session guard (behavioural via python)', () => {
    it('is_content_free is True for tool-call checkpoints and empty files, False for prose', () => {
      const dir = mkdtempSync(join(tmpdir(), 'nmcp-cs-'));
      try {
        const toolcall = join(dir, 'toolcall.md');
        writeFileSync(
          toolcall,
          '- 2026-06-14T00:10:54.232Z | 8110 tool calls | last: Read | cwd: /Users/a\n' +
            '- 2026-06-14T00:13:11.247Z | 8115 tool calls | last: Edit | cwd: /Users/a/projects/neuromcp\n',
        );
        const prose = join(dir, 'prose.md');
        writeFileSync(prose, '## Session\n[USER]: please fix the deploy bug\nWe changed the rollback logic.\n');
        const empty = join(dir, 'empty.md');
        writeFileSync(empty, '   \n\n');

        const py = `
import importlib.util, pathlib, json
spec = importlib.util.spec_from_file_location("cs", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({
  "toolcall": m.is_content_free(pathlib.Path(${JSON.stringify(toolcall)})),
  "prose": m.is_content_free(pathlib.Path(${JSON.stringify(prose)})),
  "empty": m.is_content_free(pathlib.Path(${JSON.stringify(empty)})),
}))
`;
        const r = spawnSync('python3', ['-c', py], { encoding: 'utf8' });
        expect(r.status).toBe(0);
        const out = JSON.parse(r.stdout.trim()) as Record<string, boolean>;
        expect(out.toolcall).toBe(true);
        expect(out.prose).toBe(false);
        expect(out.empty).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
