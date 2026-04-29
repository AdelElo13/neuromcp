import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Per-process "active episode" state — Bug #7 fix (v0.21.0).
 *
 * Problem solved:
 *   `start_episode({title:"X"})` returned id 9fe… but a subsequent
 *   `store_memory(...)` without an explicit `episode_id` would attach to
 *   an ambient episode (8e5a…), not to "X". Users have no way to say
 *   "the next stores belong to the episode I just started" without
 *   threading episode_id through every call.
 *
 * Fix:
 *   `start_episode` writes to ~/.neuromcp/active-episode.json with
 *   `{episode_id, started_at, pid, namespace}`. Subsequent
 *   `store_memory` calls without explicit `episode_id` consult this
 *   file before falling back to `ensureAmbientEpisode`.
 *
 * Robustness:
 *   - Stale state (process gone) is detected on read via pid liveness
 *     check; stale entries are ignored (and silently cleaned).
 *   - Namespace mismatch: if the active episode was started in
 *     namespace A but a store happens in B, we do NOT attach
 *     cross-namespace — fall back to ambient in B.
 *   - File path is overridable via `setActiveStateDir(dir)` for tests
 *     and via env `NEUROMCP_STATE_DIR` for non-default deployments.
 */

export interface ActiveEpisode {
  readonly episode_id: string;
  readonly started_at: string;
  readonly pid: number;
  readonly namespace: string;
}

const FILE_NAME = 'active-episode.json';

let configuredDir: string | null = null;

/** Override the state dir (tests; opt-in deployments). */
export function setActiveStateDir(dir: string | null): void {
  configuredDir = dir;
}

function stateDir(): string {
  if (configuredDir !== null) return configuredDir;
  const fromEnv = process.env.NEUROMCP_STATE_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.neuromcp');
}

function statePath(): string {
  return join(stateDir(), FILE_NAME);
}

function isPidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    // Signal 0 doesn't kill — it just probes.
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EPERM') {
      // Process exists, just owned by another user. Treat as alive.
      return true;
    }
    return false;
  }
}

/** Write the active episode marker. Atomic write (write to .tmp then rename). */
export function writeActive(episode: ActiveEpisode): void {
  const dir = stateDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = statePath();
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(episode, null, 2), { mode: 0o600 });
  // rename is atomic on POSIX
  const fs = (() => { try { return require('node:fs'); } catch { return null; } })();
  if (fs !== null) {
    fs.renameSync(tmp, path);
  } else {
    writeFileSync(path, JSON.stringify(episode, null, 2), { mode: 0o600 });
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * Read the active episode. Returns null when:
 *   - state file does not exist;
 *   - state file is malformed;
 *   - the recorded pid is no longer alive (treated as crashed-out
 *     stale state; we silently delete it).
 */
export function readActive(): ActiveEpisode | null {
  const path = statePath();
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed file — clear it.
    try { unlinkSync(path); } catch { /* ignore */ }
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.episode_id !== 'string' ||
    typeof obj.started_at !== 'string' ||
    typeof obj.pid !== 'number' ||
    typeof obj.namespace !== 'string'
  ) {
    return null;
  }
  const ep: ActiveEpisode = {
    episode_id: obj.episode_id,
    started_at: obj.started_at,
    pid: obj.pid,
    namespace: obj.namespace,
  };
  if (!isPidAlive(ep.pid)) {
    // Crashed process — clean up.
    try { unlinkSync(path); } catch { /* ignore */ }
    return null;
  }
  return ep;
}

/** Clear the active marker (e.g. on `end_episode` of the active id). */
export function clearActive(matchEpisodeId?: string): void {
  const path = statePath();
  if (!existsSync(path)) return;
  if (matchEpisodeId === undefined) {
    try { unlinkSync(path); } catch { /* ignore */ }
    return;
  }
  const cur = readActive();
  if (cur !== null && cur.episode_id === matchEpisodeId) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

/**
 * Resolve the episode_id to attach a memory to, given the caller's
 * namespace. Returns the active id IFF it was started in the same
 * namespace by a still-alive process. Returns null otherwise — caller
 * should fall back to ambient.
 */
export function activeEpisodeForNamespace(namespace: string): string | null {
  const cur = readActive();
  if (cur === null) return null;
  if (cur.namespace !== namespace) return null;
  return cur.episode_id;
}
