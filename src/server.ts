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
import { backfillEmbeddings } from './tools/backfill.js';
import { createEntity, createRelation, queryGraph } from './tools/graph.js';
import { searchClaims, getClaimsForMemory } from './cognitive/claims.js';
import { startEpisode, endEpisode, listEpisodes, getEpisode } from './tools/episode.js';
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
    { name: 'neuromcp', version: '0.5.1' },
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

  // ─── Tool 2: search_memory ─────────────────────────────────────────
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

  // ─── Tool 9: backfill_embeddings ───────────────────────────────────
  server.registerTool('backfill_embeddings', {
    description: 'Recompute embeddings for all memories missing from the vector store. Also syncs FTS index.',
    inputSchema: {},
  }, async () => {
    const result = await backfillEmbeddings(db, vecStore, embedder, logger, metrics);
    return textResult(result);
  });

  // ─── Tool 10: create_entity ────────────────────────────────────────
  server.registerTool('create_entity', {
    description: 'Create or update an entity in the knowledge graph. Entities represent concepts, people, tools, or any named thing.',
    inputSchema: {
      name: z.string().describe('Entity name'),
      entity_type: z.string().optional().describe('Entity type (default: "concept"). Examples: person, tool, project, concept, package, url'),
      namespace: z.string().optional().describe('Namespace (default: config default)'),
      metadata: z.record(z.unknown()).optional().describe('Arbitrary metadata'),
    },
  }, (args) => {
    const entity = createEntity(args, db, config, logger, metrics);
    return textResult(entity);
  });

  // ─── Tool 11: create_relation ──────────────────────────────────────
  server.registerTool('create_relation', {
    description: 'Create a typed relation between two entities in the knowledge graph. Supports temporal validity.',
    inputSchema: {
      source_entity_id: z.string().describe('Source entity ID'),
      target_entity_id: z.string().describe('Target entity ID'),
      relation_type: z.string().describe('Relation type: causes, fixes, contradicts, relates_to, part_of, depends_on, supersedes, similar_to'),
      namespace: z.string().optional().describe('Namespace (default: config default)'),
      weight: z.number().min(0).max(1).optional().describe('Relation strength 0-1 (default: 1.0)'),
      metadata: z.record(z.unknown()).optional().describe('Arbitrary metadata'),
      valid_from: z.string().optional().describe('ISO 8601 timestamp when relation becomes valid'),
      valid_to: z.string().optional().describe('ISO 8601 timestamp when relation stops being valid'),
    },
  }, (args) => {
    const relation = createRelation(args, db, config, logger, metrics);
    return textResult(relation);
  });

  // ─── Tool 12: query_graph ─────────────────────────────────────────
  server.registerTool('query_graph', {
    description: 'Traverse the knowledge graph starting from an entity. Returns connected nodes and edges up to max_depth hops. Supports temporal queries.',
    inputSchema: {
      entity_id: z.string().optional().describe('Start entity ID'),
      entity_name: z.string().optional().describe('Start entity name (will find closest match)'),
      namespace: z.string().optional().describe('Namespace (default: config default)'),
      max_depth: z.number().int().min(1).max(5).optional().describe('Maximum traversal depth (default: 2)'),
      relation_types: z.array(z.string()).optional().describe('Filter by relation types'),
      valid_at: z.string().optional().describe('ISO 8601 timestamp — only show relations valid at this time'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum nodes to return (default: 50)'),
    },
  }, (args) => {
    const result = queryGraph(args, db, config, logger, metrics);
    return textResult(result);
  });

  // ─── Tool 13: search_claims ─────────────────────────────────────────
  server.registerTool('search_claims', {
    description: 'Search atomic claims extracted from memories. Claims are verifiable facts with subject-predicate-object structure.',
    inputSchema: {
      query: z.string().optional().describe('Search text (matches content, subject, or object)'),
      memory_id: z.string().optional().describe('Get all claims from a specific memory'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 20)'),
    },
  }, (args) => {
    if (args.memory_id !== undefined) {
      const claims = getClaimsForMemory(db, args.memory_id);
      return textResult(claims);
    }
    const claims = searchClaims(db, args.query ?? '', args.limit ?? 20);
    return textResult(claims);
  });

  // ─── Episode Tools ──────────────────────────────────────────────────

  server.registerTool('start_episode', {
    description: 'Start a new episode (session/task context). Memories stored with this episode_id will be grouped together. Use to track what happened during a session.',
    inputSchema: {
      title: z.string().describe('Episode title (e.g. "Deploy agentproofs-io", "Debug auth flow")'),
      namespace: z.string().optional().describe('Namespace (default: config default)'),
      metadata: z.record(z.unknown()).optional().describe('Arbitrary metadata'),
    },
  }, (args) => {
    const episode = startEpisode(db, args, config.defaultNamespace);
    return textResult(episode);
  });

  server.registerTool('end_episode', {
    description: 'End an active episode. Optionally provide a summary, or one will be auto-generated from the most important memories in the episode.',
    inputSchema: {
      episode_id: z.string().describe('Episode ID to end'),
      summary: z.string().optional().describe('Episode summary (auto-generated if omitted)'),
    },
  }, (args) => {
    const result = endEpisode(db, args);
    return textResult(result);
  });

  server.registerTool('list_episodes', {
    description: 'List episodes in a namespace. Shows memory count per episode.',
    inputSchema: {
      namespace: z.string().optional().describe('Namespace to list from'),
      limit: z.number().optional().describe('Max episodes to return (default: 20)'),
      active_only: z.boolean().optional().describe('Only show active (not ended) episodes'),
    },
  }, (args) => {
    const episodes = listEpisodes(db, args, config.defaultNamespace);
    return textResult(episodes);
  });

  server.registerTool('get_episode', {
    description: 'Get details of a specific episode including memory count.',
    inputSchema: {
      episode_id: z.string().describe('Episode ID to retrieve'),
    },
  }, (args) => {
    const episode = getEpisode(db, args.episode_id);
    if (!episode) return textResult({ error: 'Episode not found' });
    return textResult(episode);
  });

  // ─── Resources ─────────────────────────────────────────────────────
  registerResources(server, deps);

  // ─── Prompts ───────────────────────────────────────────────────────
  registerPrompts(server, deps);

  logger.info('server', 'MCP server created', {
    tools: 17,
    resources: 13,
    prompts: 3,
  });

  return server;
}
