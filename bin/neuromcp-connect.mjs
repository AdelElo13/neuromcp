#!/usr/bin/env node
/**
 * neuromcp-connect — stdio bridge to the shared neuromcp daemon, with
 * boot-race protection for stdio-only MCP clients (Claude Desktop, …).
 *
 * The problem this solves: on a cold boot, launchd starts the daemon at
 * login but node + module loading can take 60–90s under boot I/O
 * contention. Claude Desktop spawns its MCP servers within seconds of
 * login, and the plain `npx -y mcp-remote http://…/mcp` bridge exits
 * fatally on ECONNREFUSED — no retry. Desktop gives up after a couple of
 * attempts and shows "Server disconnected" until the user manually
 * restarts it. (Observed 72× on the reference machine; on 2026-07-01 the
 * daemon was listening 19 seconds after Desktop's final attempt.)
 *
 * The fix: wait for the daemon's /health endpoint (bounded, staying under
 * the client's initialize timeout) before exec'ing the mcp-remote bridge.
 * If the first probe fails, ask launchd to kickstart the daemon — that
 * also self-heals the "daemon crashed and ThrottleInterval is holding it
 * back" case.
 *
 * Usage (Claude Desktop config):
 *   { "command": "npx", "args": ["-y", "--package=neuromcp", "neuromcp-connect", "http://127.0.0.1:3200/mcp"] }
 * or with a global install:
 *   { "command": "neuromcp-connect", "args": ["http://127.0.0.1:3200/mcp"] }
 *
 * With no argument the URL is derived from NEUROMCP_DAEMON_HOST /
 * NEUROMCP_DAEMON_PORT, falling back to http://127.0.0.1:3200/mcp
 * (enable-daemon's default port).
 */

import { spawn, execFile } from 'node:child_process';
import { platform } from 'node:os';
import { pathToFileURL } from 'node:url';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3200;
// Claude Desktop tolerates roughly 60s before it abandons an MCP server's
// initialize. Stay under that so a slow boot resolves within one attempt.
const DEFAULT_TIMEOUT_MS = 55_000;
const DEFAULT_INTERVAL_MS = 2_000;
const PROBE_TIMEOUT_MS = 2_000;
const LAUNCHD_LABEL = 'com.neuromcp.daemon';

/**
 * @param {string} mcpUrl - the daemon MCP endpoint (e.g. http://127.0.0.1:3200/mcp)
 * @returns {string} the /health URL on the same origin
 */
export function deriveHealthUrl(mcpUrl) {
  let parsed;
  try {
    parsed = new URL(mcpUrl);
  } catch {
    throw new Error(`invalid daemon URL: ${mcpUrl}`);
  }
  return `${parsed.origin}/health`;
}

/**
 * @param {string[]} argv - positional args (an optional MCP URL)
 * @param {Record<string, string | undefined>} env - process environment
 * @returns {{ mcpUrl: string }}
 */
export function parseConnectArgs(argv, env) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length > 0) {
    const raw = positional[0];
    try {
      // Round-trip through URL to reject non-URL strings early with a
      // clear message instead of letting mcp-remote fail obscurely.
      new URL(raw);
    } catch {
      throw new Error(`invalid daemon URL argument: ${raw}`);
    }
    return { mcpUrl: raw };
  }

  const host = env.NEUROMCP_DAEMON_HOST ?? DEFAULT_HOST;
  const rawPort = env.NEUROMCP_DAEMON_PORT;
  let port = DEFAULT_PORT;
  if (rawPort !== undefined) {
    const n = Number(rawPort);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(`invalid NEUROMCP_DAEMON_PORT: ${rawPort}`);
    }
    port = n;
  }
  return { mcpUrl: `http://${host}:${port}/mcp` };
}

async function defaultProbe(healthUrl) {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ask launchd to start the daemon if it is not running. Without -k this
// is a no-op for an already-running service, so it is safe to fire
// blindly. Errors (non-macOS, label not installed) are swallowed by the
// caller — the poll loop remains the source of truth.
function defaultKickstart() {
  if (platform() !== 'darwin') return Promise.resolve();
  return new Promise((resolve) => {
    execFile('id', ['-u'], (idErr, uid) => {
      if (idErr) return resolve(undefined);
      execFile('launchctl', ['kickstart', `gui/${uid.trim()}/${LAUNCHD_LABEL}`], () => resolve(undefined));
    });
  });
}

/**
 * Poll the daemon health endpoint until it responds or the deadline passes.
 *
 * @param {string} healthUrl
 * @param {{
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   probe?: (url: string) => Promise<boolean>,
 *   sleep?: (ms: number) => Promise<void>,
 *   onFirstFailure?: () => Promise<void>,
 *   now?: () => number,
 * }} [deps] - injectable boundaries for tests
 * @returns {Promise<boolean>} true when the daemon answered within the deadline
 */
export async function waitForDaemon(healthUrl, deps = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
    probe = defaultProbe,
    sleep = defaultSleep,
    onFirstFailure = null,
    now = Date.now,
  } = deps;

  const deadline = now() + timeoutMs;
  let firstFailureHandled = false;

  for (;;) {
    if (await probe(healthUrl)) return true;
    if (!firstFailureHandled) {
      firstFailureHandled = true;
      if (onFirstFailure) {
        try {
          await onFirstFailure();
        } catch {
          // Kickstart is best-effort; the poll loop decides the outcome.
        }
      }
    }
    if (now() + intervalMs > deadline) return false;
    await sleep(intervalMs);
  }
}

async function main() {
  let mcpUrl;
  try {
    ({ mcpUrl } = parseConnectArgs(process.argv.slice(2), process.env));
  } catch (err) {
    console.error(`neuromcp-connect: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const healthUrl = deriveHealthUrl(mcpUrl);
  const ready = await waitForDaemon(healthUrl, { onFirstFailure: defaultKickstart });
  if (!ready) {
    // Fall through anyway: mcp-remote surfaces the real connection error
    // to the client log, which is more actionable than dying silently here.
    console.error(
      `neuromcp-connect: daemon not reachable at ${healthUrl} after ${DEFAULT_TIMEOUT_MS / 1000}s — ` +
      `handing off to mcp-remote (it will report the connection error). ` +
      `Check: launchctl print gui/$(id -u)/${LAUNCHD_LABEL}`,
    );
  }

  const child = spawn('npx', ['-y', 'mcp-remote', mcpUrl], { stdio: 'inherit' });
  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // Child already gone; nothing to forward.
    }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
  child.on('error', (err) => {
    console.error(`neuromcp-connect: failed to spawn mcp-remote: ${err.message}`);
    process.exit(1);
  });
}

// Direct-invocation guard: run main() only when this file is the
// entrypoint, so tests can import the pure helpers without side effects.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
