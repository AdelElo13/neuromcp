import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// @ts-expect-error — plain-ESM helper in bin/, no type declarations shipped
import {
  resolveDaemonPort,
  checkDaemon,
  checkOllama,
  checkOnnxModel,
  checkDatabase,
  deriveEmbeddingRoute,
  aggregateExitCode,
  terminateChild,
  runAuditNetwork,
} from '../../bin/doctor.mjs';

/**
 * DX-review upgrade: bin/doctor.mjs used to be a surface-level check
 * (path-existence for better-sqlite3, no daemon/Ollama/ONNX/db probes).
 * These tests pin the real triage behavior:
 *  - daemon /health probe (port from NEUROMCP_DAEMON_PORT, default 3200)
 *  - Ollama /api/tags probe + nomic-embed-text presence
 *  - ONNX fallback model presence (scripts/download-model.mjs target path)
 *  - DB open-read-only check, skipped cleanly when better-sqlite3 won't load
 *  - exit-code aggregation: 0 = all ok, 1 = warnings, 2 = broken
 */

function jsonResponse(body: unknown, ok = true): Promise<Response> {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

describe('resolveDaemonPort', () => {
  it('defaults to 3200 when NEUROMCP_DAEMON_PORT is unset', () => {
    expect(resolveDaemonPort({})).toBe(3200);
  });

  it('honours NEUROMCP_DAEMON_PORT from the environment', () => {
    expect(resolveDaemonPort({ NEUROMCP_DAEMON_PORT: '33200' })).toBe(33200);
  });

  it('falls back to the default on a non-numeric port', () => {
    expect(resolveDaemonPort({ NEUROMCP_DAEMON_PORT: 'abc' })).toBe(3200);
  });
});

describe('checkDaemon', () => {
  it('reports ok with the daemon version when /health answers', async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      jsonResponse({ status: 'ok', version: '0.26.0' }));
    const result = await checkDaemon({ fetchImpl, env: {} });
    expect(result.status).toBe('ok');
    expect(result.info).toContain('0.26.0');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:3200/health',
      expect.anything(),
    );
  });

  it('probes the port from NEUROMCP_DAEMON_PORT', async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      jsonResponse({ status: 'ok', version: '0.26.0' }));
    await checkDaemon({ fetchImpl, env: { NEUROMCP_DAEMON_PORT: '33200' } });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:33200/health',
      expect.anything(),
    );
  });

  it('warns (not fails) when the daemon is unreachable, with a launchctl hint on darwin', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkDaemon({ fetchImpl, env: {}, osPlatform: 'darwin' });
    expect(result.status).toBe('warn');
    expect(result.info).toContain('optional');
    expect(result.info).toContain('launchctl print gui/$(id -u)/com.neuromcp.daemon');
  });

  it('omits the launchctl hint on non-darwin platforms', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkDaemon({ fetchImpl, env: {}, osPlatform: 'linux' });
    expect(result.status).toBe('warn');
    expect(result.info).not.toContain('launchctl');
  });

  it('warns when the probe times out (AbortError)', async () => {
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    const fetchImpl = vi.fn().mockRejectedValue(abort);
    const result = await checkDaemon({ fetchImpl, env: {} });
    expect(result.status).toBe('warn');
  });
});

describe('checkOllama', () => {
  it('reports ok when Ollama answers and nomic-embed-text is installed', async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      jsonResponse({ models: [{ name: 'nomic-embed-text:latest' }, { name: 'llama3.2:3b' }] }));
    const result = await checkOllama({ fetchImpl, env: {} });
    expect(result.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.anything(),
    );
  });

  it('honours OLLAMA_HOST from the environment', async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      jsonResponse({ models: [{ name: 'nomic-embed-text' }] }));
    await checkOllama({ fetchImpl, env: { OLLAMA_HOST: 'http://10.0.0.5:11434' } });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://10.0.0.5:11434/api/tags',
      expect.anything(),
    );
  });

  it('warns with a pull hint when Ollama runs but nomic-embed-text is missing', async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      jsonResponse({ models: [{ name: 'llama3.2:3b' }] }));
    const result = await checkOllama({ fetchImpl, env: {} });
    expect(result.status).toBe('warn');
    expect(result.info).toContain('ollama pull nomic-embed-text');
    expect(result.info).toContain('ONNX');
  });

  it('warns about the ONNX 384d fallback when Ollama is unreachable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const result = await checkOllama({ fetchImpl, env: {} });
    expect(result.status).toBe('warn');
    expect(result.info).toContain('ONNX');
    expect(result.info).toContain('384');
  });
});

