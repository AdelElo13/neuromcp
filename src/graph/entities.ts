import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Entity } from '../types.js';

function generateId(): string {
  return createHash('sha256')
    .update(Date.now() + '-' + Math.random())
    .digest('hex')
    .slice(0, 32);
}

/** Find or create an entity by name + type + namespace (case-insensitive name match). */
export function upsertEntity(
  db: Database.Database,
  name: string,
  entityType: string,
  namespace: string,
  metadata?: Record<string, unknown>,
): Entity {
  const normalizedName = name.trim().toLowerCase();

  // Check for existing entity (case-insensitive)
  const existing = db
    .prepare(
      'SELECT * FROM entities WHERE LOWER(name) = ? AND entity_type = ? AND namespace = ? AND is_deleted = 0 LIMIT 1',
    )
    .get(normalizedName, entityType, namespace) as Entity | undefined;

  if (existing !== undefined) {
    // Merge metadata if provided
    if (metadata !== undefined) {
      const existingMeta = JSON.parse(existing.metadata) as Record<string, unknown>;
      const merged = { ...existingMeta, ...metadata };
      db.prepare(
        "UPDATE entities SET metadata = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      ).run(JSON.stringify(merged), existing.id);
    }
    return existing;
  }

  const id = generateId();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO entities (id, name, entity_type, namespace, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name.trim(), entityType, namespace, JSON.stringify(metadata ?? {}), now, now);

  return db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as Entity;
}

/** Link a memory to an entity. */
export function linkMemoryEntity(
  db: Database.Database,
  memoryId: string,
  entityId: string,
  role: string = 'mentioned',
): void {
  try {
    db.prepare(
      'INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, role) VALUES (?, ?, ?)',
    ).run(memoryId, entityId, role);
  } catch {
    // Already linked
  }
}

/** Get all entities linked to a memory. */
export function getEntitiesForMemory(
  db: Database.Database,
  memoryId: string,
): readonly Entity[] {
  return db
    .prepare(
      `SELECT e.* FROM entities e
       JOIN memory_entities me ON me.entity_id = e.id
       WHERE me.memory_id = ? AND e.is_deleted = 0`,
    )
    .all(memoryId) as Entity[];
}

/** Get all memories linked to an entity. */
export function getMemoriesForEntity(
  db: Database.Database,
  entityId: string,
): readonly string[] {
  const rows = db
    .prepare(
      'SELECT memory_id FROM memory_entities WHERE entity_id = ?',
    )
    .all(entityId) as Array<{ memory_id: string }>;
  return rows.map((r) => r.memory_id);
}

/** Find entities by name pattern. */
export function searchEntities(
  db: Database.Database,
  query: string,
  namespace: string,
  limit: number = 20,
): readonly Entity[] {
  return db
    .prepare(
      `SELECT * FROM entities
       WHERE is_deleted = 0
         AND (namespace = ? OR ? = '*')
         AND (LOWER(name) LIKE ? OR LOWER(entity_type) LIKE ?)
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(namespace, namespace, `%${query.toLowerCase()}%`, `%${query.toLowerCase()}%`, limit) as Entity[];
}
