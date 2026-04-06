export type TrustLevel = 'high' | 'medium' | 'low' | 'unverified';
export type Visibility = 'private' | 'namespace' | 'global';
export type MemorySource = 'user' | 'auto' | 'consolidation' | 'claude-code' | 'error';
export type ConsolidationAction = 'merge' | 'prune' | 'decay' | 'reindex' | 'tombstone';
export type OperationType = 'consolidate' | 'reindex' | 'import' | 'export';
export type OperationStatus = 'running' | 'completed' | 'failed' | 'cancelled';

// ─── Knowledge Graph Types ──────────────────────────────────────────
export type RelationType =
  | 'causes'
  | 'fixes'
  | 'contradicts'
  | 'relates_to'
  | 'part_of'
  | 'depends_on'
  | 'supersedes'
  | 'similar_to';

export interface Entity {
  readonly id: string;
  readonly name: string;
  readonly entity_type: string;
  readonly namespace: string;
  readonly metadata: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly is_deleted: number;
}

export interface Relation {
  readonly id: string;
  readonly source_entity_id: string;
  readonly target_entity_id: string;
  readonly relation_type: string;
  readonly weight: number;
  readonly metadata: string;
  readonly namespace: string;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly created_at: string;
  readonly is_deleted: number;
}

export interface MemoryEntity {
  readonly memory_id: string;
  readonly entity_id: string;
  readonly role: string;
}

// ─── Contradiction Types ────────────────────────────────────────────
export interface Contradiction {
  readonly existing_id: string;
  readonly new_content: string;
  readonly existing_content: string;
  readonly similarity: number;
  readonly resolution: 'supersede' | 'coexist' | 'flag';
}

export interface Memory {
  readonly id: string;
  readonly content: string;
  readonly summary: string | null;
  readonly content_hash: string;
  readonly embedding_model: string;
  readonly embedding_dim: number;
  readonly namespace: string;
  readonly project_id: string | null;
  readonly agent_id: string | null;
  readonly source: MemorySource;
  readonly source_trust: TrustLevel;
  readonly visibility: Visibility;
  readonly schema_version: number;
  readonly category: string;
  readonly tags: string;
  readonly importance: number;
  readonly access_count: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_accessed_at: string | null;
  readonly expires_at: string | null;
  readonly is_deleted: number;
  readonly tombstoned_at: string | null;
  readonly supersedes_id: string | null;
  readonly superseded_by_id: string | null;
  readonly metadata: string;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly surprise_score: number;
  readonly episode_id: string | null;
  readonly cluster_id: string | null;
  readonly review_interval_days: number | null;
  readonly ease_factor: number;
  readonly next_review_at: string | null;
  readonly review_count: number;
}

export interface MemoryWithScore extends Memory {
  readonly similarity_score: number;
}

export interface StoreResult {
  readonly id: string;
  readonly matched: boolean;
  readonly similarity?: number;
}

export interface ForgetResult {
  readonly count: number;
  readonly ids: readonly string[];
  readonly dry_run: boolean;
}

export interface ProposedMerge {
  readonly keep_id: string;
  readonly tombstone_id: string;
  readonly similarity: number;
  readonly merged_tags: readonly string[];
  readonly merged_importance: number;
  readonly reason: string;
}

export interface ProposedDecay {
  readonly id: string;
  readonly current_importance: number;
  readonly new_importance: number;
  readonly days_since_access: number;
}

export interface ProposedPrune {
  readonly id: string;
  readonly importance: number;
  readonly access_count: number;
  readonly age_days: number;
  readonly reason: string;
}

export interface ProposedSweep {
  readonly id: string;
  readonly expired_at: string;
}

export interface ConsolidationPlan {
  readonly operation_id: string;
  readonly namespace: string;
  readonly created_at: string;
  readonly proposed_merges: readonly ProposedMerge[];
  readonly proposed_decays: readonly ProposedDecay[];
  readonly proposed_prunes: readonly ProposedPrune[];
  readonly proposed_ttl_sweeps: readonly ProposedSweep[];
  readonly summary: {
    readonly merge_count: number;
    readonly decay_count: number;
    readonly prune_count: number;
    readonly sweep_count: number;
  };
}

export interface ConsolidationResult {
  readonly operation_id: string;
  readonly merged: number;
  readonly decayed: number;
  readonly pruned: number;
  readonly swept: number;
}

export interface MemoryStats {
  readonly total: number;
  readonly by_category: Record<string, number>;
  readonly by_source: Record<string, number>;
  readonly by_trust: Record<string, number>;
  readonly avg_importance: number;
  readonly oldest: string | null;
  readonly newest: string | null;
  readonly embedding_model: string;
  readonly db_size_bytes: number;
  readonly last_consolidation: string | null;
  readonly tombstone_count: number;
}

export interface OperationRecord {
  readonly id: string;
  readonly type: OperationType;
  readonly status: OperationStatus;
  readonly namespace: string | null;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly items_total: number | null;
  readonly items_processed: number;
  readonly error: string | null;
  readonly metadata: string;
}

// ─── Graph Query Results ────────────────────────────────────────────
export interface GraphNode {
  readonly entity: Entity;
  readonly memory_count: number;
}

export interface GraphEdge {
  readonly relation: Relation;
  readonly source_name: string;
  readonly target_name: string;
}

export interface GraphQueryResult {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly traversal_depth: number;
}

// ─── Episodes (Laag 1: Episodisch Geheugen) ────────────────────────
export interface Episode {
  readonly id: string;
  readonly title: string;
  readonly namespace: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly summary: string | null;
  readonly metadata: string;
}

export interface EpisodeWithStats extends Episode {
  readonly memory_count: number;
}

// ─── Backfill Result ────────────────────────────────────────────────
export interface BackfillResult {
  readonly total: number;
  readonly embedded: number;
  readonly skipped: number;
  readonly errors: number;
}

// ─── Store Result extended ──────────────────────────────────────────
export interface StoreResultExtended extends StoreResult {
  readonly contradictions?: readonly Contradiction[];
  readonly surprise_score?: number;
  readonly entities_extracted?: readonly string[];
}
