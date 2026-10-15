import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression (2026-10-15): work was filed under the wrong wiki page.
 * - The project came from path counts over the whole raw log, including the
 *   recycled "Recent Wiki Activity" tail and another session's file list.
 * - One session spanning two repos only reached one page.
 * - Appended sections never refreshed `updated:` in the page frontmatter.
 * - Releases (commits/tags) never reached the summariser or the auditor.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'scripts', 'consolidate-sessions.py');

function py(home: string, body: string) {
  const code = `
import importlib.util, pathlib, json
spec = importlib.util.spec_from_file_location("cs", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${body}
`;
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim().split("\n").at(-1) as string);
}
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-14T01:00:00', GIT_COMMITTER_DATE: '2026-10-14T01:00:00' } });
  expect(r.status, r.stderr).toBe(0);
};

describe('consolidate-sessions.py — project attribution', () => {
  it('detect_projects: explicit Projects line wins, may name several projects', () => {
    const home = mkdtempSync(join(tmpdir(), 'nmcp-attr-'));
    try {
      const out = py(home, `print(json.dumps(m.detect_projects("---\\ndirectory: ${home}/projects/coffeeshopmakelaar\\n---\\nProjects: mac-control-mcp, neuromcp\\nFiles modified:\\n- ${home}/projects/neuromcp/a.ts\\n")))`);
      expect(out).toEqual(['mac-control-mcp', 'neuromcp']);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('detect_projects (legacy log): ignores paths in the recycled wiki-activity tail', () => {
    const home = mkdtempSync(join(tmpdir(), 'nmcp-attr-'));
    try {
      const tail = `\\n--- Recent Wiki Activity ---\\n${`${home}/projects/neuromcp/x.ts `.repeat(30)}\\n`;
      const out = py(home, `print(json.dumps([
        m.detect_projects("---\\ndirectory: ${home}/projects/coffeeshopmakelaar\\n---\\nUser messages: - fix\\n${tail}"),
        m.detect_projects("---\\ndirectory: ${home}/Documents/x\\n---\\nUser messages: - fix\\n${tail}"),
        m.detect_projects("---\\ndirectory: ${home}/Documents/x\\n---\\nFiles modified: - ${home}/projects/refmatch/a.py\\n${tail}"),
      ]))`);
      expect(out).toEqual([['coffeeshopmakelaar'], ['home'], ['refmatch']]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('group_by_project puts a multi-project session in every group; ledger only after all its groups finished', () => {
    const home = mkdtempSync(join(tmpdir(), 'nmcp-attr-'));
    try {
      const s = join(home, 's.md');
      writeFileSync(s, '---\ndirectory: /x\n---\nProjects: alpha, beta\nUser messages: - hi\n');
      const out = py(home, `
p = pathlib.Path(${JSON.stringify(s)})
g = m.group_by_project([p])
print(json.dumps({"groups": {k: [x.name for x in v] for k, v in sorted(g.items())},
  "both": sorted(x.name for x in m.ledger_ready(g, {"alpha": [p], "beta": [p]})),
  "one": sorted(x.name for x in m.ledger_ready(g, {"alpha": [p], "beta": []}))}))`);
      expect(out.groups).toEqual({ alpha: ['s.md'], beta: ['s.md'] });
      expect(out.both).toEqual(['s.md']);
      expect(out.one).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('bump_updated refreshes or adds updated: in the frontmatter only', () => {
    const home = mkdtempSync(join(tmpdir(), 'nmcp-attr-'));
    try {
      const out = py(home, `print(json.dumps([
        m.bump_updated("---\\ntitle: x\\nupdated: 2026-04-19\\n---\\n\\nbody updated: keep\\n", "2026-10-15"),
        m.bump_updated("---\\ntitle: x\\n---\\nbody\\n", "2026-10-15"),
        m.bump_updated("no frontmatter\\n", "2026-10-15"),
      ]))`);
      expect(out[0]).toBe('---\ntitle: x\nupdated: 2026-10-15\n---\n\nbody updated: keep\n');
      expect(out[1]).toBe('---\ntitle: x\nupdated: 2026-10-15\n---\nbody\n');
      expect(out[2]).toBe('no frontmatter\n');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('git_history lists commits and tags of ~/projects/<project> in the session window', () => {
    const home = mkdtempSync(join(tmpdir(), 'nmcp-attr-'));
    try {
      const repo = join(home, 'projects', 'mac-control-mcp');
      mkdirSync(repo, { recursive: true });
      git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
      writeFileSync(join(repo, 'a'), '1'); git(repo, 'add', 'a'); git(repo, 'commit', '-qm', 'feat: ControlZoo covers 21 controls (v0.10.2)');
      git(repo, 'tag', 'v0.10.2');
      const s = join(home, '2026-10-14-003251.md'); writeFileSync(s, 'x');
      const out = py(home, `print(json.dumps([m.git_history("mac-control-mcp", [pathlib.Path(${JSON.stringify(s)})]), m.git_history("nope", [pathlib.Path(${JSON.stringify(s)})])]))`);
      expect(out[0]).toContain('feat: ControlZoo covers 21 controls (v0.10.2)');
      expect(out[0]).toContain('v0.10.2');
      expect(out[1]).toBe('');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('consolidate_batch gives git history to summariser and auditor, and refreshes updated:', () => {
    const home = mkdtempSync(join(tmpdir(), 'nmcp-attr-'));
    try {
      const repo = join(home, 'projects', 'mac-control-mcp');
      mkdirSync(repo, { recursive: true });
      git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
      writeFileSync(join(repo, 'a'), '1'); git(repo, 'add', 'a'); git(repo, 'commit', '-qm', 'release: notarized v0.10.2');
      git(repo, 'tag', 'v0.10.2');
      const pages = join(home, '.neuromcp', 'wiki', 'projects'); mkdirSync(pages, { recursive: true });
      writeFileSync(join(pages, 'mac-control-mcp.md'), '---\ntitle: mac-control-mcp\nupdated: 2026-04-19\n---\n\nold\n');
      const s = join(home, '2026-10-14-003251.md');
      writeFileSync(s, '---\ndirectory: /x\n---\nProjects: mac-control-mcp\nUser messages:\n- release it\n');
      const out = py(home, `
import subprocess, datetime
real = subprocess.run
prompts, audits = [], []
def fake(args, *a, **k):
    if args and args[0] == "claude":
        prompts.append(args[-1])
        return subprocess.CompletedProcess(args, 0, "\\x60\\x60\\x60markdown\\n## [x]\\n- Released v0.10.2.\\n\\x60\\x60\\x60\\n", "")
    return real(args, *a, **k)
m.subprocess.run = fake
m.audit_summary_detailed = lambda summary, batch, extra_sources="": (audits.append(extra_sources), (True, "ok", [], False))[1]
m.extract_facts = lambda *a, **k: []
ok, done = m.consolidate_batch("mac-control-mcp", [pathlib.Path(${JSON.stringify(s)})], 1, 1)
page = (m.WIKI_DIR / "projects" / "mac-control-mcp.md").read_text()
print(json.dumps({"ok": ok, "prompt": prompts[0], "audit": audits[0], "page": page, "today": datetime.date.today().isoformat()}))`);
      expect(out.ok).toBe(true);
      expect(out.prompt).toContain('release: notarized v0.10.2');
      expect(out.audit).toContain('release: notarized v0.10.2');
      expect(out.audit).toContain('tag: v0.10.2');
      expect(out.page).toContain(`updated: ${out.today}`);
      expect(out.page).not.toContain('updated: 2026-04-19');
      expect(out.page).toContain('- Released v0.10.2.');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('main --project X never marks a session processed that still belongs to another project', () => {
    const home = mkdtempSync(join(tmpdir(), 'nmcp-attr-'));
    try {
      const raw = join(home, '.neuromcp', 'raw', 'sessions'); mkdirSync(raw, { recursive: true });
      mkdirSync(join(home, '.neuromcp', 'wiki', 'projects'), { recursive: true });
      writeFileSync(join(raw, '2026-10-14-000001.md'), '---\ndirectory: /x\n---\nProjects: alpha, beta\nUser messages:\n- hi\n');
      const out = py(home, `
import sys
m.consolidate_project = lambda project, sessions, **k: (True, list(sessions))
m.trigger_wiki_index = lambda: None
sys.argv = ["cs", "--project", "alpha"]
m.main()
print(json.dumps(sorted(m.load_ledger())))`);
      expect(out).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('separate --project runs complete a multi-project session once, without reprocessing a finished project', () => {
    const home = mkdtempSync(join(tmpdir(), 'nmcp-attr-'));
    try {
      const raw = join(home, '.neuromcp', 'raw', 'sessions'); mkdirSync(raw, { recursive: true });
      mkdirSync(join(home, '.neuromcp', 'wiki', 'projects'), { recursive: true });
      writeFileSync(join(raw, '2026-10-14-000001.md'), '---\ndirectory: /x\n---\nProjects: alpha, beta\nUser messages:\n- hi\n');
      const out = py(home, `
import sys
calls = []
def fake(project, sessions, **k):
    calls.append(project); return (True, list(sessions))
m.consolidate_project = fake
m.trigger_wiki_index = lambda: None
states = []
for argv in (["cs", "--project", "alpha"], ["cs", "--project", "beta"], ["cs"]):
    sys.argv = argv; m.main(); states.append({"processed": sorted(m.load_ledger()), "partial": sorted(m.load_partial())})
print(json.dumps({"calls": calls, "states": states}))`);
      expect(out.calls).toEqual(['alpha', 'beta']);                        // the third, unfiltered run has nothing left
      expect(out.states[0]).toEqual({ processed: [], partial: ['2026-10-14-000001.md#alpha'] });
      expect(out.states[1]).toEqual({ processed: ['2026-10-14-000001.md'], partial: [] });   // runner's pending count stays correct
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('detect_projects (legacy log): configured project dirs outside ~/projects, longest prefix wins', () => {
    const home = mkdtempSync(join(tmpdir(), 'nmcp-attr-'));
    try {
      mkdirSync(join(home, '.neuromcp'), { recursive: true });
      writeFileSync(join(home, '.neuromcp', 'project-dirs.json'), JSON.stringify({
        'desktop-quatro': ['~/Documents/ChatGPT/Ken/duo', '~/Documents/ChatGPT/Ken/macos'],
        'ken-docs': ['~/Documents/ChatGPT/Ken/duo/docs'],
      }));
      const ken = `${home}/Documents/ChatGPT/Ken`;
      const out = py(home, `print(json.dumps([
        m.detect_projects("---\\ndirectory: ${ken}/macos\\n---\\nUser messages: - test\\n"),
        m.detect_projects("---\\ndirectory: ${ken}\\n---\\nFiles modified:\\n- ${ken}/duo/quatro.mjs\\n- ${ken}/duo/gemini.mjs\\n"),
        m.detect_projects("---\\ndirectory: ${ken}\\n---\\nFiles modified:\\n- ${ken}/duo/docs/a.md\\n"),
        m.detect_projects("---\\ndirectory: ${ken}\\n---\\nFiles modified:\\n- ${home}/Downloads/pikachu.3mf\\n- ${ken}/duo-old/x\\n"),
      ]))`);
      expect(out).toEqual([['desktop-quatro'], ['desktop-quatro'], ['ken-docs'], ['home']]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('a missing or malformed project-dirs.json changes nothing', () => {
    const home = mkdtempSync(join(tmpdir(), 'nmcp-attr-'));
    try {
      mkdirSync(join(home, '.neuromcp'), { recursive: true });
      writeFileSync(join(home, '.neuromcp', 'project-dirs.json'), '{not json');
      const out = py(home, `print(json.dumps(m.detect_projects("---\\ndirectory: ${home}/projects/refmatch\\n---\\n")))`);
      expect(out).toEqual(['refmatch']);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

