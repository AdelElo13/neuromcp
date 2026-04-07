import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';
import { textResult } from './types.js';
import { createEntity, createRelation, queryGraph } from '../tools/graph.js';
import { searchClaims, getClaimsForMemory } from '../cognitive/claims.js';
import { computePageRank, persistCentrality } from '../graph/pagerank.js';
import { updateAdaptiveImportance } from '../cognitive/importance.js';

export function registerGraphTools(server: McpServer, deps: ServerDeps): void {
  const { db, config, logger, metrics } = deps;

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

  server.registerTool('compute_centrality', {
    description: 'Run weighted PageRank over the knowledge graph to compute entity centrality scores. Entities with more connections and higher-weight edges rank higher. Persists results for search boosting.',
    inputSchema: {
      namespace: z.string().optional().describe('Namespace (default: config default)'),
      damping: z.number().min(0).max(1).optional().describe('Damping factor (default: 0.85)'),
      max_iterations: z.number().int().optional().describe('Max iterations (default: 20)'),
    },
  }, (args) => {
    const namespace = args.namespace ?? config.defaultNamespace;
    const results = computePageRank(db, namespace, {
      damping: args.damping,
      maxIterations: args.max_iterations,
    });
    const updated = persistCentrality(db, results);
    return textResult({
      entities_ranked: results.length,
      persisted: updated,
      top_10: results.slice(0, 10).map(r => ({
        name: r.name,
        type: r.entity_type,
        centrality: Math.round(r.centrality * 10000) / 10000,
      })),
    });
  });

  server.registerTool('update_importance', {
    description: 'Recalculate adaptive importance for all memories in a namespace. Boosts frequently accessed, recently relevant, and graph-central memories. Run after clustering and PageRank for best results.',
    inputSchema: {
      namespace: z.string().optional().describe('Namespace (default: config default)'),
    },
  }, (args) => {
    const namespace = args.namespace ?? config.defaultNamespace;
    const result = updateAdaptiveImportance(db, namespace, {
      accessBoost: config.accessBoost,
      recencyBoost: config.recencyBoost,
      centralityBoost: config.centralityBoost,
    });
    return textResult(result);
  });
}
