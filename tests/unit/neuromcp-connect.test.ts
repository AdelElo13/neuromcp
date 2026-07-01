import { describe, it, expect, vi } from 'vitest';

// @ts-expect-error — plain-ESM helper in bin/, no type declarations shipped
import { deriveHealthUrl, parseConnectArgs, waitForDaemon } from '../../bin/neuromcp-connect.mjs';

/**
 * Regression: on cold boot, stdio-only clients (Claude Desktop) spawn
 * `mcp-remote http://127.0.0.1:<port>/mcp` before the launchd daemon has
 * bound its port. mcp-remote exits fatally on ECONNREFUSED (no retry) and
 * the client gives up after a couple of attempts → permanent
 * "Server disconnected" until the user manually restarts the client.
 * Observed 72× in ~/Library/Logs/Claude/mcp-server-neuromcp.log; on
 * 2026-07-01 the daemon was listening 19s after Desktop's last attempt.
 *
 * Fix: `neuromcp-connect` waits for the daemon's /health endpoint (bounded
 * by a deadline that stays under the client's initialize timeout) before
 * exec'ing the mcp-remote bridge, and asks launchd to kickstart the daemon
 * if the first probe fails.
 */

describe('deriveHealthUrl', () => {
  it('maps the /mcp endpoint to /health on the same origin', () => {
    expect(deriveHealthUrl('http://127.0.0.1:33200/mcp')).toBe('http://127.0.0.1:33200/health');
  });

  it('preserves non-default host and port', () => {
    expect(deriveHealthUrl('http://localhost:3200/mcp')).toBe('http://localhost:3200/health');
  });

  it('drops query strings and fragments', () => {
    expect(deriveHealthUrl('http://127.0.0.1:3200/mcp?sid=abc#x')).toBe('http://127.0.0.1:3200/health');
  });

  it('throws on an unparseable URL', () => {
    expect(() => deriveHealthUrl('not a url')).toThrow(/invalid/i);
  });
});

describe('parseConnectArgs', () => {
  it('defaults to the daemon default port 3200 on loopback', () => {
    expect(parseConnectArgs([], {})).toEqual({ mcpUrl: 'http://127.0.0.1:3200/mcp' });
  });

  it('honours NEUROMCP_DAEMON_PORT and NEUROMCP_DAEMON_HOST from the environment', () => {
    expect(
      parseConnectArgs([], { NEUROMCP_DAEMON_PORT: '33200', NEUROMCP_DAEMON_HOST: '127.0.0.1' }),
    ).toEqual({ mcpUrl: 'http://127.0.0.1:33200/mcp' });
  });

  it('prefers an explicit URL argument over the environment', () => {
    expect(
      parseConnectArgs(['http://127.0.0.1:9999/mcp'], { NEUROMCP_DAEMON_PORT: '33200' }),
    ).toEqual({ mcpUrl: 'http://127.0.0.1:9999/mcp' });
  });

  it('rejects an invalid URL argument', () => {
    expect(() => parseConnectArgs(['33200'], {})).toThrow(/invalid/i);
  });

  it('rejects a non-numeric NEUROMCP_DAEMON_PORT', () => {
    expect(() => parseConnectArgs([], { NEUROMCP_DAEMON_PORT: 'abc' })).toThrow(/port/i);
  });
});

describe('waitForDaemon', () => {
  it('returns true immediately when the first probe succeeds (no sleep, no kickstart)', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const sleep = vi.fn();
    const kickstart = vi.fn();
    const ok = await waitForDaemon('http://127.0.0.1:3200/health', {
      probe, sleep, onFirstFailure: kickstart,
    });
    expect(ok).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
    expect(kickstart).not.toHaveBeenCalled();
  });

  it('kickstarts exactly once, keeps polling, and succeeds when the daemon comes up', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const kickstart = vi.fn().mockResolvedValue(undefined);
    const ok = await waitForDaemon('http://127.0.0.1:3200/health', {
      probe, sleep, onFirstFailure: kickstart, timeoutMs: 60_000, intervalMs: 2_000,
    });
    expect(ok).toBe(true);
    expect(kickstart).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('gives up and returns false once the deadline passes', async () => {
    let clock = 0;
    const probe = vi.fn().mockResolvedValue(false);
    const sleep = vi.fn().mockImplementation(async (ms: number) => { clock += ms; });
    const ok = await waitForDaemon('http://127.0.0.1:3200/health', {
      probe, sleep, timeoutMs: 10_000, intervalMs: 2_000, now: () => clock,
    });
    expect(ok).toBe(false);
    // 10s deadline / 2s interval → exactly 5 sleeps before giving up
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it('survives a throwing kickstart hook and keeps waiting', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const kickstart = vi.fn().mockRejectedValue(new Error('launchctl not available'));
    const ok = await waitForDaemon('http://127.0.0.1:3200/health', {
      probe, sleep, onFirstFailure: kickstart,
    });
    expect(ok).toBe(true);
  });
});
