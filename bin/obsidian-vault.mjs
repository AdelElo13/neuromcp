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
  if (!existsSync(appPath)) writeFileSync(appPath, JSON.stringify(APP_JSON, null, 2));
  if (!existsSync(pluginsPath)) writeFileSync(pluginsPath, JSON.stringify(CORE_PLUGINS, null, 2));
  return 'created';
}
