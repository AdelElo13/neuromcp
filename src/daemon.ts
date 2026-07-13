#!/usr/bin/env node
/**
 * neuromcp daemon — direct entrypoint (no early port bind).
 *
 * Back-compat shim for configs that import `dist/daemon.js` directly.
 * Prefer `bin/neuromcp-daemon.mjs`, which loads `daemon-bootstrap.js`:
 * that entry binds the TCP port within milliseconds of process start and
 * buffers requests while this module graph loads — the fix for the
 * cold-boot ECONNREFUSED race ("Could not attach to MCP server neuromcp").
 * This direct entry only binds AFTER the full module graph has loaded.
 */
import { runDaemon } from './daemon-core.js';

runDaemon().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fatal error: ${message}\n`);
  if (error instanceof Error && error.stack !== undefined) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
});
