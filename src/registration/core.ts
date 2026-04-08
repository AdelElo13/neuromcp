import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';
import { textResult } from './types.js';
import { storeMemory } from '../tools/store.js';
import { searchMemory } from '../tools/search.js';
import { searchVerbatim } from '../tools/verbatim.js';
import { recallMemory } from '../tools/recall.js';
import { forgetMemory } from '../tools/forget.js';
import { consolidate } from '../tools/consolidate.js';
import { memoryStats } from '../tools/stats.js';
import { exportMemories, importMemories } from '../tools/admin.js';
import { backfillEmbeddings } from '../tools/backfill.js';

export function registerCoreTools(server: McpServer, deps: ServerDeps): void {
  const { db, vecStore, embedder, config, logger, metrics } = deps;

  server.registerTool('store_memory', {
    description: 'Store a new memory with semantic deduplication, contradiction detection, surprise scoring, and entity extraction. Returns the memory ID, contradictions found, surprise score, and extracted entities.',
    inputSchema: {
      content: z.string().describe('The memory content to store'),
      namespace: z.string().optional().describe('Namespace to store in (default: config default)'),
      category: z.string().optional().describe('Category label (e.g. "code", "conversation", "fact")'),
      tags: z.array(z.string()).optional().describe('Tags for filtering'),
      importance: z.number().min(0).max(1).optional().describe('Importance score 0-1 (default: 0.5)'),
      source: z.enum(['user', 'auto', 'consolidation', 'claude-code', 'error']).optional().describe('Source of the memory'),
      source_trust: z.enum(['high', 'medium', 'low', 'unverified']).optional().describe('Trust level'),
      project_id: z.string().optional().describe('Project identifier'),
      agent_id: z.string().optional().describe('Agent identifier'),
      metadata: z.record(z.unknown()).optional().describe('Arbitrary metadata'),
      expires_at: z.string().optional().describe('ISO 8601 expiration timestamp'),
      valid_from: z.string().optional().describe('ISO 8601 timestamp when this fact becomes valid (default: now)'),
      valid_to: z.string().optional().describe('ISO 8601 timestamp when this fact stops being valid'),
      episode_id: z.string().optional().describe('Episode ID to associate this memory with (from start_episode)'),
    },
  }, async (args) => {
    const result = await storeMemory(args, { db, vecStore, embedder, logger, metrics, config });
    return textResult(result);
  });

  server.registerTool('search_memory', {
    description: 'Search memories using hybrid vector + full-text search with RRF ranking, graph boost, and cognitive priming. Supports temporal queries (valid_at) to find what was true at a specific time.',
    inputSchema: {
      query: z.string().describe('Search query text'),
      namespace: z.string().optional().describe('Namespace to search (default: config default)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 10)'),
      category: z.string().optional().describe('Filter by category'),
      tags: z.array(z.string()).optional().describe('Filter: all tags must be present'),
      min_importance: z.number().min(0).max(1).optional().describe('Minimum importance threshold'),
      min_trust: z.enum(['high', 'medium', 'low', 'unverified']).optional().describe('Minimum trust level'),
      after: z.string().optional().describe('Only memories created after this ISO timestamp'),
      before: z.string().optional().describe('Only memories created before this ISO timestamp'),
      hybrid: z.boolean().optional().describe('Use hybrid search (default: true)'),
      valid_at: z.string().optional().describe('ISO 8601 timestamp — only return memories valid at this time (temporal query)'),
      graph_boost: z.boolean().optional().describe('Boost results connected via knowledge graph (default: true)'),
      episode_id: z.string().optional().describe('Filter by episode ID — only return memories from this episode'),
    },
  }, async (args) => {
    const results = await searchMemory(args, { db, vecStore, embedder, logger, metrics, config });
    return textResult(results);
  });

  server.registerTool('recall_memory', {
    description: 'Recall memories by ID, namespace, category, or tags without semantic search.',
    inputSchema: {
      id: z.string().optional().describe('Specific memory ID to recall'),
      namespace: z.string().optional().describe('Namespace filter'),
      category: z.string().optional().describe('Category filter'),
      tags: z.array(z.string()).optional().describe('Tags filter: all must match'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 20)'),
    },
  }, (args) => {
    const results = recallMemory(args, db, config, logger, metrics);
    return textResult(results);
  });

  server.registerTool('forget_memory', {
    description: 'Tombstone (soft-delete) memories matching the given filters. At least one filter is required.',
    inputSchema: {
      id: z.string().optional().describe('Specific memory ID to forget'),
      namespace: z.string().optional().describe('Namespace filter'),
      tags: z.array(z.string()).optional().describe('Tags filter'),
      older_than_days: z.number().int().min(1).optional().describe('Delete memories older than N days'),
      below_importance: z.number().min(0).max(1).optional().describe('Delete memories below this importance'),
      dry_run: z.boolean().optional().describe('Preview what would be deleted without actually deleting'),
    },
  }, (args) => {
    const result = forgetMemory(args, db, vecStore, config, logger, metrics);
    return textResult(result);
  });

  server.registerTool('consolidate', {
    description: 'Run consolidation: merge near-duplicates, decay stale memories, prune low-value, sweep expired, purge old tombstones. Set commit=true to apply.',
    inputSchema: {
      namespace: z.string().optional().describe('Namespace to consolidate (default: config default)'),
      similarity_threshold: z.number().min(0).max(1).optional().describe('Similarity threshold for merging'),
      decay_lambda: z.number().optional().describe('Decay rate parameter'),
      min_importance_after_decay: z.number().min(0).max(1).optional().describe('Prune threshold after decay'),
      commit: z.boolean().describe('If false, returns a dry-run plan. If true, executes the plan.'),
    },
  }, (args) => {
    const output = consolidate(args, db, vecStore, embedder, config, logger, metrics);
    return textResult(output);
  });

  server.registerTool('memory_stats', {
    description: 'Get statistics about stored memories: counts, categories, trust levels, importance, and database size.',
    inputSchema: {
      namespace: z.string().optional().describe('Namespace to get stats for (default: config default, "*" for all)'),
    },
  }, (args) => {
    const stats = memoryStats(args, db, embedder, config);
    return textResult(stats);
  });

  server.registerTool('export_memories', {
    description: 'Export memories as JSONL or JSON for backup or migration.',
    inputSchema: {
      namespace: z.string().optional().describe('Namespace to export (default: config default, "*" for all)'),
      format: z.enum(['jsonl', 'json']).optional().describe('Export format (default: jsonl)'),
      include_tombstoned: z.boolean().optional().describe('Include soft-deleted memories'),
    },
  }, (args) => {
    const data = exportMemories(args, db, config);
    return textResult({ data });
  });

  server.registerTool('import_memories', {
    description: 'Import memories from JSONL or JSON data. Deduplicates by content hash.',
    inputSchema: {
      data: z.string().describe('JSONL or JSON array string of memory records'),
      namespace: z.string().optional().describe('Override namespace for all imported memories'),
      trust: z.enum(['high', 'medium', 'low', 'unverified']).optional().describe('Trust level for imported memories (default: unverified)'),
    },
  }, async (args) => {
    const result = await importMemories(args, db, vecStore, embedder, config, logger, metrics);
    return textResult(result);
  });

  server.registerTool('backfill_embeddings', {
    description: 'Recompute embeddings for all memories missing from the vector store. Also syncs FTS index.',
    inputSchema: {},
  }, async () => {
    const result = await backfillEmbeddings(db, vecStore, embedder, logger, metrics);
    return textResult(result);
  });

  server.registerTool('search_all', {
    description: 'Unified search across both extracted memories and verbatim text. Returns results with source labels and per-source quotas.',
    inputSchema: {
      query: z.string().describe('Search query text'),
      namespace: z.string().optional().describe('Namespace filter'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results per source (default: 5)'),
      after: z.string().optional().describe('Only entries after this ISO timestamp'),
      before: z.string().optional().describe('Only entries before this ISO timestamp'),
      episode_id: z.string().optional().describe('Filter by episode'),
    },
  }, async (args) => {
    const perSourceLimit = args.limit ?? 5;

    // Search both sources in parallel
    const [memoryResults, verbatimResults] = await Promise.all([
      searchMemory(
        { query: args.query, namespace: args.namespace, limit: perSourceLimit, after: args.after, before: args.before, episode_id: args.episode_id },
        { db, vecStore, embedder, logger, metrics, config },
      ),
      Promise.resolve(searchVerbatim(
        { query: args.query, namespace: args.namespace, limit: perSourceLimit, after: args.after, before: args.before, episode_id: args.episode_id },
        db, config, logger, metrics,
      )),
    ]);

    const labeled = {
      memories: memoryResults.map((m) => ({
        id: m.id,
        content: m.content,
        score: m.similarity_score,
        source: 'extracted' as const,
        created_at: m.created_at,
        category: m.category,
        importance: m.importance,
      })),
      verbatim: verbatimResults.map((v) => ({
        id: v.id,
        content: v.content,
        score: v.relevance_score,
        source: 'verbatim' as const,
        created_at: v.created_at,
      })),
      total: memoryResults.length + verbatimResults.length,
    };

    return textResult(labeled);
  });
}
