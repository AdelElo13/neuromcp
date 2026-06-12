import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Relation } from '../types.js';

function generateId(): string {
  return createHash('sha256')
    .update(Date.now() + '-' + Math.random())
    .digest('hex')
    .slice(0, 32);
}

/** Create a typed relation between two entities. */
export function createRelation(
  db: Database.Database,
  sourceEntityId: string,
  targetEntityId: string,
  relationType: string,
  namespace: string,
  options?: {
    readonly weight?: number;
    readonly metadata?: Record<string, unknown>;
    readonly valid_from?: string;
    readonly valid_to?: string;
  },
): Relation {
  // Check for existing active relation of same type between same entities
  const existing = db
    .prepare(
      `SELECT * FROM relations
       WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?
         AND namespace = ? AND is_deleted = 0
       LIMIT 1`,
    )
    .get(sourceEntityId, targetEntityId, relationType, namespace) as Relation | undefined;

  if (existing !== undefined) {
    // Update weight and metadata
    const newWeight = options?.weight ?? existing.weight;
    const existingMeta = JSON.parse(existing.metadata) as Record<string, unknown>;
    const merged = { ...existingMeta, ...(options?.metadata ?? {}) };
    db.prepare(
      'UPDATE relations SET weight = ?, metadata = ?, valid_from = COALESCE(?, valid_from), valid_to = COALESCE(?, valid_to) WHERE id = ?',
    ).run(newWeight, JSON.stringify(merged), options?.valid_from ?? null, options?.valid_to ?? null, existing.id);

    return db.prepare('SELECT * FROM relations WHERE id = ?').get(existing.id) as Relation;
  }

  const id = generateId();
  db.prepare(
    `INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, weight, metadata, namespace, valid_from, valid_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sourceEntityId,
    targetEntityId,
    relationType,
    options?.weight ?? 1.0,
    JSON.stringify(options?.metadata ?? {}),
    namespace,
    options?.valid_from ?? null,
    options?.valid_to ?? null,
  );

  return db.prepare('SELECT * FROM relations WHERE id = ?').get(id) as Relation;
}

/** Get all relations for an entity (as source or target). */
export function getRelationsForEntity(
  db: Database.Database,
  entityId: string,
  options?: {
    readonly direction?: 'outgoing' | 'incoming' | 'both';
    readonly relation_type?: string;
    readonly relation_types?: readonly string[];
    readonly valid_at?: string;
  },
): readonly Relation[] {
  const direction = options?.direction ?? 'both';
  const clauses: string[] = ['r.is_deleted = 0'];
  const params: Array<string | number> = [];

  if (direction === 'outgoing') {
    clauses.push('r.source_entity_id = ?');
    params.push(entityId);
  } else if (direction === 'incoming') {
    clauses.push('r.target_entity_id = ?');
    params.push(entityId);
  } else {
    clauses.push('(r.source_entity_id = ? OR r.target_entity_id = ?)');
    params.push(entityId, entityId);
  }

  // relation_types (plural) wins when both are provided; relation_type kept
  // for backward compatibility with single-type callers.
  const types =
    options?.relation_types !== undefined && options.relation_types.length > 0
      ? options.relation_types
      : options?.relation_type !== undefined
        ? [options.relation_type]
        : undefined;
  if (types !== undefined) {
    clauses.push(`r.relation_type IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
  }

  // Temporal filter: only relations valid at the given time
  if (options?.valid_at !== undefined) {
    clauses.push('(r.valid_from IS NULL OR r.valid_from <= ?)');
    clauses.push('(r.valid_to IS NULL OR r.valid_to > ?)');
    params.push(options.valid_at, options.valid_at);
  }

  const sql = `SELECT r.* FROM relations r WHERE ${clauses.join(' AND ')} ORDER BY r.weight DESC`;
  return db.prepare(sql).all(...params) as Relation[];
}

/** Invalidate a relation by setting valid_to. */
export function invalidateRelation(
  db: Database.Database,
  relationId: string,
  validTo?: string,
): void {
  const endDate = validTo ?? new Date().toISOString();
  db.prepare('UPDATE relations SET valid_to = ? WHERE id = ?').run(endDate, relationId);
}
