#!/usr/bin/env node
/**
 * neuromcp wiki-obsidian-bridge — make the neuromcp wiki graph light up in
 * Obsidian.
 *
 * Obsidian builds its graph from `[[wikilinks]]`, but the neuromcp wiki
 * records relationships as `related: [a, b, c]` in YAML frontmatter (which
 * Obsidian ignores for graphing). This bridge projects each page's `related`
 * list into a managed `## Related` section of `[[wikilinks]]` at the end of
 * the body, so the existing knowledge shows up as edges in Obsidian's graph.
 *
 * Design guarantees:
 *   - Idempotent: the managed block is delimited by HTML-comment markers and
 *     replaced in place on re-run — never duplicated.
 *   - Frontmatter byte-exact: the YAML block between the leading `---` fences
 *     is never rewritten; only the body's managed block changes.
 *   - Sanitized: related values are stripped of `[[` / `]]` and newlines so a
 *     malicious/garbled value cannot inject markup or break the link.
 *   - CRLF-safe: CRLF files stay CRLF; trailing newline is preserved.
 *
 * Usage:
 *   npx neuromcp-obsidian-bridge            # rewrite ~/.neuromcp/wiki
 *   npx neuromcp-obsidian-bridge --dry-run  # report, write nothing
 *   NEUROMCP_WIKI=/path npx neuromcp-obsidian-bridge
 */

import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BLOCK_START = '<!-- neuromcp:related:start -->';
const BLOCK_END = '<!-- neuromcp:related:end -->';

/**
 * Sanitize a single related value so it can safely sit inside `[[...]]`.
 * Strips wikilink brackets and collapses any whitespace (incl. newlines) to a
 * single space. Returns '' for values that reduce to nothing.
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeRelatedValue(raw) {
  return String(raw)
    .replace(/\[\[|\]\]/g, '') // no nested/broken wikilink brackets
    .replace(/[\r\n]+/g, ' ') // no newline injection
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse an inline YAML array like `[a, "b c", 'd]'`. Returns the list of raw
 * (unsanitized) string values. Handles single/double quotes and bare tokens.
 * @param {string} inner
 * @returns {string[]}
 */
export function parseInlineArray(inner) {
  /** @type {string[]} */
  const values = [];
  let i = 0;
  const n = inner.length;
  while (i < n) {
    // Skip separators / whitespace.
    while (i < n && (inner[i] === ',' || /\s/.test(inner[i]))) i++;
    if (i >= n) break;
    const ch = inner[i];
    if (ch === '"' || ch === "'") {
      // Quoted value — read until the matching quote.
      i++;
      let val = '';
      while (i < n && inner[i] !== ch) {
        val += inner[i];
        i++;
      }
      i++; // skip closing quote
      values.push(val);
    } else {
      // Bare token — read until the next comma.
      let val = '';
      while (i < n && inner[i] !== ',') {
        val += inner[i];
        i++;
      }
      values.push(val.trim());
    }
  }
  return values;
}

/**
 * Extract the `related:` inline-array values from a frontmatter block.
 * @param {string} frontmatter
 * @returns {string[] | null}
 */
function extractRelated(frontmatter) {
  for (const line of frontmatter.split('\n')) {
    const m = line.match(/^related:\s*\[(.*)\]\s*$/);
    if (m) return parseInlineArray(m[1]);
  }
  return null;
}

/**
 * Transform a single file's content string. Returns { content, changed }.
 * `content` is byte-for-byte identical to the input when nothing changes.
 * @param {string} input
 * @returns {{ content: string, changed: boolean }}
 */
