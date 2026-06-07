import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, '..', '..', 'scripts', 'reprocess-review-queue.py');

function runScript(home: string) {
  return spawnSync('python3', [SCRIPT_PATH], {
    env: {
      ...process.env,
      HOME: home,
      NEUROMCP_DIR: join(home, '.neuromcp'),
    },
    encoding: 'utf-8',
  });
}

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'neuromcp-reprocess-'));
  mkdirSync(join(home, '.neuromcp', 'raw', 'sessions'), { recursive: true });
  mkdirSync(join(home, '.neuromcp', 'review-queue', 'exhausted'), { recursive: true });
  return home;
}

describe('reprocess-review-queue.py — stale queue file pruner', () => {
  let home: string;

  beforeEach(() => {
    home = setupHome();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('prunes a queued batch when all sessions for that project are in the ledger', () => {
    // Session content references <HOME>/projects/foo so detect_project resolves to "foo".
    writeFileSync(
      join(home, '.neuromcp/raw/sessions/2026-06-01-1234.md'),
      `working dir: ${home}/projects/foo\nhello`,
    );
    writeFileSync(
      join(home, '.neuromcp/raw/sessions/2026-06-01-1235.md'),
      `working dir: ${home}/projects/foo\nhello`,
    );
    writeFileSync(
      join(home, '.neuromcp/consolidation-ledger.json'),
      JSON.stringify({ processed: ['2026-06-01-1234.md', '2026-06-01-1235.md'] }),
    );
    const queueFile = join(
      home,
      '.neuromcp/review-queue/2026-06-01T12-00-00_foo_batch1.md',
    );
    writeFileSync(queueFile, '# rejected\n\n> reason\n\n---\n\nsummary');

    const result = runScript(home);

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(
      existsSync(queueFile),
      'stale queue file should be deleted when all batch sessions are processed',
    ).toBe(false);
    expect(result.stdout).toMatch(/1 stale removed/);
  });

  it('keeps queue files when the project still has unprocessed sessions', () => {
    writeFileSync(
      join(home, '.neuromcp/raw/sessions/2026-06-01-1234.md'),
      `working dir: ${home}/projects/foo\nhello`,
    );
    writeFileSync(
      join(home, '.neuromcp/consolidation-ledger.json'),
      JSON.stringify({ processed: [] }),
    );
    const queueFile = join(
      home,
      '.neuromcp/review-queue/2026-06-01T12-00-00_foo_batch1.md',
    );
    writeFileSync(queueFile, '# rejected\n\n> reason\n\n---\n\nsummary');

    const result = runScript(home);

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(
      existsSync(queueFile),
      'queue file must remain when project still has pending work',
    ).toBe(true);
  });

  it('never touches files in review-queue/exhausted/', () => {
    writeFileSync(
      join(home, '.neuromcp/consolidation-ledger.json'),
      JSON.stringify({ processed: [] }),
    );
    const exhaustedFile = join(
      home,
      '.neuromcp/review-queue/exhausted/2026-06-01T12-00-00_foo_batch1.md',
    );
    writeFileSync(exhaustedFile, 'exhausted summary');

    const result = runScript(home);

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(
      existsSync(exhaustedFile),
      'exhausted/ batches are persistent failures — pruner must not auto-delete them',
    ).toBe(true);
    expect(result.stdout).toMatch(/1 in exhausted\//);
  });

  it('handles a missing review-queue/ directory gracefully', () => {
    // Setup creates review-queue/ — remove it for this test.
    rmSync(join(home, '.neuromcp/review-queue'), { recursive: true, force: true });

    const result = runScript(home);

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/review-queue\/ does not exist/);
  });

  it('does not delete queue files with malformed names', () => {
    writeFileSync(
      join(home, '.neuromcp/consolidation-ledger.json'),
      JSON.stringify({ processed: [] }),
    );
    const oddFile = join(home, '.neuromcp/review-queue/manually-renamed.md');
    writeFileSync(oddFile, 'human note');

    const result = runScript(home);

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(
      existsSync(oddFile),
      'files that do not match the expected queue filename schema must be left alone',
    ).toBe(true);
    expect(result.stdout).toMatch(/1 unparseable/);
  });
});
