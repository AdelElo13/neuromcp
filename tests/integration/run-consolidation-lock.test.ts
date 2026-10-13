import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * run-consolidation.sh must never run twice at once. Without a lock, a manual
 * backlog run next to the 4-hourly launchd run processed the same sessions
 * twice (duplicate wiki sections + facts) and raced on the ledger file.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, '..', '..', 'scripts', 'run-consolidation.sh');

describe('run-consolidation.sh lock', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'neuromcp-lock-'));
    mkdirSync(join(dir, 'sessions'));
    writeFileSync(join(dir, 'sessions', '2026-10-13-120000.md'), '# session\n');
    // Python stub: real python for `-c` one-liners, a slow fake for the
    // consolidation script itself so two runs overlap.
    const stub = join(dir, 'python-stub.sh');
    writeFileSync(stub, '#!/bin/bash\nif [ "$1" = "-c" ]; then exec python3 "$@"; fi\necho "STUB RUN $$"\nsleep 2\n');
    chmodSync(stub, 0o755);
    env = {
      ...process.env,
      NEUROMCP_SESSIONS_DIR: join(dir, 'sessions'),
      NEUROMCP_LEDGER: join(dir, 'ledger.json'),
      NEUROMCP_LOG: join(dir, 'consolidation.log'),
      NEUROMCP_LOCK_DIR: join(dir, 'consolidation.lock'),
      NEUROMCP_PYTHON: stub,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a second concurrent run skips instead of processing the same sessions', async () => {
    const first = spawn('/bin/bash', [RUNNER], { env, stdio: 'ignore' });
    const firstDone = new Promise<number>((resolve) => first.on('exit', (c) => resolve(c ?? -1)));
    // Wait until the first run holds the lock.
    for (let i = 0; i < 50 && !existsSync(join(dir, 'consolidation.lock', 'pid')); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const second = spawnSync('/bin/bash', [RUNNER], { env, encoding: 'utf8' });
    expect(second.status).toBe(0);
    expect(await firstDone).toBe(0);

    const log = readFileSync(join(dir, 'consolidation.log'), 'utf8');
    expect(log).toMatch(/another consolidation run is active/);
    expect((log.match(/STUB RUN/g) ?? []).length).toBe(1 + 1); // first run: consolidate + review-queue pruner
    expect(existsSync(join(dir, 'consolidation.lock'))).toBe(false);
  });

  it('takes over a stale lock left by a dead process', () => {
    mkdirSync(join(dir, 'consolidation.lock'));
    writeFileSync(join(dir, 'consolidation.lock', 'pid'), '999999\n');

    const run = spawnSync('/bin/bash', [RUNNER], { env, encoding: 'utf8' });
    expect(run.status).toBe(0);
    const log = readFileSync(join(dir, 'consolidation.log'), 'utf8');
    expect(log).toMatch(/stale consolidation lock/);
    expect(log).toMatch(/STUB RUN/);
    expect(existsSync(join(dir, 'consolidation.lock'))).toBe(false);
  });
});
