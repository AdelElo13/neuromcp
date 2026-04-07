import type Database from 'better-sqlite3';
import type { NeuromcpConfig } from '../config.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { Entity, Relation, GraphQueryResult } from '../types.js';
import { upsertEntity, searchEntities } from '../graph/entities.js';
import { createRelation as createRel } from '../graph/relations.js';
import { traverseGraph } from '../graph/traverse.js';

// ─── create_entity ──────────────────────────────────────────────────
export interface CreateEntityInput {
  readonly name: string;
  readonly entity_type?: string;
  readonly namespace?: string;
  readonly metadata?: Record<string, unknown>;
}

export function createEntity(
  input: CreateEntityInput,
  db: Database.Database,
  config: NeuromcpConfig,
  logger: Logger,
  metrics: Metrics,
): Entity {
  const namespace = input.namespace ?? config.defaultNamespace;
  const entityType = input.entity_type ?? 'concept';

  const entity = upsertEntity(db, input.name, entityType, namespace, input.metadata);

  logger.info('graph', 'Entity created/updated', { id: entity.id, name: input.name, type: entityType });
  metrics.increment('graph.entity_created');

  return entity;
}

// ─── create_relation ────────────────────────────────────────────────
export interface CreateRelationInput {
  readonly source_entity_id: string;
  readonly target_entity_id: string;
  readonly relation_type: string;
  readonly namespace?: string;
  readonly weight?: number;
  readonly metadata?: Record<string, unknown>;
  readonly valid_from?: string;
  readonly valid_to?: string;
}

export function createRelation(
  input: CreateRelationInput,
  db: Database.Database,
  config: NeuromcpConfig,
  logger: Logger,
  metrics: Metrics,
): Relation {
  const namespace = input.namespace ?? config.defaultNamespace;

  const relation = createRel(
    db,
    input.source_entity_id,
    input.target_entity_id,
    input.relation_type,
    namespace,
    {
      weight: input.weight,
      metadata: input.metadata,
      valid_from: input.valid_from,
      valid_to: input.valid_to,
    },
  );

  logger.info('graph', 'Relation created/updated', {
    id: relation.id,
    type: input.relation_type,
    source: input.source_entity_id,
    target: input.target_entity_id,
  });
  metrics.increment('graph.relation_created');

  return relation;
}

// ─── query_graph ────────────────────────────────────────────────────
export interface QueryGraphInput {
  readonly entity_id?: string;
  readonly entity_name?: string;
  readonly namespace?: string;
  readonly max_depth?: number;
  readonly relation_types?: readonly string[];
  readonly valid_at?: string;
  readonly limit?: number;
}

export function queryGraph(
  input: QueryGraphInput,
  db: Database.Database,
  config: NeuromcpConfig,
  logger: Logger,
  metrics: Metrics,
): GraphQueryResult {
  const namespace = input.namespace ?? config.defaultNamespace;
  const start = Date.now();

  let entityId = input.entity_id;

  // If name provided instead of ID, find the entity
  if (entityId === undefined && input.entity_name !== undefined) {
    const found = searchEntities(db, input.entity_name, namespace, 1);
    if (found.length === 0) {
      return { nodes: [], edges: [], traversal_depth: 0 };
    }
    entityId = found[0]!.id;
  }

  if (entityId === undefined) {
    return { nodes: [], edges: [], traversal_depth: 0 };
  }

  const result = traverseGraph(db, entityId, {
    maxDepth: input.max_depth,
    relation_types: input.relation_types,
    valid_at: input.valid_at,
    limit: input.limit,
  });

  logger.info('graph', 'Graph query complete', {
    startEntity: entityId,
    nodes: result.nodes.length,
    edges: result.edges.length,
    depth: result.traversal_depth,
  });
  metrics.increment('graph.queries');
  metrics.record('graph.query_duration_ms', Date.now() - start);

  return result;
}
