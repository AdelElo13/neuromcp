import type { Database } from 'better-sqlite3';

export const SCHEMA_VERSION = 13;

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT,
    embedding_model TEXT NOT NULL DEFAULT '',
    embedding_dim INTEGER NOT NULL DEFAULT 0,
    namespace TEXT NOT NULL DEFAULT 'default',
    project_id TEXT,
    agent_id TEXT,
    source TEXT NOT NULL DEFAULT 'user',
    source_trust TEXT NOT NULL DEFAULT 'medium',
    visibility TEXT NOT NULL DEFAULT 'namespace',
    schema_version INTEGER NOT NULL DEFAULT 1,
    category TEXT NOT NULL DEFAULT 'general',
    tags TEXT NOT NULL DEFAULT '[]',
    importance REAL NOT NULL DEFAULT 0.5,
    access_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_accessed_at TEXT,
    expires_at TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    tombstoned_at TEXT,
    supersedes_id TEXT,
    superseded_by_id TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    valid_from TEXT,
    valid_to TEXT,
    surprise_score REAL NOT NULL DEFAULT 0.0,
    episode_id TEXT REFERENCES episodes(id),
    cluster_id TEXT REFERENCES clusters(id),
    review_interval_days REAL,
    ease_factor REAL DEFAULT 2.5,
    next_review_at TEXT,
    review_count INTEGER NOT NULL DEFAULT 0,
    -- v13: recall planner metadata (nullable for backwards compat)
    source_type TEXT,
    source_path TEXT,
    project TEXT,
    kind TEXT,
    happened_at TEXT
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'default',
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ended_at TEXT,
    summary TEXT,
    metadata TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS consolidation_log (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    action TEXT NOT NULL,
    source_ids TEXT NOT NULL DEFAULT '[]',
    result_id TEXT,
    plan_snapshot TEXT,
    reason TEXT,
    namespace TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    namespace TEXT,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    completed_at TEXT,
    items_total INTEGER,
    items_processed INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    metadata TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    description TEXT
  );

  -- Knowledge Graph: Entities
  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'concept',
    namespace TEXT NOT NULL DEFAULT 'default',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    is_deleted INTEGER NOT NULL DEFAULT 0
  );

  -- Knowledge Graph: Relations (typed edges with temporal validity)
  CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    source_entity_id TEXT NOT NULL REFERENCES entities(id),
    target_entity_id TEXT NOT NULL REFERENCES entities(id),
    relation_type TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 1.0,
    metadata TEXT NOT NULL DEFAULT '{}',
    namespace TEXT NOT NULL DEFAULT 'default',
    valid_from TEXT,
    valid_to TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    is_deleted INTEGER NOT NULL DEFAULT 0
  );

  -- Junction: memories <-> entities
  CREATE TABLE IF NOT EXISTS memory_entities (
    memory_id TEXT NOT NULL REFERENCES memories(id),
    entity_id TEXT NOT NULL REFERENCES entities(id),
    role TEXT NOT NULL DEFAULT 'mentioned',
    PRIMARY KEY (memory_id, entity_id)
  );

  -- Clusters: semantic groupings of related memories
  CREATE TABLE IF NOT EXISTS clusters (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    label TEXT,
    centroid_memory_id TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Junction: memories <-> clusters (with distance score)
  CREATE TABLE IF NOT EXISTS memory_clusters (
    memory_id TEXT NOT NULL REFERENCES memories(id),
    cluster_id TEXT NOT NULL REFERENCES clusters(id),
    distance REAL NOT NULL DEFAULT 0.0,
    PRIMARY KEY (memory_id, cluster_id)
  );

  -- Agent profiles for multi-agent sharing
  CREATE TABLE IF NOT EXISTS agent_profiles (
    agent_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'default',
    expertise TEXT NOT NULL DEFAULT '[]',
    memory_count INTEGER NOT NULL DEFAULT 0,
    last_active TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Verbatim: raw conversation text, never consolidated or pruned
  CREATE TABLE IF NOT EXISTS verbatim (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'default',
    agent_id TEXT,
    episode_id TEXT REFERENCES episodes(id),
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Claims: atomic verifiable facts extracted from memories
  CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories(id),
    content TEXT NOT NULL,
    subject TEXT,
    predicate TEXT,
    object TEXT,
    confidence REAL NOT NULL DEFAULT 0.5,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

const CREATE_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
  CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
  CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
  CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
  CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
  CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);
  CREATE INDEX IF NOT EXISTS idx_memories_is_deleted ON memories(is_deleted);
  CREATE INDEX IF NOT EXISTS idx_memories_expires_at ON memories(expires_at);
  CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id);
  CREATE INDEX IF NOT EXISTS idx_memories_agent_id ON memories(agent_id);
  CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
  CREATE INDEX IF NOT EXISTS idx_memories_namespace_deleted ON memories(namespace, is_deleted);
  CREATE INDEX IF NOT EXISTS idx_consolidation_log_operation_id ON consolidation_log(operation_id);
  CREATE INDEX IF NOT EXISTS idx_consolidation_log_namespace ON consolidation_log(namespace);
  CREATE INDEX IF NOT EXISTS idx_operations_type ON operations(type);
  CREATE INDEX IF NOT EXISTS idx_operations_status ON operations(status);
  CREATE INDEX IF NOT EXISTS idx_operations_namespace ON operations(namespace);
  CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
  CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
  CREATE INDEX IF NOT EXISTS idx_entities_namespace ON entities(namespace);
  CREATE INDEX IF NOT EXISTS idx_entities_deleted ON entities(is_deleted);
  CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id);
  CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id);
  CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type);
  CREATE INDEX IF NOT EXISTS idx_relations_namespace ON relations(namespace);
  CREATE INDEX IF NOT EXISTS idx_relations_validity ON relations(valid_from, valid_to);
  CREATE INDEX IF NOT EXISTS idx_memory_entities_memory ON memory_entities(memory_id);
  CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_id);
  CREATE INDEX IF NOT EXISTS idx_memories_valid_from ON memories(valid_from);
  CREATE INDEX IF NOT EXISTS idx_memories_valid_to ON memories(valid_to);
  CREATE INDEX IF NOT EXISTS idx_claims_memory_id ON claims(memory_id);
  CREATE INDEX IF NOT EXISTS idx_claims_subject ON claims(subject);
  CREATE INDEX IF NOT EXISTS idx_claims_confidence ON claims(confidence);
  CREATE INDEX IF NOT EXISTS idx_episodes_namespace ON episodes(namespace);
  CREATE INDEX IF NOT EXISTS idx_episodes_started_at ON episodes(started_at);
  CREATE INDEX IF NOT EXISTS idx_memories_episode_id ON memories(episode_id);
  CREATE INDEX IF NOT EXISTS idx_clusters_namespace ON clusters(namespace);
  CREATE INDEX IF NOT EXISTS idx_memories_cluster_id ON memories(cluster_id);
  CREATE INDEX IF NOT EXISTS idx_memory_clusters_memory ON memory_clusters(memory_id);
  CREATE INDEX IF NOT EXISTS idx_memory_clusters_cluster ON memory_clusters(cluster_id);
  CREATE INDEX IF NOT EXISTS idx_memories_next_review ON memories(next_review_at);
  CREATE INDEX IF NOT EXISTS idx_agent_profiles_namespace ON agent_profiles(namespace);
  CREATE INDEX IF NOT EXISTS idx_verbatim_namespace ON verbatim(namespace);
  CREATE INDEX IF NOT EXISTS idx_verbatim_episode_id ON verbatim(episode_id);
  CREATE INDEX IF NOT EXISTS idx_verbatim_agent_id ON verbatim(agent_id);
  CREATE INDEX IF NOT EXISTS idx_verbatim_created_at ON verbatim(created_at);
  CREATE INDEX IF NOT EXISTS idx_verbatim_content_hash ON verbatim(content_hash);

  -- v9: retrieval attribution + usefulness prior
  CREATE TABLE IF NOT EXISTS retrieval_events (
    id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    query_hash TEXT NOT NULL,
    namespace TEXT NOT NULL DEFAULT 'default',
    session_id TEXT,
    retrieved_ids TEXT NOT NULL DEFAULT '[]',
    cited_ids TEXT NOT NULL DEFAULT '[]',
    outcome TEXT,
    critic_reason TEXT,
    model TEXT,
    critiqued_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_retrieval_events_session ON retrieval_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_retrieval_events_namespace ON retrieval_events(namespace);
  CREATE INDEX IF NOT EXISTS idx_retrieval_events_created ON retrieval_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_retrieval_events_outcome ON retrieval_events(outcome);
  CREATE INDEX IF NOT EXISTS idx_retrieval_events_query_hash ON retrieval_events(query_hash);

  CREATE TABLE IF NOT EXISTS memory_usefulness (
    memory_id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL DEFAULT 'default',
    helpful_count INTEGER NOT NULL DEFAULT 0,
    neutral_count INTEGER NOT NULL DEFAULT 0,
    harmful_count INTEGER NOT NULL DEFAULT 0,
    total_observed INTEGER NOT NULL DEFAULT 0,
    usefulness_score REAL NOT NULL DEFAULT 0.5,
    last_updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    decay_floor REAL NOT NULL DEFAULT 0.5,
    last_critiqued_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_memory_usefulness_namespace ON memory_usefulness(namespace);
  CREATE INDEX IF NOT EXISTS idx_memory_usefulness_score ON memory_usefulness(usefulness_score);

  -- v11: normalised retrieval-memory join + FK cascade for usefulness.
  CREATE TABLE IF NOT EXISTS retrieval_event_memories (
    event_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    rank INTEGER NOT NULL DEFAULT 0,
    was_cited INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, memory_id),
    FOREIGN KEY (event_id) REFERENCES retrieval_events(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_rem_memory ON retrieval_event_memories(memory_id);
  CREATE INDEX IF NOT EXISTS idx_rem_cited ON retrieval_event_memories(was_cited);

  -- v13: recall layer extension tables (Codex SOTA spec).
  -- Power the six-layer auto-retrieve hook: working-context, semantic-cards,
  -- situation-graph (atoms+edges+activation), pre-compiled situation_states,
  -- and replay_queue. All idempotent.

  -- Working context: hot table — active goal, open plan, constraints, prefs.
  CREATE TABLE IF NOT EXISTS working_context (
    key            TEXT PRIMARY KEY,
    namespace      TEXT NOT NULL DEFAULT 'default',
    project        TEXT,
    kind           TEXT NOT NULL,
    value_json     TEXT NOT NULL,
    salience       REAL NOT NULL DEFAULT 0.5,
    evidence_ids   TEXT NOT NULL DEFAULT '[]',
    expires_at     TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_wc_kind     ON working_context(kind);
  CREATE INDEX IF NOT EXISTS idx_wc_project  ON working_context(project);
  CREATE INDEX IF NOT EXISTS idx_wc_expires  ON working_context(expires_at);
  CREATE INDEX IF NOT EXISTS idx_wc_salience ON working_context(salience DESC);

  -- Semantic cards: distilled "what is currently true about subject Y".
  CREATE TABLE IF NOT EXISTS semantic_cards (
    id              TEXT PRIMARY KEY,
    namespace       TEXT NOT NULL DEFAULT 'default',
    project         TEXT,
    card_type       TEXT NOT NULL,
    subject         TEXT NOT NULL,
    current_value   TEXT NOT NULL,
    confidence      REAL NOT NULL DEFAULT 0.7,
    valid_from      TEXT,
    valid_to        TEXT,
    superseded_by_id TEXT REFERENCES semantic_cards(id),
    source_hash     TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sc_project        ON semantic_cards(project);
  CREATE INDEX IF NOT EXISTS idx_sc_card_type      ON semantic_cards(card_type);
  CREATE INDEX IF NOT EXISTS idx_sc_subject        ON semantic_cards(subject);
  CREATE INDEX IF NOT EXISTS idx_sc_valid_to       ON semantic_cards(valid_to);
  CREATE INDEX IF NOT EXISTS idx_sc_superseded_by  ON semantic_cards(superseded_by_id);

  CREATE TABLE IF NOT EXISTS semantic_card_evidence (
    card_id     TEXT NOT NULL REFERENCES semantic_cards(id) ON DELETE CASCADE,
    memory_id   TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'supports',
    weight      REAL NOT NULL DEFAULT 1.0,
    added_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (card_id, memory_id)
  );
  CREATE INDEX IF NOT EXISTS idx_sce_memory ON semantic_card_evidence(memory_id);

  -- Situation graph: atoms, edges, activation cache, pre-compiled packets.
  CREATE TABLE IF NOT EXISTS memory_atoms (
    id            TEXT PRIMARY KEY,
    atom_type     TEXT NOT NULL,
    source_table  TEXT NOT NULL,
    source_id     TEXT NOT NULL,
    namespace     TEXT NOT NULL DEFAULT 'default',
    project       TEXT,
    subject       TEXT NOT NULL,
    body          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active',
    salience      REAL NOT NULL DEFAULT 0.5,
    confidence    REAL NOT NULL DEFAULT 0.7,
    valid_from    TEXT,
    valid_to      TEXT,
    metadata      TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_atoms_type      ON memory_atoms(atom_type);
  CREATE INDEX IF NOT EXISTS idx_atoms_project   ON memory_atoms(project);
  CREATE INDEX IF NOT EXISTS idx_atoms_subject   ON memory_atoms(subject);
  CREATE INDEX IF NOT EXISTS idx_atoms_status    ON memory_atoms(status);
  CREATE INDEX IF NOT EXISTS idx_atoms_source    ON memory_atoms(source_table, source_id);
  CREATE INDEX IF NOT EXISTS idx_atoms_salience  ON memory_atoms(salience DESC);

  CREATE TABLE IF NOT EXISTS memory_edges (
    src_atom_id   TEXT NOT NULL REFERENCES memory_atoms(id) ON DELETE CASCADE,
    dst_atom_id   TEXT NOT NULL REFERENCES memory_atoms(id) ON DELETE CASCADE,
    edge_type     TEXT NOT NULL,
    weight        REAL NOT NULL DEFAULT 1.0,
    polarity      REAL NOT NULL DEFAULT 1.0,
    evidence_id   TEXT,
    reason        TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (src_atom_id, dst_atom_id, edge_type)
  );
  CREATE INDEX IF NOT EXISTS idx_edges_src       ON memory_edges(src_atom_id);
  CREATE INDEX IF NOT EXISTS idx_edges_dst       ON memory_edges(dst_atom_id);
  CREATE INDEX IF NOT EXISTS idx_edges_type      ON memory_edges(edge_type);

  CREATE TABLE IF NOT EXISTS activation_cache (
    seed_key      TEXT NOT NULL,
    atom_id       TEXT NOT NULL REFERENCES memory_atoms(id) ON DELETE CASCADE,
    ppr_score     REAL NOT NULL,
    reason        TEXT,
    computed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (seed_key, atom_id)
  );
  CREATE INDEX IF NOT EXISTS idx_act_seed        ON activation_cache(seed_key);
  CREATE INDEX IF NOT EXISTS idx_act_score       ON activation_cache(seed_key, ppr_score DESC);

  CREATE TABLE IF NOT EXISTS situation_states (
    id            TEXT PRIMARY KEY,
    project       TEXT,
    goal_key      TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    state_json    TEXT NOT NULL DEFAULT '{}',
    packet_text   TEXT NOT NULL,
    evidence_ids  TEXT NOT NULL DEFAULT '[]',
    expires_at    TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sit_project     ON situation_states(project);
  CREATE INDEX IF NOT EXISTS idx_sit_status      ON situation_states(status);
  CREATE INDEX IF NOT EXISTS idx_sit_expires     ON situation_states(expires_at);

  -- Replay queue: hippocampal sharp-wave-ripple analogue.
  CREATE TABLE IF NOT EXISTS replay_queue (
    id              TEXT PRIMARY KEY,
    atom_id         TEXT NOT NULL REFERENCES memory_atoms(id) ON DELETE CASCADE,
    project         TEXT,
    reason          TEXT NOT NULL,
    strength        REAL NOT NULL DEFAULT 0.5,
    due_at          TEXT NOT NULL,
    last_shown_at   TEXT,
    shown_count     INTEGER NOT NULL DEFAULT 0,
    suppressed_until TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_rq_due       ON replay_queue(due_at);
  CREATE INDEX IF NOT EXISTS idx_rq_project   ON replay_queue(project);
  CREATE INDEX IF NOT EXISTS idx_rq_strength  ON replay_queue(strength DESC);
  CREATE INDEX IF NOT EXISTS idx_rq_atom      ON replay_queue(atom_id);

  -- v13: recall planner indexes on memories metadata cols
  CREATE INDEX IF NOT EXISTS idx_memories_project    ON memories(project);
  CREATE INDEX IF NOT EXISTS idx_memories_kind       ON memories(kind);
  CREATE INDEX IF NOT EXISTS idx_memories_happened   ON memories(happened_at);
  CREATE INDEX IF NOT EXISTS idx_memories_src_type   ON memories(source_type);
`;

function ftsTableExists(db: Database): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
  ).get() as { name: string } | undefined;
  return row !== undefined;
}

function tableExists(db: Database, name: string): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name) as { name: string } | undefined;
  return row !== undefined;
}

export function applySchema(db: Database): void {
  db.exec(CREATE_TABLES);
  db.exec(CREATE_INDEXES);

  if (!ftsTableExists(db)) {
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        summary,
        tags,
        category,
        content='memories',
        content_rowid='rowid'
      );
    `);
  }

  // Verbatim FTS5 with auto-sync triggers
  if (!tableExists(db, 'verbatim_fts')) {
    db.exec(`
      CREATE VIRTUAL TABLE verbatim_fts USING fts5(
        content,
        content='verbatim',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS verbatim_ai AFTER INSERT ON verbatim BEGIN
        INSERT INTO verbatim_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS verbatim_ad AFTER DELETE ON verbatim BEGIN
        INSERT INTO verbatim_fts(verbatim_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
    `);
  }
}
