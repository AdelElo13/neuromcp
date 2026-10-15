import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression (0.30.3): the auditor rejected a whole batch for one over-stated
 * line ("calling u1 a printer is an inference"); each retry regenerated every
 * line with new small errors; after three tries ALL facts were dropped. 3000+
 * batches sat in review-queue/exhausted/. Now the flagged lines are pruned and
 * the remainder is RE-AUDITED — nothing reaches the wiki unaudited.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'scripts', 'consolidate-sessions.py');

function py(home: string, body: string, extraEnv: Record<string, string> = {}) {
  const code = `
import importlib.util, pathlib, json
spec = importlib.util.spec_from_file_location("cs", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}
`;
  const r = spawnSync('python3', ['-c', code], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...extraEnv },
    timeout: 60_000,
  });
  expect(r.status, r.stderr + r.stdout).toBe(0);
  return JSON.parse(r.stdout.trim().split('\n').at(-1) as string);
}

const SUMMARY = [
  '## [2026-10-15]',
  '**Print job:**',
  '- The user supplied a 3mf of the Pikachu cover and asked for a second version for the u1 printer.',
  '  - Both versions use a full plate.',
  '- The dispatch fix adds readTurnOutcome to recover aborted turns.',
  '- 316 tests and an independent review were green.',
].join('\n');

describe('prune_summary', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'nmcp-prune-')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('removes the flagged line with its sub-bullets; headers and other claims stay', () => {
    const out = py(home, `
pruned, removed, unmatched = m.prune_summary(${JSON.stringify(SUMMARY)}, ["asked for a second version for the 'u1' printer"])
print(json.dumps({"pruned": pruned, "removed": removed, "unmatched": unmatched}))`);
    expect(out.unmatched).toEqual([]);
    expect(out.removed).toHaveLength(2);
    expect(out.pruned).toContain('## [2026-10-15]');
    expect(out.pruned).toContain('**Print job:**');
    expect(out.pruned).toContain('readTurnOutcome');
    expect(out.pruned).toContain('316 tests');
    expect(out.pruned).not.toContain('u1');
    expect(out.pruned).not.toContain('full plate');
  });

  it('refuses when a flagged claim matches no line clearly', () => {
    const out = py(home, `
print(json.dumps(m.prune_summary(${JSON.stringify(SUMMARY)}, ["The deployment to Antagonist succeeded on Friday"])))`);
    expect(out[0]).toBeNull();
    expect(out[2]).toEqual(['The deployment to Antagonist succeeded on Friday']);
  });

  it('refuses when more than half of the claim lines would go', () => {
    const out = py(home, `
print(json.dumps(m.prune_summary(${JSON.stringify(SUMMARY)}, [
  "second version for the u1 printer", "readTurnOutcome to recover aborted turns", "316 tests and an independent review"])))`);
    expect(out[0]).toBeNull();
  });

  it('refuses one-word claims (too ambiguous to locate)', () => {
    const out = py(home, `print(json.dumps(m.prune_summary(${JSON.stringify(SUMMARY)}, ["u1"])))`);
    expect(out[0]).toBeNull();
  });
});

describe('consolidate_batch with a fake claude CLI', () => {
  let home: string;
  let bin: string;
  let session: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nmcp-prune-batch-'));
    bin = join(home, 'bin');
    mkdirSync(bin);
    const raw = join(home, '.neuromcp', 'raw', 'sessions');
    mkdirSync(raw, { recursive: true });
    mkdirSync(join(home, '.neuromcp', 'wiki', 'projects'), { recursive: true });
    session = join(raw, '2026-10-15-120000-abc.md');
    writeFileSync(session, '---\ndate: 2026-10-15\n---\nUser messages:\n- maak een tweede versie voor u1\n- fix the dispatch (readTurnOutcome)\n');
    // Fake `claude -p`: generator -> SUMMARY, auditor -> verdict by FAKE_MODE, facts -> [].
    writeFileSync(join(bin, 'claude'), `#!/usr/bin/env python3
import sys, json, os
prompt = sys.argv[-1]
mode = os.environ.get("FAKE_MODE", "prune")
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(("GEN" if "memory consolidation agent" in prompt else "AUDIT" if "strict fact-checker" in prompt else "OTHER") + "\\n")
if "memory consolidation agent" in prompt:
    print("\`\`\`markdown\\n" + ${JSON.stringify(SUMMARY)} + "\\n\`\`\`")
elif "strict fact-checker" in prompt:
    summary = prompt.split("<<<SUMMARY>>>", 1)[1]
    if "u1 printer" in summary or mode == "never":
        claim = "asked for a second version for the u1 printer" if mode != "never" else "Something no line says at all here"
        print(json.dumps({"approved": False, "unsupported": [claim], "note": "unsupported"}))
    else:
        print(json.dumps({"approved": True, "unsupported": [], "note": "ok"}))
else:
    print("[]")
`);
    chmodSync(join(bin, 'claude'), 0o755);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const env = (mode: string) => ({
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_MODE: mode,
    FAKE_LOG: join(home, 'calls.log'),
    NEUROMCP_CONTRADICTION_CHECK: '0',
  });

  it('prunes the flagged line, re-audits, and writes the rest to the wiki in ONE attempt', () => {
    const out = py(home, `
ok, done = m.consolidate_batch("demo", [pathlib.Path(${JSON.stringify(session)})], 1, 1)
print(json.dumps({"ok": ok, "done": len(done)}))`, env('prune'));
    expect(out).toEqual({ ok: true, done: 1 });
    const page = readFileSync(join(home, '.neuromcp', 'wiki', 'projects', 'demo.md'), 'utf8');
    expect(page).toContain('readTurnOutcome');
    expect(page).not.toContain('u1 printer');
    const calls = readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n');
    expect(calls.filter((c) => c === 'GEN')).toHaveLength(1);       // no regeneration
    expect(calls.filter((c) => c === 'AUDIT')).toHaveLength(2);     // audit + re-audit
    const pruned = readdirSync(join(home, '.neuromcp', 'review-queue', 'pruned'));
    expect(pruned).toHaveLength(1);
    expect(readFileSync(join(home, '.neuromcp', 'review-queue', 'pruned', pruned[0]), 'utf8')).toContain('u1 printer');
  });

  it('when pruning cannot help, the batch is exhausted AND records its source sessions', () => {
    const out = py(home, `
ok, done = m.consolidate_batch("demo", [pathlib.Path(${JSON.stringify(session)})], 1, 1)
print(json.dumps({"ok": ok}))`, env('never'));
    expect(out).toEqual({ ok: false });
    expect(existsSync(join(home, '.neuromcp', 'wiki', 'projects', 'demo.md'))).toBe(false);
    const ex = readdirSync(join(home, '.neuromcp', 'review-queue', 'exhausted'));
    expect(ex).toHaveLength(1);
    expect(readFileSync(join(home, '.neuromcp', 'review-queue', 'exhausted', ex[0]), 'utf8'))
      .toContain('Source: 2026-10-15-120000-abc.md');
  });
});