describe('checkOnnxModel', () => {
  it('reports ok when the fallback model file exists', () => {
    const exists = vi.fn().mockReturnValue(true);
    const result = checkOnnxModel({ exists });
    expect(result.status).toBe('ok');
    expect(exists).toHaveBeenCalledWith(expect.stringContaining('bge-small-en-v1.5.onnx'));
  });

  it('warns with a download hint when the model is absent', () => {
    const exists = vi.fn().mockReturnValue(false);
    const result = checkOnnxModel({ exists });
    expect(result.status).toBe('warn');
    expect(result.info).toContain('node scripts/download-model.mjs');
  });
});

describe('checkDatabase', () => {
  it('skips cleanly when better-sqlite3 itself did not load', () => {
    const result = checkDatabase({ Database: null, env: {}, exists: vi.fn() });
    expect(result.status).toBe('skip');
    expect(result.info).toContain('better-sqlite3');
  });

  it('reports ok when the db opens read-only and passes quick_check', () => {
    const close = vi.fn();
    const pragma = vi.fn().mockReturnValue([{ quick_check: 'ok' }]);
    const Database = vi.fn().mockImplementation(() => ({ pragma, close }));
    const result = checkDatabase({
      Database,
      env: { NEUROMCP_DB_PATH: '/tmp/x/memory.db' },
      exists: vi.fn().mockReturnValue(true),
    });
    expect(result.status).toBe('ok');
    expect(Database).toHaveBeenCalledWith('/tmp/x/memory.db', expect.objectContaining({ readonly: true }));
    expect(close).toHaveBeenCalled();
  });

  it('reports ok (not created yet) when the db file does not exist', () => {
    const Database = vi.fn();
    const result = checkDatabase({
      Database,
      env: {},
      exists: vi.fn().mockReturnValue(false),
    });
    expect(result.status).toBe('ok');
    expect(result.info).toContain('first run');
    expect(Database).not.toHaveBeenCalled();
  });

  it('fails when better-sqlite3 cannot open the db', () => {
    const Database = vi.fn().mockImplementation(() => {
      throw new Error('file is not a database');
    });
    const result = checkDatabase({
      Database,
      env: { NEUROMCP_DB_PATH: '/tmp/x/memory.db' },
      exists: vi.fn().mockReturnValue(true),
    });
    expect(result.status).toBe('fail');
    expect(result.info).toContain('file is not a database');
  });

  it('fails when quick_check reports corruption', () => {
    const close = vi.fn();
    const pragma = vi.fn().mockReturnValue([{ quick_check: 'row 12 missing from index' }]);
    const Database = vi.fn().mockImplementation(() => ({ pragma, close }));
    const result = checkDatabase({
      Database,
      env: { NEUROMCP_DB_PATH: '/tmp/x/memory.db' },
      exists: vi.fn().mockReturnValue(true),
    });
    expect(result.status).toBe('fail');
    expect(close).toHaveBeenCalled();
  });
});

describe('deriveEmbeddingRoute', () => {
  it('is ok when Ollama works', () => {
    const result = deriveEmbeddingRoute({ status: 'ok' }, { status: 'warn' });
    expect(result.status).toBe('ok');
  });

  it('is ok when only the ONNX fallback is available', () => {
    const result = deriveEmbeddingRoute({ status: 'warn' }, { status: 'ok' });
    expect(result.status).toBe('ok');
    expect(result.info).toContain('ONNX');
  });

  it('fails when no embedding route exists at all', () => {
    const result = deriveEmbeddingRoute({ status: 'warn' }, { status: 'warn' });
    expect(result.status).toBe('fail');
  });
});

/**
 * Test double for child_process.ChildProcess with real `killed` semantics:
 * `killed` flips to true as soon as a signal is *sent* — it says nothing
 * about the child having exited. A child that traps/ignores SIGTERM keeps
 * exitCode/signalCode at null and never emits 'exit' for it.
 */
