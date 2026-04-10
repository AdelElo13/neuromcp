import type Database from 'better-sqlite3';
import { createRelation } from './relations.js';
import { upsertEntity } from './entities.js';

/**
 * Create a 'contradicts' relation between two memories in the knowledge graph.
 *
 * Since relations connect entities (not memories directly), this:
 * 1. Ensures both memories have entity representations
 * 2. Creates a 'contradicts' relation between those entities
 * 3. Stores resolution metadata (supersede/coexist/flag) on the relation
 */
export function createContradictionEdge(
  db: Database.Database,
  newMemoryId: string,
  existingMemoryId: string,
  namespace: string,
  meta: {
    readonly resolution: string;
    readonly similarity: number;
  },
): void {
  // Get or create entity references for both memories
  const newEntity = ensureMemoryEntity(db, newMemoryId, namespace);
  const existingEntity = ensureMemoryEntity(db, existingMemoryId, namespace);

  if (newEntity === null || existingEntity === null) return;

  createRelation(db, newEntity, existingEntity, 'contradicts', namespace, {
    weight: meta.similarity,
    metadata: { resolution: meta.resolution, auto: true },
  });
}

/**
 * Ensure a memory has at least one entity in the graph.
 * Returns the first linked entity ID, or creates a synthetic one.
 */
function ensureMemoryEntity(
  db: Database.Database,
  memoryId: string,
  namespace: string,
): string | null {
  // Check for existing entity link
  const existing = db
    .prepare('SELECT entity_id FROM memory_entities WHERE memory_id = ? LIMIT 1')
    .get(memoryId) as { entity_id: string } | undefined;

  if (existing !== undefined) return existing.entity_id;

  // Create a synthetic entity for this memory
  const memory = db
    .prepare('SELECT content, category FROM memories WHERE id = ? LIMIT 1')
    .get(memoryId) as { content: string; category: string } | undefined;

  if (memory === undefined) return null;

  // Use first 60 chars of content as entity name
  const name = `memory:${memory.content.slice(0, 60).replace(/[^\w\s-]/g, '').trim()}`;
  const entity = upsertEntity(db, name, 'memory', namespace);

  // Link memory to entity
  db.prepare(
    'INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, role) VALUES (?, ?, ?)',
  ).run(memoryId, entity.id, 'subject');

  return entity.id;
}
