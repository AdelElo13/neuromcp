/**
 * resolve-node-bin — pick the most *stable* path to a node binary for
 * baking into a long-lived launchd plist.
 *
 * Why this exists: enable-daemon previously used process.execPath
 * verbatim. On Homebrew that realpath-resolves to a version-pinned Cellar
 * path, e.g. /opt/homebrew/Cellar/node@22/22.22.2_1/bin/node. Homebrew
 * deletes the old Cellar dir on `brew upgrade node@22`, so launchd can no
 * longer launch node — the daemon dies with EX_CONFIG and (because the
 * spawn fails before the process starts) never even writes a log line.
 * Homebrew maintains a version-independent symlink at
 * <prefix>/opt/node@22/bin/node which it re-points on every upgrade;
 * pointing the plist there survives patch bumps.
 *
 * Scope (deliberate):
 *  - Only *versioned* formulae (node@22, node@20, …) are rewritten. Their
 *    opt symlink stays within one Node major, so native-module ABIs
 *    (better-sqlite3, onnxruntime-node) survive `brew upgrade`. The
 *    unversioned `node` formula is left as-is: its opt symlink follows the
 *    latest major and could silently jump ABIs — worse than the keg pin.
 *  - The prefix is captured, not hardcoded, so /opt/homebrew (Apple
 *    Silicon), /usr/local (Intel), and custom `brew --prefix` installs all
 *    work. `/Cellar/` is Homebrew-specific, so nvm/fnm/asdf/Volta paths do
 *    not match and pass through unchanged.
 *  - The opt target is accepted only if it is actually executable; on any
 *    doubt we fall back to the original path rather than emit a dead one.
 */
import { accessSync, constants } from 'node:fs';

// <prefix>/Cellar/node@<major>/<version>/bin/node  (prefix + formula captured)
const BREW_CELLAR_NODE = /^(\/.+?)\/Cellar\/(node@\d+)\/[^/]+\/bin\/node$/;

function defaultIsExecutable(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} nodePath - absolute path to a node binary (e.g. process.execPath)
 * @param {{ isExecutable?: (p: string) => boolean }} [deps] - fs boundary, injectable for tests
 * @returns {string} a stable node path when one is known to be executable, else nodePath unchanged
 */
export function resolveStableNodeBin(nodePath, deps = {}) {
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  if (typeof nodePath !== 'string') return nodePath;

  const match = nodePath.match(BREW_CELLAR_NODE);
  if (match === null) return nodePath;

  const [, brewPrefix, formula] = match;
  const optPath = `${brewPrefix}/opt/${formula}/bin/node`;
  return isExecutable(optPath) ? optPath : nodePath;
}
