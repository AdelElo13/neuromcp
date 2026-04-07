import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';
import { textResult } from './types.js';
import { registerAgent, findExpert, agentConflicts } from '../tools/agent.js';
import { getReviewQueue, reviewMemory, initReviewSchedule } from '../cognitive/spaced-repetition.js';
import { compressMemories } from '../consolidation/compress.js';
import { findTransferable, transferMemories } from '../tools/transfer.js';

export function registerAgentTools(server: McpServer, deps: ServerDeps): void {
  const { db, vecStore, embedder, config } = deps;

  server.registerTool('register_agent', {
    description: 'Register or update an agent profile with expertise topics. Auto-counts memories.',
    inputSchema: {
      agent_id: z.string().describe('Unique agent identifier'),
      name: z.string().describe('Agent display name'),
      namespace: z.string().optional(),
      expertise: z.array(z.string()).optional().describe('Topic expertise tags'),
      metadata: z.record(z.unknown()).optional(),
    },
  }, (args) => textResult(registerAgent(db, args, config.defaultNamespace)));

  server.registerTool('find_expert', {
    description: 'Find agents with expertise matching a query topic.',
    inputSchema: {
      query: z.string().describe('Topic to find experts for'),
      namespace: z.string().optional(),
      limit: z.number().int().optional(),
    },
  }, (args) => textResult(findExpert(db, args.query, args.namespace ?? config.defaultNamespace, args.limit)));

  server.registerTool('agent_conflicts', {
    description: 'Find conflicting knowledge between different agents on the same topic.',
    inputSchema: {
      namespace: z.string().optional(),
      topic: z.string().optional().describe('Narrow to a specific topic'),
    },
  }, (args) => textResult(agentConflicts(db, args.namespace ?? config.defaultNamespace, args.topic)));

  // ─── Spaced Repetition ─────────────────────────────────────────────

  server.registerTool('review_queue', {
    description: 'Get memories due for spaced repetition review. Returns overdue memories ordered by urgency + importance.',
    inputSchema: {
      namespace: z.string().optional(),
      limit: z.number().int().optional(),
      min_importance: z.number().optional(),
    },
  }, (args) => textResult(getReviewQueue(db, args.namespace ?? config.defaultNamespace, args)));

  server.registerTool('review_memory', {
    description: 'Record a review of a memory. Quality 0-5 (SM-2 scale: 0=forgot, 5=perfect). Updates interval and schedules next review.',
    inputSchema: {
      memory_id: z.string().describe('Memory to review'),
      quality: z.number().int().min(0).max(5).describe('Recall quality (0=forgot, 5=perfect)'),
    },
  }, (args) => textResult(reviewMemory(db, args.memory_id, args.quality)));

  server.registerTool('init_reviews', {
    description: 'Initialize spaced repetition for important memories that do not have a review schedule yet.',
    inputSchema: {
      namespace: z.string().optional(),
      min_importance: z.number().optional().describe('Minimum importance to include (default: 0.5)'),
    },
  }, (args) => {
    const count = initReviewSchedule(db, args.namespace ?? config.defaultNamespace, args.min_importance);
    return textResult({ initialized: count });
  });

  // ─── Compression ───────────────────────────────────────────────────

  server.registerTool('compress_memories', {
    description: 'Compress old similar memories into digest memories. Reduces DB size while preserving knowledge. Hard-deletes ancient zero-access tombstones.',
    inputSchema: {
      namespace: z.string().optional(),
      age_days: z.number().optional().describe('Compress memories older than N days (default: 30)'),
      min_cluster: z.number().int().optional().describe('Minimum cluster size for compression (default: 3)'),
      threshold: z.number().optional().describe('Similarity threshold for clustering (default: 0.80)'),
    },
  }, async (args) => {
    const result = await compressMemories(db, embedder, vecStore, args.namespace ?? config.defaultNamespace, {
      ageDays: args.age_days, minCluster: args.min_cluster, threshold: args.threshold,
    });
    return textResult(result);
  });

  // ─── Cross-Namespace Transfer ──────────────────────────────────────

  server.registerTool('find_transferable', {
    description: 'Find memories in a source namespace that could be useful in a target namespace. Scores by transferability (universal vs project-specific).',
    inputSchema: {
      source_namespace: z.string().describe('Source namespace'),
      target_namespace: z.string().describe('Target namespace'),
      min_importance: z.number().optional(),
      categories: z.array(z.string()).optional(),
      limit: z.number().int().optional(),
    },
  }, async (args) => {
    const results = await findTransferable(db, embedder, vecStore, args);
    return textResult(results.map(r => ({
      id: r.memory.id,
      content: r.memory.content.slice(0, 200),
      score: Math.round(r.transferability_score * 100) / 100,
      reason: r.reason,
    })));
  });

  server.registerTool('transfer_memories', {
    description: 'Copy memories from source to target namespace. Optionally adapts content by stripping project-specific references.',
    inputSchema: {
      memory_ids: z.array(z.string()).describe('Memory IDs to transfer'),
      target_namespace: z.string().describe('Target namespace'),
      adapt: z.boolean().optional().describe('Strip project-specific paths/hosts (default: true)'),
    },
  }, async (args) => textResult(await transferMemories(db, embedder, vecStore, args)));
}
