/**
 * daemon-port.mjs — ONE definition of "where is the daemon configured?",
 * shared by every CLI that needs to find it (doctor, connect).
 *
 * On a standard `enable-daemon` install the port lives in the launchd
 * plist's EnvironmentVariables, NOT in the user's interactive shell. Tools
 * that only read the env probed the default 3200 and treated a healthy
 * daemon on 33200 as absent — a false diagnosis in the doctor, and a
 * functional 55s hang in neuromcp-connect (Claude Desktop launches it
 * without a login environment).
 *
 * Resolution order: explicit env var (a valid value always wins) → the
 * launchd plist (darwin-only, silent fallback) → the default 3200.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir, platform } from 'node:os';

export const DEFAULT_DAEMON_PORT = 3200;

const DAEMON_PLIST_PATH = resolve(
  homedir(), 'Library', 'LaunchAgents', 'com.neuromcp.daemon.plist',
);

/**
 * Port from the launchd plist's EnvironmentVariables, or null when the
 * platform is not darwin (launchd + plutil are macOS concepts — a migrated
 * home directory elsewhere must not decide the port), or when the plist,
 * the key, or plutil is unavailable, or the value is out of range.
 *
 * @param {{
 *   exec?: (cmd: string, args: string[]) => string,
 *   exists?: (p: string) => boolean,
 *   plistPath?: string,
 *   osPlatform?: string,
 * }} [deps]
 * @returns {number | null}
 */
export function readLaunchdDaemonPort(deps = {}) {
  const {
    exists = existsSync,
    plistPath = DAEMON_PLIST_PATH,
    osPlatform = platform(),
    exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  } = deps;
  if (osPlatform !== 'darwin') return null;
  if (!exists(plistPath)) return null;
  try {
    const raw = exec('plutil', [
      '-extract', 'EnvironmentVariables.NEUROMCP_DAEMON_PORT', 'raw', '-o', '-', plistPath,
    ]).trim();
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

/**
 * @typedef {{ port: number, source: 'env' | 'plist' | 'default' }} ResolvedDaemonPort
 */

/**
 * Resolve the daemon port AND say where it came from, so diagnostics can
 * show WHY a non-default port was probed.
 *
 * @param {Record<string, string | undefined>} env
 * @param {() => number | null} [plistPort]
 * @returns {ResolvedDaemonPort}
 */
export function resolveDaemonPortWithSource(env, plistPort = readLaunchdDaemonPort) {
  const raw = env.NEUROMCP_DAEMON_PORT;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) return { port: n, source: 'env' };
  }
  let fromPlist = null;
  try {
    fromPlist = plistPort();
  } catch {
    /* diagnostic fallback only */
  }
  if (fromPlist !== null) return { port: fromPlist, source: 'plist' };
  return { port: DEFAULT_DAEMON_PORT, source: 'default' };
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {() => number | null} [plistPort]
 * @returns {number}
 */
export function resolveDaemonPort(env, plistPort = readLaunchdDaemonPort) {
  return resolveDaemonPortWithSource(env, plistPort).port;
}
