/**
 * obsidian-vault — seed a minimal `.obsidian/` config in the neuromcp wiki
 * so a first "Open folder as vault" in Obsidian lands on a useful graph
 * (graph/backlink plugins pre-enabled).
 *
 * HARD SAFETY RULE: this is NON-DESTRUCTIVE. If the user already opened the
 * wiki as an Obsidian vault (a `.obsidian/` dir exists — their own graph
 * settings, plugins, appearance, hotkeys), we do NOTHING and never touch a
 * single file. We also never write to any vault other than
 * `~/.neuromcp/wiki` and never touch Obsidian's global vault registry.
 */
import {
  existsSync as _existsSync,
  mkdirSync as _mkdirSync,
  writeFileSync as _writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const APP_JSON = { attachmentFolderPath: '', alwaysUpdateLinks: true };
const CORE_PLUGINS = ['graph', 'backlink', 'outgoing-link', 'tag-pane', 'file-explorer', 'search'];

// Colour the Obsidian graph by wiki category folder out-of-the-box —
// Obsidian's graph is monochrome by default (colours only come from
// "Groups"). These map the neuromcp wiki's top-level folders to distinct
// hues so the graph is readable on first open. `rgb` is Obsidian's packed
// integer colour (0xRRGGBB).
const GRAPH_JSON = {
  colorGroups: [
    { query: 'path:projects/', color: { a: 1, rgb: 0x4c8dff } },   // blue
    { query: 'path:people/', color: { a: 1, rgb: 0x3cb371 } },     // green
    { query: 'path:systems/', color: { a: 1, rgb: 0xe8912d } },    // orange
    { query: 'path:patterns/', color: { a: 1, rgb: 0xa46be0 } },   // purple
    { query: 'path:decisions/', color: { a: 1, rgb: 0xe0533b } },  // red
    { query: 'path:skills/', color: { a: 1, rgb: 0x2db5b5 } },     // teal
  ],
  showTags: false,
  showAttachments: false,
};

/**
 * @param {string} wikiDir Absolute path to the neuromcp wiki directory.
 * @param {{
 *   existsSync?: (p: string) => boolean,
 *   mkdirSync?: (p: string, opts?: object) => void,
 *   writeFileSync?: (p: string, data: string) => void,
 * }} [deps] Injectable fs boundary for tests.
 * @returns {'created' | 'skipped'} 'skipped' when a .obsidian/ already exists
 *   (user setup preserved), 'created' when a fresh minimal config was written.
 */
export function seedObsidianVault(wikiDir, deps = {}) {
  const existsSync = deps.existsSync ?? _existsSync;
  const mkdirSync = deps.mkdirSync ?? _mkdirSync;
  const writeFileSync = deps.writeFileSync ?? _writeFileSync;

  const dir = join(wikiDir, '.obsidian');
  // Existing vault → hands off entirely. This is the safety guarantee.
  if (existsSync(dir)) return 'skipped';

  mkdirSync(dir, { recursive: true });
  // Belt-and-braces file-level guards: even if the dir was created empty by
  // something else between the check and here, never clobber an existing file.
  const appPath = join(dir, 'app.json');
  const pluginsPath = join(dir, 'core-plugins.json');
  const graphPath = join(dir, 'graph.json');
  if (!existsSync(appPath)) writeFileSync(appPath, JSON.stringify(APP_JSON, null, 2));
  if (!existsSync(pluginsPath)) writeFileSync(pluginsPath, JSON.stringify(CORE_PLUGINS, null, 2));
  if (!existsSync(graphPath)) writeFileSync(graphPath, JSON.stringify(GRAPH_JSON, null, 2));
  return 'created';
}
