import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';
import { textResult } from './types.js';
import { wikiIngest, wikiLint, wikiBriefing } from '../tools/wiki.js';

export function registerWikiTools(server: McpServer, deps: ServerDeps): void {
  const { config, logger } = deps;

  server.registerTool('wiki_ingest', {
    description:
      'Read a file from the wiki raw-sources/ directory and extract structured metadata (title, type, key concepts, related pages). Returns analysis the LLM uses to decide which wiki pages to create or update. Does NOT write pages itself.',
    inputSchema: {
      filename: z.string().describe('Name of the file in raw-sources/ (e.g. "article.md")'),
    },
  }, (args) => {
    const result = wikiIngest(args, { config, logger });
    return textResult(result);
  });

  server.registerTool('wiki_lint', {
    description:
      'Scan all wiki pages and check for health issues: missing frontmatter, pages not in index.md, stale pages (>30 days), thin pages (<5 lines), unprocessed raw sources, broken related links. Writes lint-report.md.',
    inputSchema: {},
  }, () => {
    const result = wikiLint({ config, logger });
    return textResult(result);
  });

  server.registerTool('wiki_briefing', {
    description:
      'Generate a structured briefing from the wiki: active projects, unprocessed sources, recent changelog entries, stale pages needing attention. Use for morning status checks.',
    inputSchema: {
      days: z
        .number()
        .int()
        .min(1)
        .max(365)
        .optional()
        .describe('Lookback period in days (default: 7)'),
    },
  }, (args) => {
    const result = wikiBriefing(args, { config, logger });
    return textResult(result);
  });
}