export function transformContent(input) {
  // Detect and normalize line endings, remember to restore.
  const isCrlf = input.includes('\r\n');
  const text = isCrlf ? input.replace(/\r\n/g, '\n') : input;

  // Split off frontmatter (must start with '---\n' and have a closing '\n---\n').
  if (!text.startsWith('---\n')) {
    return { content: input, changed: false };
  }
  const fmEnd = text.indexOf('\n---\n', 4);
  if (fmEnd === -1) {
    return { content: input, changed: false };
  }
  const frontmatter = text.slice(4, fmEnd);
  const fmFull = text.slice(0, fmEnd + 5); // includes closing '---\n'
  let body = text.slice(fmEnd + 5);

  const related = extractRelated(frontmatter);

  // Strip any existing managed block from the body first (for idempotency and
  // for the "related removed" case).
  const strippedBody = stripManagedBlock(body);

  if (related === null || related.length === 0) {
    // No related list. If we previously wrote a block, removing it is a change.
    const rebuilt = restore(fmFull + strippedBody, isCrlf);
    const changed = rebuilt !== input;
    return { content: changed ? rebuilt : input, changed };
  }

  // Build the managed block from sanitized, de-duplicated values.
  /** @type {string[]} */
  const links = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const raw of related) {
    const clean = sanitizeRelatedValue(raw);
    if (clean.length === 0 || seen.has(clean)) continue;
    seen.add(clean);
    links.push(`- [[${clean}]]`);
  }
  if (links.length === 0) {
    const rebuilt = restore(fmFull + strippedBody, isCrlf);
    const changed = rebuilt !== input;
    return { content: changed ? rebuilt : input, changed };
  }

  const block =
    `${BLOCK_START}\n## Related\n\n${links.join('\n')}\n${BLOCK_END}`;

  // Append the block. Ensure exactly one blank line before it, and preserve a
  // single trailing newline.
  const bodyTrimmed = strippedBody.replace(/\s*$/, '');
  const assembled = `${fmFull}${bodyTrimmed}\n\n${block}\n`;
  const rebuilt = restore(assembled, isCrlf);
  return { content: rebuilt, changed: rebuilt !== input };
}

/**
 * Remove a previously-written managed block (and surrounding blank lines).
 * @param {string} body
 * @returns {string}
 */
function stripManagedBlock(body) {
  const startIdx = body.indexOf(BLOCK_START);
  if (startIdx === -1) return body;
  const endIdx = body.indexOf(BLOCK_END, startIdx);
  if (endIdx === -1) return body; // malformed; leave as-is
  const before = body.slice(0, startIdx).replace(/\s*$/, '');
  const after = body.slice(endIdx + BLOCK_END.length);
  return before + after;
}

/**
 * @param {string} text
 * @param {boolean} isCrlf
 * @returns {string}
 */
function restore(text, isCrlf) {
  return isCrlf ? text.replace(/\n/g, '\r\n') : text;
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'raw-sources' || name === 'node_modules') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile() && name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * Run the bridge over a directory tree. Returns { scanned, changed }.
 * When dryRun is true, no files are written.
 * @param {string} wikiDir
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{ scanned: number, changed: number }}
 */
export function runBridge(wikiDir, options = {}) {
  const dryRun = options.dryRun === true;
  const files = walk(wikiDir);
  let changed = 0;
  for (const file of files) {
    const input = readFileSync(file, 'utf8');
    const result = transformContent(input);
    if (result.changed) {
      changed++;
      if (!dryRun) writeFileSync(file, result.content, 'utf8');
    }
  }
  return { scanned: files.length, changed };
}

// ─── CLI ────────────────────────────────────────────────────────────
/** @returns {boolean} */
function isMain() {
  // Run the CLI when executed directly (either the script itself or the bin
  // wrapper), but NOT when imported by tests via a specifier.
  const invoked = process.argv[1] ?? '';
  return invoked.endsWith('wiki-obsidian-bridge.mjs') || invoked.endsWith('neuromcp-obsidian-bridge.mjs');
}

if (isMain()) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const wikiDir = process.env.NEUROMCP_WIKI || join(homedir(), '.neuromcp', 'wiki');
  if (!existsSync(wikiDir)) {
    process.stderr.write(`wiki dir not found: ${wikiDir}\n`);
    process.exit(1);
  }
  const { scanned, changed } = runBridge(wikiDir, { dryRun });
  const verb = dryRun ? 'would update' : 'updated';
  process.stdout.write(`neuromcp-obsidian-bridge: scanned ${scanned} file(s), ${verb} ${changed}.\n`);
}
