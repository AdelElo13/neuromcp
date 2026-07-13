import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

/**
 * Build-artifact guard for the boot-race fix.
 *
 * The whole point of `dist/daemon-bootstrap.js` is that it binds the daemon
 * port BEFORE the heavy module graph (MCP SDK, better-sqlite3, zod, …)
 * loads. tsup code-splitting decides at build time what ends up statically
 * imported by the bootstrap entry — a config regression could silently pull
 * the entire daemon core into the bootstrap's static graph and reintroduce
 * the ~100s cold-boot ECONNREFUSED window without any runtime test failing.
 *
 * This test walks the STATIC import graph of the built bootstrap entry and
 * asserts it stays dependency-free (node builtins only) and that the core
 * is reachable exclusively via dynamic import.
 *
 * The scanner is deliberately NOT line-anchored: minified ESM output puts
 * all imports on one line, and a guard whose parser goes blind would keep
 * PASSing while guarding nothing. A parser self-test on a minified fixture
 * plus canary assertions (the graph MUST contain a known builtin) keep the
 * guard honest.
 *
 * Requires a build (`npm run build`) — CI builds before running tests.
 */

const DIST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');
const BOOTSTRAP = join(DIST_DIR, 'daemon-bootstrap.js');

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

/**
 * Static `import ... from '...'` / `export ... from '...'` statements.
 * Anchored on statement boundaries (start of source, `;`, `}` or newline),
 * not on line starts, so single-line minified output still matches. The
 * import clause itself can never contain quotes or semicolons, which is
 * what `[^;'"]*?` relies on.
 */
const STATIC_FROM_RE = /(?:^|[;}\n])\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/g;
/** Bare side-effect imports: `import '...'` — same boundary logic. */
const SIDE_EFFECT_IMPORT_RE = /(?:^|[;}\n])\s*import\s*["']([^"']+)["']/g;
/** Dynamic imports: `import("...")` — inherently position-independent. */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

interface ScanResult {
  readonly staticSpecifiers: string[];
  readonly dynamicSpecifiers: string[];
}

function scanModuleSource(source: string): ScanResult {
  return {
    staticSpecifiers: [
      ...[...source.matchAll(STATIC_FROM_RE)].map((m) => m[1]!),
      ...[...source.matchAll(SIDE_EFFECT_IMPORT_RE)].map((m) => m[1]!),
    ],
    dynamicSpecifiers: [...source.matchAll(DYNAMIC_IMPORT_RE)].map((m) => m[1]!),
  };
}

interface StaticGraph {
  readonly externals: Set<string>;
  readonly relativeFiles: Set<string>;
  readonly dynamicSpecifiers: Set<string>;
}

function walkStaticGraph(entryFile: string): StaticGraph {
  const externals = new Set<string>();
  const relativeFiles = new Set<string>();
  const dynamicSpecifiers = new Set<string>();
  const pending = [entryFile];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (relativeFiles.has(file)) continue;
    relativeFiles.add(file);
    const scan = scanModuleSource(readFileSync(file, 'utf8'));

    for (const spec of scan.dynamicSpecifiers) dynamicSpecifiers.add(spec);
    for (const spec of scan.staticSpecifiers) {
      if (spec.startsWith('.')) {
        pending.push(resolve(dirname(file), spec));
      } else {
        externals.add(spec);
      }
    }
  }
  return { externals, relativeFiles, dynamicSpecifiers };
}

describe('import scanner (guard self-test)', () => {
  it('finds every import form in single-line minified output', () => {
    const minified =
      'import{a as b}from"./chunk-EARLY.js";import{z}from"zod";' +
      'import"./chunk-SIDE.js";export{q}from"./chunk-REEXPORT.js";' +
      'var x=1;async function go(){const m=await import("./daemon-core.js");return m}';
    const scan = scanModuleSource(minified);
    expect(scan.staticSpecifiers).toEqual(
      expect.arrayContaining(['./chunk-EARLY.js', 'zod', './chunk-SIDE.js', './chunk-REEXPORT.js']),
    );
    expect(scan.staticSpecifiers).toHaveLength(4);
    expect(scan.dynamicSpecifiers).toEqual(['./daemon-core.js']);
  });

  it('finds imports in multi-line (unminified) output', () => {
    const source = [
      "import {",
      "  createServer,",
      "} from 'node:http';",
      "import type_helper from './helper.js';",
      "const core = await import('./daemon-core.js');",
    ].join('\n');
    const scan = scanModuleSource(source);
    expect(scan.staticSpecifiers).toEqual(expect.arrayContaining(['node:http', './helper.js']));
    expect(scan.dynamicSpecifiers).toEqual(['./daemon-core.js']);
  });
});

describe('daemon-bootstrap build artifact stays lightweight', () => {
  it('dist/daemon-bootstrap.js exists (run `npm run build` first)', () => {
    expect(existsSync(BOOTSTRAP), `missing ${BOOTSTRAP} — run \`npm run build\``).toBe(true);
  });

  it('canary: the walked graph sees the known node:http import (parser is not blind)', () => {
    const graph = walkStaticGraph(BOOTSTRAP);
    // daemon-early-bind.ts imports node:http; whether tsup inlines it into
    // the entry or splits it into a chunk, the builtin import MUST surface
    // in the walked graph. If it does not, the scanner has gone blind and
    // every other assertion here is vacuous.
    const seesHttp = graph.externals.has('node:http') || graph.externals.has('http');
    expect(seesHttp, 'scanner no longer sees the bootstrap\'s node:http import — guard is blind').toBe(true);
  });

  it('static import graph of the bootstrap contains only node builtins', () => {
    const graph = walkStaticGraph(BOOTSTRAP);
    const nonBuiltin = [...graph.externals].filter((s) => !NODE_BUILTINS.has(s));
    expect(
      nonBuiltin,
      `bootstrap statically imports non-builtin packages — this reintroduces the boot race: ${nonBuiltin.join(', ')}`,
    ).toEqual([]);
  });

  it('daemon core is NOT in the static graph and IS reachable via dynamic import', () => {
    const graph = walkStaticGraph(BOOTSTRAP);
    const staticCore = [...graph.relativeFiles].filter((f) => f.endsWith('daemon-core.js'));
    expect(
      staticCore,
      'daemon-core.js must not be statically imported by the bootstrap',
    ).toEqual([]);
    const dynamicCore = [...graph.dynamicSpecifiers].some((s) => s.includes('daemon-core'));
    expect(dynamicCore, 'bootstrap must dynamically import the daemon core').toBe(true);
  });
});
