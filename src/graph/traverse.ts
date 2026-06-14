import type Database from 'better-sqlite3';
import type { Entity, GraphNode, GraphEdge, GraphQueryResult } from '../types.js';
import { getRelationsForEntity } from './relations.js';

/**
 * BFS graph traversal starting from an entity.
 * Returns all reachable nodes and edges within `maxDepth` hops.
 */
export function traverseGraph(
  db: Database.Database,
  startEntityId: string,
  options?: {
    readonly maxDepth?: number;
    readonly relation_types?: readonly string[];
    readonly valid_at?: string;
    readonly limit?: number;
  },
): GraphQueryResult {
  const maxDepth = options?.maxDepth ?? 2;
  const limit = options?.limit ?? 50;

  const visited = new Set<string>();
  // Bug #5 fix (v0.21.0):
  //   Track edges we've already added so a single relation isn't added
  //   twice when both endpoints get visited via direction='both' BFS
  //   expansion. Keyed on relation.id (deterministic SHA-256 hash).
  const seenEdges = new Set<string>();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const queue: Array<{ entityId: string; depth: number }> = [
    { entityId: startEntityId, depth: 0 },
  ];

  while (queue.length > 0 && nodes.length < limit) {
    const item = queue.shift()!;
    if (visited.has(item.entityId)) continue;
    visited.add(item.entityId);

    // Fetch entity
    const entity = db
      .prepare('SELECT * FROM entities WHERE id = ? AND is_deleted = 0')
      .get(item.entityId) as Entity | undefined;

    if (entity === undefined) continue;

    // Count linked memories
    const memCount = db
      .prepare('SELECT COUNT(*) as cnt FROM memory_entities WHERE entity_id = ?')
      .get(item.entityId) as { cnt: number };

    nodes.push({ entity, memory_count: memCount.cnt });

    // Don't expand beyond maxDepth
    if (item.depth >= maxDepth) continue;

    // Get relations — honor the full relation_types array; passing only the
    // first entry made query_graph's published array filter return wrong
    // results for every call with 2+ types.
    const relations = getRelationsForEntity(db, item.entityId, {
      direction: 'both',
      relation_types: options?.relation_types,
      valid_at: options?.valid_at,
    });

    for (const rel of relations) {
      // Determine the neighbor
      const neighborId =
        rel.source_entity_id === item.entityId
          ? rel.target_entity_id
          : rel.source_entity_id;

      // Skip if this edge was already added from the other endpoint.
      if (seenEdges.has(rel.id)) {
        if (!visited.has(neighborId)) {
          queue.push({ entityId: neighborId, depth: item.depth + 1 });
        }
        continue;
      }
      seenEdges.add(rel.id);

      // Add edge
      const sourceName = db
        .prepare('SELECT name FROM entities WHERE id = ?')
        .get(rel.source_entity_id) as { name: string } | undefined;
      const targetName = db
        .prepare('SELECT name FROM entities WHERE id = ?')
        .get(rel.target_entity_id) as { name: string } | undefined;

      if (sourceName !== undefined && targetName !== undefined) {
        edges.push({
          relation: rel,
          source_name: sourceName.name,
          target_name: targetName.name,
        });
      }

      if (!visited.has(neighborId)) {
        queue.push({ entityId: neighborId, depth: item.depth + 1 });
      }
    }
  }

  return { nodes, edges, traversal_depth: maxDepth };
}

/**
 * Find memory IDs connected to a set of entity IDs through the graph.
 * Used to boost search results that are graph-connected to the query.
 */
export function findConnectedMemories(
  db: Database.Database,
  entityIds: readonly string[],
  maxDepth: number = 1,
): Map<string, number> {
  const memoryScores = new Map<string, number>();

  for (const entityId of entityIds) {
    const result = traverseGraph(db, entityId, { maxDepth, limit: 30 });

    for (const node of result.nodes) {
      // Get memories linked to this entity
      const rows = db
        .prepare('SELECT memory_id FROM memory_entities WHERE entity_id = ?')
        .all(node.entity.id) as Array<{ memory_id: string }>;

      for (const row of rows) {
        // Score decreases with graph distance (approximated by node position)
        const currentScore = memoryScores.get(row.memory_id) ?? 0;
        const boost = 1 / (1 + (result.nodes.indexOf(node)));
        memoryScores.set(row.memory_id, Math.max(currentScore, boost));
      }
    }
  }

  return memoryScores;
}
