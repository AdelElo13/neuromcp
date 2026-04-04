import { z } from 'zod';
import type Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VectorStore } from './vectors/types.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import type { NeuromcpConfig } from './config.js';
import type { Logger } from './observability/logger.js';
import type { Metrics } from './observability/metrics.js';
import { storeMemory } from './tools/store.js';
import { searchMemory } from './tools/search.js';
import { recallMemory } from './tools/recall.js';
import { forgetMemory } from './tools/forget.js';
import { consolidate } from './tools/consolidate.js';
import { memoryStats } from './tools/stats.js';
import { exportMemories, importMemories } from './tools/admin.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';

export interface ServerDeps {
  readonly db: Database.Database;
  readonly vecStore: VectorStore;
  readonly embedder: EmbeddingProvider;
  readonly config: NeuromcpConfig;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export function createServer(deps: ServerDeps): McpServer {
  const { db, vecStore, embedder, config, logger, metrics } = deps;

  const server = new McpServer(
    { name: 'neuromcp', version: '0.1.0' },
    {
      capabilities: {
        resources: {},
        tools: {},
        prompts: {},
      },
    },
  );

  // ─── Tool 1: store_memory ──────────────────────────────────────────
  server.registerTool('store_memory', {
    description: 'Store a new memory with semantic deduplication. Returns the memory ID and whether it matched an existing memory.',
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
    },
  }, async (args) => {
    const result = await storeMemory(args, { db, vecStore, embedder, logger, metrics, config });
    return textResult(result);
  });

  // ─── Tool 2: search_memory ─────────────────────────────────────────
  server.registerTool('search_memory', {
    description: 'Search memories using hybrid vector + full-text search with RRF ranking.',
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
    },
  }, async (args) => {
    const results = await searchMemory(args, { db, vecStore, embedder, logger, metrics, config });
    return textResult(results);
  });

  // ─── Tool 3: recall_memory ─────────────────────────────────────────
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

  // ─── Tool 4: forget_memory ─────────────────────────────────────────
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

  // ─── Tool 5: consolidate ───────────────────────────────────────────
  server.registerTool('consolidate', {
    description: 'Run consolidation: merge near-duplicates, decay stale memories, prune low-value, sweep expired. Set commit=true to apply.',
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

  // ─── Tool 6: memory_stats ──────────────────────────────────────────
  server.registerTool('memory_stats', {
    description: 'Get statistics about stored memories: counts, categories, trust levels, importance, and database size.',
    inputSchema: {
      namespace: z.string().optional().describe('Namespace to get stats for (default: config default, "*" for all)'),
    },
  }, (args) => {
    const stats = memoryStats(args, db, embedder, config);
    return textResult(stats);
  });

  // ─── Tool 7: export_memories ───────────────────────────────────────
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

  // ─── Tool 8: import_memories ───────────────────────────────────────
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

  // ─── Resources ─────────────────────────────────────────────────────
  registerResources(server, deps);

  // ─── Prompts ───────────────────────────────────────────────────────
  registerPrompts(server, deps);

  logger.info('server', 'MCP server created', {
    tools: 8,
    resources: 13,
    prompts: 3,
  });

  return server;
}
