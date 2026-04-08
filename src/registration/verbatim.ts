import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';
import { textResult } from './types.js';
import { storeVerbatim, searchVerbatim, verbatimStats } from '../tools/verbatim.js';

export function registerVerbatimTools(server: McpServer, deps: ServerDeps): void {
  const { db, config, logger, metrics } = deps;

  server.registerTool('store_verbatim', {
    description: 'Store raw conversation text verbatim — no summarization, no consolidation, never pruned. Use for exact recall of what was said.',
    inputSchema: {
      content: z.string().describe('Raw text to store verbatim'),
      namespace: z.string().optional().describe('Namespace (default: config default)'),
      agent_id: z.string().optional().describe('Agent that produced this text'),
      episode_id: z.string().optional().describe('Episode to associate with'),
      metadata: z.record(z.unknown()).optional().describe('Arbitrary metadata'),
    },
  }, (args) => {
    const result = storeVerbatim(args, db, config, logger, metrics);
    return textResult(result);
  });

  server.registerTool('search_verbatim', {
    description: 'Search raw verbatim text using full-text search. Returns exact matches from stored conversations. Use for literal recall.',
    inputSchema: {
      query: z.string().describe('Search query'),
      namespace: z.string().optional().describe('Namespace filter (default: config default, "*" for all)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 10)'),
      after: z.string().optional().describe('Only entries after this ISO timestamp'),
      before: z.string().optional().describe('Only entries before this ISO timestamp'),
      episode_id: z.string().optional().describe('Filter by episode'),
      agent_id: z.string().optional().describe('Filter by agent'),
    },
  }, (args) => {
    const results = searchVerbatim(args, db, config, logger, metrics);
    return textResult(results);
  });

  server.registerTool('verbatim_stats', {
    description: 'Get statistics about verbatim storage: total entries, size, and distribution by namespace.',
    inputSchema: {
      namespace: z.string().optional().describe('Namespace filter (default: config default, "*" for all)'),
    },
  }, (args) => {
    const stats = verbatimStats(db, config, args.namespace);
    return textResult(stats);
  });
}
