import { EventEmitter } from 'node:events';

/**
 * Global event bus for memory lifecycle events.
 * Emits SSE-compatible events for real-time integrations.
 *
 * Event types:
 * - memory:stored — new memory stored (includes id, namespace, surprise_score, contradictions)
 * - memory:updated — memory updated (dedup match, importance change)
 * - memory:forgotten — memory tombstoned
 * - memory:consolidated — consolidation cycle completed
 * - memory:entity_created — new entity in knowledge graph
 * - memory:relation_created — new relation in knowledge graph
 */

export interface MemoryEvent {
  readonly type: string;
  readonly data: unknown;
}

class MemoryEventBus extends EventEmitter {
  emitEvent(type: string, data: unknown): void {
    this.emit('memory', { type, data });
  }

  stored(data: {
    id: string;
    namespace: string;
    category: string;
    surprise_score: number;
    contradictions: number;
    entities_extracted: number;
  }): void {
    this.emitEvent('memory:stored', data);
  }

  updated(data: {
    id: string;
    reason: 'exact_dedup' | 'semantic_dedup';
    similarity: number;
  }): void {
    this.emitEvent('memory:updated', data);
  }

  forgotten(data: {
    count: number;
    ids: readonly string[];
  }): void {
    this.emitEvent('memory:forgotten', data);
  }

  consolidated(data: {
    operation_id: string;
    merged: number;
    decayed: number;
    pruned: number;
    swept: number;
  }): void {
    this.emitEvent('memory:consolidated', data);
  }

  entityCreated(data: {
    id: string;
    name: string;
    entity_type: string;
  }): void {
    this.emitEvent('memory:entity_created', data);
  }

  relationCreated(data: {
    id: string;
    relation_type: string;
    source: string;
    target: string;
  }): void {
    this.emitEvent('memory:relation_created', data);
  }
}

/** Singleton event bus — import from anywhere to emit or listen. */
export const eventBus = new MemoryEventBus();
