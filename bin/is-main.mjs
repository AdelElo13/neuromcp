/**
 * is-main.mjs — "was this file run directly?" that survives symlinks.
 *
 * The bug it fixes (v0.29.3): every CLI here used
 *
 *   if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
 *
 * `npm install -g` exposes each bin as a SYMLINK
 * (<prefix>/bin/neuromcp-doctor → ../lib/node_modules/neuromcp/bin/doctor.mjs).
 * Node resolves an ES module's `import.meta.url` through realpath, but leaves
 * `process.argv[1]` as the symlink path the user typed. The two never match,
 * so main() was never called: `neuromcp-doctor` printed NOTHING and exited 0.
 * Reproduced on npm 11.12.1 with a global install.
 *
 * Comparing realpaths on both sides fixes it while keeping the guard (tests
 * import these files for their pure helpers and must not trigger main()).
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} p
 * @returns {string}
 */
function realOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * @param {string} metaUrl - import.meta.url of the calling module
 * @param {string | undefined} [argv1] - process.argv[1] (injectable for tests)
 * @returns {boolean} true when the module is the process entrypoint
 */
export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (argv1 === undefined || argv1 === '') return false;
  let self;
  try {
    self = fileURLToPath(metaUrl);
  } catch {
    return false;
  }
  return realOrSelf(self) === realOrSelf(argv1);
}
