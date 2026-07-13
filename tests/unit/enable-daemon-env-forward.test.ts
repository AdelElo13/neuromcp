import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `bin/enable-daemon.mjs` auto-forwards every NEUROMCP_* var from the
 * installing shell into the launchd plist's EnvironmentVariables. That is a
 * feature for real config — and a trap for test-only seams: a developer who
 * exports NEUROMCP_TEST_INIT_DELAY_MS to reproduce the boot race and then
 * runs `neuromcp-enable-daemon` in the same shell would bake a permanent
 * startup delay into every daemon boot (surfacing as /health 503 "starting"
 * for the full delay, past neuromcp-connect's wait deadline).
 *
 * The script is a side-effectful CLI (runs on import), so this pins the
 * suppress-list at source level — same approach as the workflow-file tests.
 */

const ENABLE_DAEMON = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../bin/enable-daemon.mjs',
);

describe('enable-daemon env auto-forward suppress list', () => {
  const source = readFileSync(ENABLE_DAEMON, 'utf8');

  it('suppresses the NEUROMCP_TEST_INIT_DELAY_MS test seam so it can never be baked into the plist', () => {
    const suppressBlock = source.match(/const SUPPRESS_KEYS = new Set\(\[([\s\S]*?)\]\)/);
    expect(suppressBlock, 'SUPPRESS_KEYS set must exist in enable-daemon.mjs').not.toBeNull();
    expect(suppressBlock![1]).toContain('NEUROMCP_TEST_INIT_DELAY_MS');
  });
});
