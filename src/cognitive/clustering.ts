import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';

export interface Cluster {
  readonly id: string;
  readonly namespace: string;
  readonly label: string | null;
  readonly centroid_memory_id: string;
  readonly size: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ClusterAssignment {
  readonly memory_id: string;
  readonly cluster_id: string;
  readonly distance: number;
}

/**
 * K-means clustering on memory embeddings.
 * Groups semantically related memories into clusters.
 *
 * Algorithm:
 * 1. Select k initial centroids (memories with highest importance, spread by category)
 * 2. Assign each memory to nearest centroid via cosine similarity
 * 3. Recompute centroids (memory closest to mean embedding)
 * 4. Repeat until convergence or max iterations
 */
export async function clusterMemories(
  db: Database.Database,
  vecStore: VectorStore,
  embedder: EmbeddingProvider,
  namespace: string,
  options: { k?: number; maxIterations?: number } = {},
): Promise<{ clusters: readonly Cluster[]; assignments: readonly ClusterAssignment[] }> {
  const maxIterations = options.maxIterations ?? 10;

  // Get all active memory IDs in namespace
  const memories = db.prepare(
    'SELECT id, content, importance, category FROM memories WHERE namespace = ? AND is_deleted = 0'
  ).all(namespace) as Array<{ id: string; content: string; importance: number; category: string }>;

  if (memories.length < 3) {
    return { clusters: [], assignments: [] };
  }

  // Auto-select k: sqrt(n/2), clamped to [2, 20]
  const k = options.k ?? Math.max(2, Math.min(20, Math.round(Math.sqrt(memories.length / 2))));

  // Generate embeddings for all memories
  const embeddings = new Map<string, Float32Array>();
  const batchSize = 32;
  for (let i = 0; i < memories.length; i += batchSize) {
    const batch = memories.slice(i, i + batchSize);
    const texts = batch.map(m => m.content);
    const vecs = await embedder.embedBatch(texts);
    for (let j = 0; j < batch.length; j++) {
      embeddings.set(batch[j]!.id, vecs[j]!);
    }
  }

  const memIds = [...embeddings.keys()];
  if (memIds.length < k) {
    return { clusters: [], assignments: [] };
  }

  // Initialize centroids: pick k memories with highest importance, diverse categories
  const sortedByImportance = [...memories]
    .filter(m => embeddings.has(m.id))
    .sort((a, b) => b.importance - a.importance);

  const centroidIds: string[] = [];
  const usedCategories = new Set<string>();
  for (const mem of sortedByImportance) {
    if (centroidIds.length >= k) break;
    // Prefer diverse categories for initial centroids
    if (!usedCategories.has(mem.category) || centroidIds.length >= new Set(sortedByImportance.map(m => m.category)).size) {
      centroidIds.push(mem.id);
      usedCategories.add(mem.category);
    }
  }

  // Fill remaining centroids if not enough diverse categories
  for (const mem of sortedByImportance) {
    if (centroidIds.length >= k) break;
    if (!centroidIds.includes(mem.id)) {
      centroidIds.push(mem.id);
    }
  }

  let currentCentroids = centroidIds.map(id => embeddings.get(id)!);
  let assignments = new Map<string, number>(); // memory_id → cluster index

  // K-means iterations
  for (let iter = 0; iter < maxIterations; iter++) {
    const newAssignments = new Map<string, number>();
    let changed = 0;

    // Assign each memory to nearest centroid
    for (const memId of memIds) {
      const vec = embeddings.get(memId)!;
      let bestIdx = 0;
      let bestSim = -1;

      for (let c = 0; c < currentCentroids.length; c++) {
        const sim = cosineSimilarity(vec, currentCentroids[c]!);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = c;
        }
      }

      newAssignments.set(memId, bestIdx);
      if (assignments.get(memId) !== bestIdx) changed++;
    }

    assignments = newAssignments;

    // Converged?
    if (changed === 0) break;

    // Recompute centroids: find memory closest to cluster mean
    currentCentroids = [];
    for (let c = 0; c < k; c++) {
      const clusterMemIds = memIds.filter(id => assignments.get(id) === c);
      if (clusterMemIds.length === 0) {
        // Empty cluster — keep old centroid
        currentCentroids.push(currentCentroids[c] ?? embeddings.get(memIds[0]!)!);
        continue;
      }

      // Compute mean embedding
      const dim = embedder.dimensions;
      const mean = new Float32Array(dim);
      for (const id of clusterMemIds) {
        const vec = embeddings.get(id)!;
        for (let d = 0; d < dim; d++) mean[d] += vec[d]!;
      }
      for (let d = 0; d < dim; d++) mean[d] /= clusterMemIds.length;

      // Find memory closest to mean
      let closestId = clusterMemIds[0]!;
      let closestSim = -1;
      for (const id of clusterMemIds) {
        const sim = cosineSimilarity(embeddings.get(id)!, mean);
        if (sim > closestSim) {
          closestSim = sim;
          closestId = id;
        }
      }

      currentCentroids.push(embeddings.get(closestId)!);
    }
  }

  // Persist clusters
  const now = new Date().toISOString();
  const clusters: Cluster[] = [];
  const clusterAssignments: ClusterAssignment[] = [];

  // Clear existing clusters for this namespace
  db.prepare('DELETE FROM memory_clusters WHERE cluster_id IN (SELECT id FROM clusters WHERE namespace = ?)').run(namespace);
  db.prepare('DELETE FROM clusters WHERE namespace = ?').run(namespace);

  const insertCluster = db.prepare(
    'INSERT INTO clusters (id, namespace, label, centroid_memory_id, size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertAssignment = db.prepare(
    'INSERT INTO memory_clusters (memory_id, cluster_id, distance) VALUES (?, ?, ?)'
  );
  const updateMemory = db.prepare('UPDATE memories SET cluster_id = ? WHERE id = ?');

  const transaction = db.transaction(() => {
    for (let c = 0; c < k; c++) {
      const clusterMemIds = memIds.filter(id => assignments.get(id) === c);
      if (clusterMemIds.length === 0) continue;

      const clusterId = `cluster-${namespace}-${c}-${Date.now()}`;
      const centroidId = clusterMemIds.reduce((best, id) => {
        const sim = cosineSimilarity(embeddings.get(id)!, currentCentroids[c]!);
        const bestSim = cosineSimilarity(embeddings.get(best)!, currentCentroids[c]!);
        return sim > bestSim ? id : best;
      });

      // Auto-label from centroid memory content
      const centroidMem = memories.find(m => m.id === centroidId);
      const label = centroidMem
        ? centroidMem.content.split(/[.!?\n]/)[0]?.trim().slice(0, 100) ?? null
        : null;

      insertCluster.run(clusterId, namespace, label, centroidId, clusterMemIds.length, now, now);

      const cluster: Cluster = {
        id: clusterId, namespace, label, centroid_memory_id: centroidId,
        size: clusterMemIds.length, created_at: now, updated_at: now,
      };
      clusters.push(cluster);

      for (const memId of clusterMemIds) {
        const distance = 1 - cosineSimilarity(embeddings.get(memId)!, currentCentroids[c]!);
        insertAssignment.run(memId, clusterId, distance);
        updateMemory.run(clusterId, memId);
        clusterAssignments.push({ memory_id: memId, cluster_id: clusterId, distance });
      }
    }
  });

  transaction();

  return { clusters, assignments: clusterAssignments };
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // vectors are L2-normalized, so dot = cosine
}
