import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Read version from package.json at module load time. This is the single
// source of truth — no hardcoded version strings anywhere else in src/.
// Reviewer round-3 (2026-04-24): previously three hardcoded strings drifted
// out of sync (0.18.3 in index startup log, 0.18.3 in resources, 0.19.0 in
// server handshake). Never again.

function resolvePackageJson(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up from src/ or dist/ to find package.json.
  const candidates = [
    join(here, '..', 'package.json'),
    join(here, '..', '..', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      readFileSync(p, 'utf8');
      return p;
    } catch {
      // try next
    }
  }
  throw new Error('neuromcp: could not locate package.json for version lookup');
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolvePackageJson(), 'utf8')) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch {
    // fall through
  }
  return 'unknown';
}

export const NEUROMCP_VERSION: string = readVersion();
