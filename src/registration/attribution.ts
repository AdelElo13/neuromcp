import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';
import { textResult } from './types.js';
import { logRetrieval, citeMemories, usefulnessStats } from '../tools/attribution.js';

export function registerAttributionTools(server: McpServer, deps: ServerDeps): void {
  const { db, logger } = deps;

  server.registerTool('log_retrieval', {
    description:
      'Log a retrieval event so future searches can learn which memories are actually helpful. ' +
      'Call right after search_memory. Pass retrieved_ids (all top-K), cited_ids (those actually used in the answer, if known), ' +
      'and an outcome label (helpful/neutral/harmful). Usefulness scores are applied as a prior in future rankings.',
    inputSchema: {
      query: z.string().describe('The user query that triggered the search'),
      namespace: z.string().optional(),
      retrieved_ids: z.array(z.string()).describe('All memory IDs returned from the search'),
      cited_ids: z.array(z.string()).optional().describe('Memory IDs actually used in the answer'),
      outcome: z.enum(['helpful', 'neutral', 'harmful']).optional(),
      critic_reason: z.string().optional().describe('Short reason for the outcome label'),
      model: z.string().optional().describe('Model that produced the answer'),
    },
  }, (args) => {
    const result = logRetrieval(args, { db, logger });
    return textResult(result);
  });

  server.registerTool('cite_memories', {
    description:
      'Attach a late verdict to a previously-logged retrieval event. Use when the agent answers first and a critic scores the answer afterward. ' +
      'Updates the memory_usefulness prior based on which retrieved memories were cited + outcome.',
    inputSchema: {
      event_id: z.string().describe('retrieval event id returned by log_retrieval'),
      cited_ids: z.array(z.string()).describe('Memory IDs actually used in the answer'),
      outcome: z.enum(['helpful', 'neutral', 'harmful']).optional(),
      critic_reason: z.string().optional(),
    },
  }, (args) => {
    const result = citeMemories(args, { db, logger });
    return textResult(result);
  });

  server.registerTool('usefulness_stats', {
    description:
      'List memories ranked by observed usefulness (helpful vs harmful citation ratio). ' +
      'Use to inspect which memories the agent actually leans on, or to pick high-confidence source material for reflection.',
    inputSchema: {
      namespace: z.string().optional(),
      min_observations: z.number().int().min(1).optional().describe('Minimum observation count (default 1)'),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, (args) => {
    const result = usefulnessStats(args, { db });
    return textResult(result);
  });
}
