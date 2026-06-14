import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Entity } from '../types.js';

function generateId(): string {
  return createHash('sha256')
    .update(Date.now() + '-' + Math.random())
    .digest('hex')
    .slice(0, 32);
}

/** Find or create an entity by name + namespace (case-insensitive name match). */
export function upsertEntity(
  db: Database.Database,
  name: string,
  entityType: string,
  namespace: string,
  metadata?: Record<string, unknown>,
): Entity {
  const normalizedName = name.trim().toLowerCase();

  // Canonical dedup key is (LOWER(TRIM(name)), namespace) — deliberately
  // WITHOUT entity_type. Including the type let the same real-world entity
  // accumulate one row per extractor-assigned type ("NeuroMCP" as project +
  // concept + tool), fragmenting the graph and its boosts. First writer's
  // type wins; metadata still merges on later upserts.
  const existing = db
    .prepare(
      'SELECT * FROM entities WHERE LOWER(name) = ? AND namespace = ? AND is_deleted = 0 LIMIT 1',
    )
    .get(normalizedName, namespace) as Entity | undefined;

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
  // First try: token-wise lookup. Extract capitalized candidates from the
  // query and look up each exactly. This is how LongMemEval-style queries
  // hit entities — "What did Rachel tell me about Denver?" should match
  // entities named "Rachel" and "Denver", not the whole query string.
  // Falls back to the old LIKE-match if no capitalized tokens found (for
  // queries like "what's my favorite color").
  const tokens = extractQueryCandidateTokens(query);
  if (tokens.length > 0) {
    const placeholders = tokens.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT * FROM entities
         WHERE is_deleted = 0
           AND (namespace = ? OR ? = '*')
           AND LOWER(name) IN (${placeholders})
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(namespace, namespace, ...tokens.map(t => t.toLowerCase()), limit) as Entity[];
    if (rows.length > 0) return rows;
  }

  // Fallback: legacy LIKE match.
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

/** Extract capitalized multi-word or single-word proper-noun candidates from
 * a natural-language query. Includes multi-word phrases so "Museum of Modern
 * Art" is one lookup, not three. */
function extractQueryCandidateTokens(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Multi-word capitalized spans (1-5 words)
  const re = /\b([A-Z][a-zA-Z]{1,20})(?:\s+(?:of\s+|the\s+|and\s+|& )?[A-Z][a-zA-Z]{1,20}){0,4}\b/g;
  for (const m of query.matchAll(re)) {
    const phrase = m[0].trim();
    const lower = phrase.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(phrase);
  }
  return out;
}
