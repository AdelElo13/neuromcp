import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * scripts/reprocess-exhausted.py re-audits summaries exhausted before 0.30.3.
 * --estimate must make no model calls; --pilot must never touch the wiki;
 * --apply writes only re-audited sections and moves each file out of the queue.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, '..', '..', 'scripts', 'reprocess-exhausted.py');

describe('reprocess-exhausted.py', () => {
  let home: string; let bin: string; let ex: string; let wiki: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nmcp-reprocess-'));
    bin = join(home, 'bin'); mkdirSync(bin);
    const raw = join(home, '.neuromcp', 'raw', 'sessions'); mkdirSync(raw, { recursive: true });
    ex = join(home, '.neuromcp', 'review-queue', 'exhausted'); mkdirSync(ex, { recursive: true });
    wiki = join(home, '.neuromcp', 'wiki', 'projects'); mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, 'demo.md'), '---\ntitle: demo\nupdated: 2026-01-01\n---\n\n- Existing line about readOnlyBridge and quatro.mjs config.\n');
    writeFileSync(join(raw, '2026-09-20-101010.md'),
      '---\ndirectory: /x\n---\nProjects: demo\nUser messages:\n- fix "dispatch recovery" in gemini.mjs\n- release v1.2.3\n');
    writeFileSync(join(raw, '2026-09-20-111111.md'), '---\ndirectory: /x\n---\nProjects: other\nUser messages:\n- gemini.mjs "dispatch recovery"\n');
    const sum = (extra: string) => `## [2026-09-21]\n- The user asked to fix "dispatch recovery" in gemini.mjs.\n- Release v1.2.3 was prepared.\n${extra}`;
    // recoverable after pruning (old format: no Source lines)
    writeFileSync(join(ex, '2026-09-21T04-00-00_demo_batch1.md'),
      `# Rejected consolidation — demo batch 1\n\n> REJECTED — x\n\n---\n\n${sum('- The deploy to production succeeded on Friday.\n')}`);
    // duplicate of the same sources (older)
    writeFileSync(join(ex, '2026-09-20T23-00-00_demo_batch1.md'),
      `# Rejected consolidation — demo batch 1\n\n> REJECTED — x\n\n---\n\n${sum('')}`);
    // infra failure, no summary
    writeFileSync(join(ex, '2026-09-21T08-00-00_demo_batch2.md'),
      '# Rejected consolidation — demo batch 2\n\n> summary call empty/exit=1 (attempt 3/3)\n\n---\n\n(no summary produced — all attempts failed before audit)\n');
    // already in the wiki
    writeFileSync(join(ex, '2026-09-21T09-00-00_demo_batch3.md'),
      '# Rejected consolidation — demo batch 3\n\n> REJECTED — x\n\n---\n\n## [2026-09-21]\n- Existing line about readOnlyBridge and quatro.mjs config.\n');
    writeFileSync(join(bin, 'claude'), `#!/usr/bin/env python3
import sys, json, os, re
p = sys.argv[-1]
with open(os.environ["FAKE_LOG"], "a") as f: f.write("CALL\\n")
if "strict fact-checker" in p:
    s = re.split(r"<<<SUMMARY-[0-9a-f]+>>>", p, maxsplit=1)[1]
    if "production" in s:
        print(json.dumps({"approved": False, "unsupported": ["The deploy to production succeeded on Friday"], "note": "no deploy in sources"}))
    else:
        print(json.dumps({"approved": True, "unsupported": [], "note": "ok"}))
else:
    print("[]")
`);
    chmodSync(join(bin, 'claude'), 0o755);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const run = (...args: string[]) => {
    const r = spawnSync('python3', [TOOL, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: join(home, 'calls.log'), NEUROMCP_CONTRADICTION_CHECK: '0' },
      timeout: 60_000,
    });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    return r.stdout;
  };
  const calls = () => (existsSync(join(home, 'calls.log')) ? readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n').length : 0);

  it('--estimate classifies without a single model call', () => {
    const out = run('--estimate', '--accept-guessed-sources');
    expect(out).toMatch(/exhausted files: 4/);
    expect(out).toMatch(/process\s+1/);
    expect(out).toMatch(/skip_duplicate\s+1/);
    expect(out).toMatch(/skip_outage_no_summary\s+1/);
    expect(out).toMatch(/skip_in_wiki\s+1/);
    expect(out).toMatch(/estimated model calls: 1–2/);
    expect(calls()).toBe(0);
  });

  it('--pilot prunes and re-audits, writes to reprocess-pilot/, never the wiki', () => {
    const before = readFileSync(join(wiki, 'demo.md'), 'utf8');
    const out = run('--pilot', '5', '--accept-guessed-sources');
    expect(out).toMatch(/recovered — pruned 1 line/);
    expect(readFileSync(join(wiki, 'demo.md'), 'utf8')).toBe(before);
    const pilot = join(home, '.neuromcp', 'review-queue', 'reprocess-pilot');
    const [f] = readdirSync(pilot);
    const body = readFileSync(join(pilot, f), 'utf8');
    expect(body).toContain('<!-- guessed sources: 2026-09-20-101010.md -->');   // the "other" project session is not a source
    expect(body).toContain('dispatch recovery');
    const [header, section] = body.split('\n---\n');
    expect(header).toMatch(/pruned 1 line\(s\): - The deploy to production/);   // transparency
    expect(section).toContain('<!-- guessed sources:');
    expect(section).not.toContain('production');                                 // what the wiki would get
    expect(section).toMatch(/recovered \d{4}-\d{2}-\d{2}, re-audited/);
    expect(readdirSync(ex).filter((n) => n.endsWith('.md'))).toHaveLength(4);   // nothing moved
  });

  it('--apply appends the re-audited section and moves the file to recovered/', () => {
    run('--apply', '--accept-guessed-sources');
    const page = readFileSync(join(wiki, 'demo.md'), 'utf8');
    expect(page).toContain('Release v1.2.3 was prepared.');
    expect(page).not.toContain('production');
    expect(readdirSync(join(ex, 'recovered'))).toEqual(['2026-09-21T04-00-00_demo_batch1.md']);
    expect(readdirSync(ex).filter((n) => n.endsWith('.md'))).toHaveLength(3);
  });

  it('without --accept-guessed-sources, pre-0.30.3 files (no Source lines) are not processed', () => {
    const out = run('--estimate');
    expect(out).toMatch(/process\s+0/);
    expect(out).toMatch(/skip_needs_guessed_sources\s+2/);   // original + its older duplicate
  });

  it('files with recorded Source lines use exactly those, never guessed ones', () => {
    writeFileSync(join(ex, '2026-09-22T05-00-00_demo_batch9.md'),
      '# Rejected consolidation — demo batch 9\nSource: 2026-09-20-101010.md\nSource: ../../etc/passwd\n\n> REJECTED — x\n\n---\n\n## [2026-09-22]\n- Release v1.2.3 was prepared for gemini.mjs.\n');
    const out = run('--pilot', '1');
    expect(out).toMatch(/demo_batch9\.md: recovered/);
    const body = readFileSync(join(home, '.neuromcp', 'review-queue', 'reprocess-pilot', '2026-09-22T05-00-00_demo_batch9.md'), 'utf8');
    expect(body).toContain('<!-- sources: 2026-09-20-101010.md -->');
    expect(body).not.toContain('passwd');
  });

  it('--apply stores no facts for recovered history', () => {
    run('--apply', '--accept-guessed-sources');
    const log = readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n');
    expect(log.every((l) => l === 'CALL')).toBe(true);
    expect(existsSync(join(home, '.neuromcp', 'memory.db'))).toBe(false);
  });

  it('--apply refuses to run while the consolidation lock is held', () => {
    const lockPath = join(home, '.neuromcp', 'consolidation.flock');
    writeFileSync(lockPath, '');
    const holder = `import fcntl, time; f=open(${JSON.stringify(lockPath)}, "a"); fcntl.flock(f.fileno(), fcntl.LOCK_EX); print("held", flush=True); time.sleep(5)`;
    const child = require('node:child_process').spawn('python3', ['-c', holder]);
    return new Promise<void>((resolve) => {
      child.stdout.once('data', () => {
        const r = spawnSync('python3', [TOOL, '--apply', '--accept-guessed-sources'], {
          encoding: 'utf8',
          env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: join(home, 'calls.log') },
        });
        child.kill();
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/consolidation is running/);
        expect(existsSync(join(home, 'calls.log'))).toBe(false);
        resolve();
      });
    });
  });
});

