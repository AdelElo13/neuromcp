import type Database from 'better-sqlite3';

export interface PageRankResult {
  readonly entity_id: string;
  readonly name: string;
  readonly entity_type: string;
  readonly centrality: number;
}

/**
 * Weighted PageRank over the knowledge graph.
 *
 * Algorithm:
 *   rank[entity] = (1-d)/N + d * sum(rank[neighbor] * weight[edge] / out_degree[neighbor])
 *
 * Where d = damping factor (0.85), N = total entities, weight = edge weight.
 * Converges in ~10-20 iterations for typical knowledge graphs.
 */
export function computePageRank(
  db: Database.Database,
  namespace: string,
  options: { damping?: number; maxIterations?: number; tolerance?: number } = {},
): readonly PageRankResult[] {
  const damping = options.damping ?? 0.85;
  const maxIterations = options.maxIterations ?? 20;
  const tolerance = options.tolerance ?? 1e-6;

  // Load all active entities
  const entities = db.prepare(
    'SELECT id, name, entity_type FROM entities WHERE namespace = ? AND is_deleted = 0'
  ).all(namespace) as Array<{ id: string; name: string; entity_type: string }>;

  if (entities.length === 0) return [];

  const entityIndex = new Map<string, number>();
  entities.forEach((e, i) => entityIndex.set(e.id, i));
  const N = entities.length;

  // Load all active relations
  const relations = db.prepare(
    'SELECT source_entity_id, target_entity_id, weight FROM relations WHERE namespace = ? AND is_deleted = 0'
  ).all(namespace) as Array<{ source_entity_id: string; target_entity_id: string; weight: number }>;

  // Build adjacency: outgoing edges per entity
  const outEdges = new Map<number, Array<{ target: number; weight: number }>>();
  const outDegree = new Float64Array(N); // weighted out-degree

  for (const rel of relations) {
    const srcIdx = entityIndex.get(rel.source_entity_id);
    const tgtIdx = entityIndex.get(rel.target_entity_id);
    if (srcIdx === undefined || tgtIdx === undefined) continue;

    if (!outEdges.has(srcIdx)) outEdges.set(srcIdx, []);
    outEdges.get(srcIdx)!.push({ target: tgtIdx, weight: rel.weight });
    outDegree[srcIdx] += rel.weight;

    // Bidirectional: also add reverse edge (knowledge graphs are often undirected)
    if (!outEdges.has(tgtIdx)) outEdges.set(tgtIdx, []);
    outEdges.get(tgtIdx)!.push({ target: srcIdx, weight: rel.weight });
    outDegree[tgtIdx] += rel.weight;
  }

  // Also boost entities by memory count (more memories = more important)
  const memoryCounts = db.prepare(`
    SELECT entity_id, COUNT(*) as c FROM memory_entities
    WHERE entity_id IN (SELECT id FROM entities WHERE namespace = ? AND is_deleted = 0)
    GROUP BY entity_id
  `).all(namespace) as Array<{ entity_id: string; c: number }>;

  const memoryBoost = new Float64Array(N);
  for (const mc of memoryCounts) {
    const idx = entityIndex.get(mc.entity_id);
    if (idx !== undefined) {
      memoryBoost[idx] = Math.log(1 + mc.c) * 0.1; // logarithmic boost
    }
  }

  // Initialize ranks uniformly
  let rank = new Float64Array(N).fill(1 / N);
  const base = (1 - damping) / N;

  // Iterate
  for (let iter = 0; iter < maxIterations; iter++) {
    const newRank = new Float64Array(N).fill(base);

    for (let i = 0; i < N; i++) {
      const edges = outEdges.get(i);
      if (!edges || outDegree[i] === 0) continue;

      for (const edge of edges) {
        newRank[edge.target] += damping * rank[i]! * edge.weight / outDegree[i]!;
      }
    }

    // Add memory boost
    for (let i = 0; i < N; i++) {
      newRank[i] += memoryBoost[i]!;
    }

    // Normalize
    let sum = 0;
    for (let i = 0; i < N; i++) sum += newRank[i]!;
    if (sum > 0) for (let i = 0; i < N; i++) newRank[i] /= sum;

    // Check convergence
    let maxDelta = 0;
    for (let i = 0; i < N; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(newRank[i]! - rank[i]!));
    }

    rank = newRank;
    if (maxDelta < tolerance) break;
  }

  // Build results sorted by centrality
  const results: PageRankResult[] = entities.map((e, i) => ({
    entity_id: e.id,
    name: e.name,
    entity_type: e.entity_type,
    centrality: rank[i]!,
  }));

  results.sort((a, b) => b.centrality - a.centrality);
  return results;
}

/**
 * Persist PageRank centrality scores to entities table.
 */
export function persistCentrality(
  db: Database.Database,
  results: readonly PageRankResult[],
): number {
  const stmt = db.prepare('UPDATE entities SET metadata = json_set(metadata, \'$.centrality\', ?) WHERE id = ?');
  const transaction = db.transaction(() => {
    for (const r of results) {
      stmt.run(r.centrality, r.entity_id);
    }
  });
  transaction();
  return results.length;
}
