#!/usr/bin/env node
/**
 * neuromcp daemon — bootstrap entrypoint (boot-race fix).
 *
 * Binds the daemon port IMMEDIATELY, then loads the heavy daemon core via
 * dynamic import and hands the listening server over. Requests that arrive
 * while the core is still loading are buffered and replayed — instead of
 * ECONNREFUSED during the ~100s cold-boot module-load window that made MCP
 * clients show "Could not attach to MCP server neuromcp".
 *
 * KEEP THIS DEPENDENCY-FREE: static imports limited to node builtins and
 * `./daemon-early-bind.js`. Anything heavier reintroduces the race.
 */
import { startEarlyBind, readPortFromEnv, validateHost } from './daemon-early-bind.js';

async function main(): Promise<void> {
  const port = readPortFromEnv('NEUROMCP_DAEMON_PORT', 3200);
  const host = process.env.NEUROMCP_DAEMON_HOST ?? '127.0.0.1';
  validateHost(host);

  const handle = await startEarlyBind({
    port,
    host,
    importCore: () => import('./daemon-core.js'),
  });
  // Propagate core load/start failures to the fatal handler below; the
  // early-bind layer has already flushed queued requests with 503 and
  // released the port by the time this rejects.
  await handle.core;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal error: ${message}\n`);
  if (error instanceof Error && error.stack !== undefined) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});
