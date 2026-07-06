# Viewing the neuromcp wiki as an Obsidian graph

The neuromcp wiki (`~/.neuromcp/wiki`) is plain Markdown, so you can open it
directly as an [Obsidian](https://obsidian.md) vault. Obsidian builds its graph
view from `[[wikilinks]]`, but neuromcp records relationships in YAML
frontmatter (`related: [a, b, c]`), which Obsidian ignores for graphing.

The **obsidian bridge** projects each page's `related` list into a managed
`## Related` section of `[[wikilinks]]`, so your existing knowledge lights up as
edges in Obsidian's graph — without changing what neuromcp stores.

## Usage

```bash
# Preview what would change (writes nothing)
npx neuromcp-obsidian-bridge --dry-run

# Rewrite ~/.neuromcp/wiki in place
npx neuromcp-obsidian-bridge

# Point at a different vault
NEUROMCP_WIKI=/path/to/wiki npx neuromcp-obsidian-bridge
```

Then open `~/.neuromcp/wiki` as a vault in Obsidian and toggle the graph view.

## What it does (and does not) touch

- **Idempotent.** The managed block is delimited by HTML-comment markers
  (`<!-- neuromcp:related:start -->` … `<!-- neuromcp:related:end -->`) and is
  replaced in place on every run — never duplicated. Re-running after no
  changes reports `updated 0`.
- **Frontmatter is byte-exact.** The YAML block between the leading `---`
  fences is never rewritten; only the body's managed block changes.
- **Sanitized.** `related` values are stripped of `[[` / `]]` and any newlines
  before being wrapped in `[[...]]`, so a garbled value cannot inject markup or
  break a link.
- **CRLF-safe.** CRLF files stay CRLF; the trailing newline is preserved.
- **Scope.** Only `*.md` files are processed. `raw-sources/`, dotfiles, and
  `node_modules/` are skipped.

## Keeping it in sync

Re-run the bridge whenever the wiki's `related:` fields change (for example
after a consolidation pass). It only rewrites files whose managed block would
differ, so it is cheap to run often — e.g. from a scheduled task alongside the
nightly consolidation.
