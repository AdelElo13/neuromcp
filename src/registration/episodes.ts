import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';
import { textResult } from './types.js';
import { startEpisode, endEpisode, listEpisodes, getEpisode } from '../tools/episode.js';
import { clusterMemories } from '../cognitive/clustering.js';
import { summarizeCluster, summarizeEpisode } from '../cognitive/summarize.js';
import { memoryTimeline } from '../tools/timeline.js';

export function registerEpisodeTools(server: McpServer, deps: ServerDeps): void {
  const { db, vecStore, embedder, config } = deps;

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

  server.registerTool('cluster_memories', {
    description: 'Run k-means clustering on memories in a namespace. Groups semantically related memories into clusters. Returns cluster labels, sizes, and assignments.',
    inputSchema: {
      namespace: z.string().optional().describe('Namespace to cluster (default: config default)'),
      k: z.number().int().min(2).max(50).optional().describe('Number of clusters (auto-selected if omitted: sqrt(n/2), clamped 2-20)'),
      max_iterations: z.number().int().optional().describe('Max k-means iterations (default: 10)'),
    },
  }, async (args) => {
    const namespace = args.namespace ?? config.defaultNamespace;
    const result = await clusterMemories(db, vecStore, embedder, namespace, {
      k: args.k,
      maxIterations: args.max_iterations,
    });
    return textResult({
      clusters: result.clusters.map(c => ({ id: c.id, label: c.label, size: c.size })),
      total_assignments: result.assignments.length,
    });
  });

  server.registerTool('list_clusters', {
    description: 'List all clusters in a namespace with their labels and memory counts.',
    inputSchema: {
      namespace: z.string().optional().describe('Namespace (default: config default)'),
    },
  }, (args) => {
    const namespace = args.namespace ?? config.defaultNamespace;
    const clusters = db.prepare(
      'SELECT id, label, centroid_memory_id, size, created_at, updated_at FROM clusters WHERE namespace = ? ORDER BY size DESC'
    ).all(namespace);
    return textResult(clusters);
  });

  server.registerTool('get_cluster_memories', {
    description: 'Get all memories in a specific cluster, ordered by distance from centroid.',
    inputSchema: {
      cluster_id: z.string().describe('Cluster ID'),
      limit: z.number().int().optional().describe('Max memories to return (default: 20)'),
    },
  }, (args) => {
    const limit = args.limit ?? 20;
    const memories = db.prepare(`
      SELECT m.id, m.content, m.category, m.importance, mc.distance
      FROM memory_clusters mc
      JOIN memories m ON m.id = mc.memory_id
      WHERE mc.cluster_id = ? AND m.is_deleted = 0
      ORDER BY mc.distance ASC
      LIMIT ?
    `).all(args.cluster_id, limit);
    return textResult(memories);
  });

  server.registerTool('summarize_cluster', {
    description: 'Generate an extractive summary of a cluster. Selects the most central, representative sentences from cluster memories using embedding centrality.',
    inputSchema: {
      cluster_id: z.string().describe('Cluster ID to summarize'),
      max_sentences: z.number().int().min(1).max(20).optional().describe('Max sentences in summary (default: 5)'),
    },
  }, async (args) => {
    const result = await summarizeCluster(db, embedder, args.cluster_id, { maxSentences: args.max_sentences });
    return textResult(result);
  });

  server.registerTool('summarize_episode', {
    description: 'Generate an extractive summary of an episode. Selects the most central, representative sentences from episode memories.',
    inputSchema: {
      episode_id: z.string().describe('Episode ID to summarize'),
      max_sentences: z.number().int().min(1).max(20).optional().describe('Max sentences in summary (default: 5)'),
    },
  }, async (args) => {
    const result = await summarizeEpisode(db, embedder, args.episode_id, { maxSentences: args.max_sentences });
    return textResult(result);
  });

  server.registerTool('memory_timeline', {
    description: 'Track how knowledge about a topic evolved over time. Follows supersession chains and shows full revision history.',
    inputSchema: {
      query: z.string().describe('Topic to track evolution of'),
      namespace: z.string().optional().describe('Namespace (default: config default)'),
      after: z.string().optional().describe('Only show entries after this ISO date'),
      before: z.string().optional().describe('Only show entries before this ISO date'),
      include_superseded: z.boolean().optional().describe('Include superseded (old) versions (default: true)'),
      limit: z.number().int().optional().describe('Max entries (default: 20)'),
    },
  }, (args) => {
    const result = memoryTimeline(db, args, config.defaultNamespace);
    return textResult(result);
  });
}