class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  signals: string[] = [];

  constructor(private behavior: 'ignore-sigterm' | 'exit-on-sigterm') {
    super();
  }

  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal);
    this.killed = true;
    if (signal === 'SIGKILL' || this.behavior === 'exit-on-sigterm') {
      queueMicrotask(() => {
        this.signalCode = signal;
        this.emit('exit', null, signal);
      });
    }
    return true;
  }
}

describe('terminateChild', () => {
  it('escalates to SIGKILL when the child ignores SIGTERM (regression: child.killed is not "child exited")', async () => {
    const child = new FakeChild('ignore-sigterm');
    const escalated = await terminateChild(child, { graceMs: 20 });
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(escalated).toBe(true);
  });

  it('does not SIGKILL a child that exits on SIGTERM within the grace window', async () => {
    const child = new FakeChild('exit-on-sigterm');
    const escalated = await terminateChild(child, { graceMs: 20 });
    expect(child.signals).toEqual(['SIGTERM']);
    expect(escalated).toBe(false);
  });
});

describe('runAuditNetwork', () => {
  function collector() {
    const lines: string[] = [];
    return { lines, write: (s: string) => lines.push(s) };
  }

  it('fails cleanly with a readable message when the server cannot be spawned (regression: unhandled ENOENT)', async () => {
    const child = new FakeChild('ignore-sigterm');
    const spawnImpl = vi.fn().mockImplementation(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn node ENOENT')));
      return child;
    });
    const out = collector();
    const errOut = collector();
    const code = await runAuditNetwork({
      spawnImpl,
      exists: () => true,
      auditMs: 100,
      graceMs: 10,
      stdout: out,
      stderr: errOut,
    });
    expect(code).toBe(1);
    expect(errOut.lines.join('')).toContain('ENOENT');
  });

  it('returns 1 with a build hint when dist/index.js is missing', async () => {
    const spawnImpl = vi.fn();
    const errOut = collector();
    const code = await runAuditNetwork({
      spawnImpl,
      exists: (p: string) => !p.endsWith('index.js'),
      stdout: collector(),
      stderr: errOut,
    });
    expect(code).toBe(1);
    expect(errOut.lines.join('')).toContain('npm run build');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('returns 0 and reports zero egress when no [NET-AUDIT] lines appear', async () => {
    const child = new FakeChild('exit-on-sigterm');
    const out = collector();
    const code = await runAuditNetwork({
      spawnImpl: vi.fn().mockReturnValue(child),
      exists: () => true,
      auditMs: 30,
      graceMs: 10,
      stdout: out,
      stderr: collector(),
    });
    expect(code).toBe(0);
    expect(out.lines.join('')).toContain('zero TCP/UDP outbound connections');
    expect(child.signals).toContain('SIGTERM');
  });

  it('returns 1 and lists the destinations when [NET-AUDIT] lines appear on child stderr', async () => {
    const child = new FakeChild('exit-on-sigterm');
    const spawnImpl = vi.fn().mockImplementation(() => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('[NET-AUDIT] tcp connect host=93.184.216.34 port=443\n'));
      });
      return child;
    });
    const out = collector();
    const code = await runAuditNetwork({
      spawnImpl,
      exists: () => true,
      auditMs: 30,
      graceMs: 10,
      stdout: out,
      stderr: collector(),
    });
    expect(code).toBe(1);
    expect(out.lines.join('')).toContain('tcp connect host=93.184.216.34 port=443');
  });
});

describe('aggregateExitCode', () => {
  it('returns 0 when every check is ok or skipped', () => {
    expect(aggregateExitCode([
      { status: 'ok' }, { status: 'ok' }, { status: 'skip' },
    ])).toBe(0);
  });

  it('returns 1 when there are warnings but nothing broken', () => {
    expect(aggregateExitCode([
      { status: 'ok' }, { status: 'warn' }, { status: 'ok' },
    ])).toBe(1);
  });

  it('returns 2 when any check failed, even alongside warnings', () => {
    expect(aggregateExitCode([
      { status: 'ok' }, { status: 'warn' }, { status: 'fail' },
    ])).toBe(2);
  });
});
