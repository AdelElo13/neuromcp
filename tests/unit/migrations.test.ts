import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { openDatabase, closeDatabase } from '../../src/storage/database.js';
import { SCHEMA_VERSION } from '../../src/storage/schema.js';
import { runMigrations, retypeProvenMemoryProxies, pruneUnsupportedAutoContradictions } from '../../src/storage/migrations.js';
import { createLogger } from '../../src/observability/logger.js';
import { MEMORY_PROXY_TYPE, legacyProxyEntityName } from '../../src/graph/memory-proxy.js';

function tmpDbPath(): string {
  return join(tmpdir(), `neuromcp-mig-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

const cleanupPaths: string[] = [];
const logger = createLogger({ level: 'error', format: 'text' });

function cleanup(p: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const full = `${p}${suffix}`;
      if (existsSync(full)) unlinkSync(full);
    } catch {
      // ignore
    }
  }
  // also clean up backup files
  try {
    for (let v = 0; v <= 10; v++) {
      const backup = `${p}.backup-v${v}`;
      if (existsSync(backup)) unlinkSync(backup);
    }
  } catch {
    // ignore
  }
}

afterEach(() => {
  closeDatabase();
  for (const p of cleanupPaths) {
    cleanup(p);
  }
  cleanupPaths.length = 0;
});

describe('runMigrations', () => {
  it('applies schema on a fresh database', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    runMigrations(db, dbPath, logger);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('memories');
    expect(tableNames).toContain('schema_version');
    expect(tableNames).toContain('memories_fts');
  });

  it('records the schema version', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    runMigrations(db, dbPath, logger);

    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number };
    expect(row.version).toBe(SCHEMA_VERSION);
  });

  it('is idempotent — running twice does not fail', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    runMigrations(db, dbPath, logger);
    runMigrations(db, dbPath, logger);

    const rows = db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>;
    // Should still have exactly one version record (INSERT OR REPLACE)
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(SCHEMA_VERSION);
  });

  it('on fresh DB (version 0) does not create a backup', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    runMigrations(db, dbPath, logger);

    const backupPath = `${dbPath}.backup-v0`;
    expect(existsSync(backupPath)).toBe(false);
  });

  it('does not re-apply when already at current version', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    runMigrations(db, dbPath, logger);

    // Insert a canary row
    db.prepare("INSERT INTO memories (id, content_hash, content) VALUES ('canary', 'hash', 'test')").run();

    // Run migrations again — should be a no-op
    runMigrations(db, dbPath, logger);

    const row = db.prepare("SELECT id FROM memories WHERE id = 'canary'").get() as { id: string } | undefined;
    expect(row?.id).toBe('canary');
  });

  // v13: Codex SOTA recall layer — situation graph, semantic cards,
  // working context, replay queue, and memories.{source_type,source_path,
  // project,kind,happened_at}. The auto-retrieve hook reads ALL of these;
  // a fresh install previously left them missing, causing six-layer
  // recall to silently return empty additionalContext.
  it('v13: creates all recall-layer extension tables', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    runMigrations(db, dbPath, logger);

    const required = [
      'memory_atoms',
      'memory_edges',
      'activation_cache',
      'situation_states',
      'working_context',
      'semantic_cards',
      'semantic_card_evidence',
      'replay_queue',
    ];
    for (const name of required) {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(name) as { name: string } | undefined;
      expect(row?.name, `expected table "${name}" to exist after migration`).toBe(name);
    }
  });

  it('v13: adds recall-planner metadata columns to memories', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    runMigrations(db, dbPath, logger);

    const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    for (const col of ['source_type', 'source_path', 'project', 'kind', 'happened_at']) {
      expect(colNames.has(col), `expected memories.${col} column to exist`).toBe(true);
    }
  });

  it('v13: migrates a v12 database in place without dropping data', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);

    // Bootstrap a v12 schema by running migrations, then forcibly
    // rewriting the version row and dropping the v13 artifacts.
    runMigrations(db, dbPath, logger);
    db.prepare("INSERT INTO memories (id, content_hash, content) VALUES ('keep-me', 'hash', 'pre-v13 content')").run();

    db.prepare('DELETE FROM schema_version').run();
    db.prepare(
      "INSERT INTO schema_version (version, applied_at, description) VALUES (12, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'simulated v12')"
    ).run();
    // Drop the v13 tables to simulate a v12-era DB upgrading to v13.
    for (const t of ['replay_queue', 'situation_states', 'activation_cache', 'memory_edges', 'memory_atoms', 'semantic_card_evidence', 'semantic_cards', 'working_context']) {
      db.prepare(`DROP TABLE IF EXISTS ${t}`).run();
    }

    // Run again — should detect v12 → v13 and reconcile.
    runMigrations(db, dbPath, logger);

    // Pre-existing data preserved
    const keep = db.prepare("SELECT id FROM memories WHERE id='keep-me'").get() as { id: string } | undefined;
    expect(keep?.id).toBe('keep-me');

    // All v13 tables present
    const required = ['memory_atoms', 'situation_states', 'working_context', 'semantic_cards', 'replay_queue'];
    for (const name of required) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) as { name: string } | undefined;
      expect(row?.name, `expected table "${name}" after v12→v13 upgrade`).toBe(name);
    }

    // Version recorded as v13 (= SCHEMA_VERSION)
    const ver = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(ver.v).toBe(SCHEMA_VERSION);
  });

  it('v15: retypes legacy proxies on fingerprint + co-creation provenance; prunes only unsupported proxy-proxy edges', () => {
    const dbPath = tmpDbPath();
    cleanupPaths.push(dbPath);
    const db = openDatabase(dbPath);
    runMigrations(db, dbPath, logger);

    const T0 = '2026-09-10T10:00:00.000Z';          // proxies + their edges: same store() call
    const T0_EDGE = '2026-09-10T10:00:00.030Z';     // 30 ms later, as observed on the reference DB
    const insMem = db.prepare("INSERT INTO memories (id, content_hash, content) VALUES (?, ?, ?)");
    const insEnt = db.prepare("INSERT INTO entities (id, name, entity_type, namespace, created_at) VALUES (?, ?, ?, 'default', ?)");
    const link = db.prepare("INSERT INTO memory_entities (memory_id, entity_id, role) VALUES (?, ?, ?)");
    const insRel = db.prepare("INSERT INTO relations (id, source_entity_id, target_entity_id, relation_type, metadata, created_at) VALUES (?, ?, ?, 'contradicts', ?, ?)");
    const AUTO = '{"resolution":"coexist","auto":true}';

    // 1. Two daily reports, one legacy proxy each (type 'memory', legacy
    //    name), joined by the automatic edge they were created for. No claim
    //    evidence between reports → the edge must be pruned.
    const reportA = 'Consolidation run on 2026-09-13 merged 258 decayed 2255 pruned 0';
    const reportB = 'Consolidation run on 2026-09-14 merged 260 decayed 2100 pruned 3';
    insMem.run('m-a', 'h-a', reportA); insMem.run('m-b', 'h-b', reportB);
    insEnt.run('p-a', legacyProxyEntityName(reportA), 'memory', T0);
    insEnt.run('p-b', legacyProxyEntityName(reportB), 'memory', T0);
    link.run('m-a', 'p-a', 'subject'); link.run('m-b', 'p-b', 'subject');
    insRel.run('r-ab', 'p-b', 'p-a', AUTO, T0_EDGE);

    // 2. A claim-backed legacy pair whose edge must SURVIVE.
    const claimD = 'the project uses React 18 on the customer portal';
    const claimE = 'the project uses Svelte 5 on the customer portal';
    insMem.run('m-d', 'h-d', claimD); insMem.run('m-e', 'h-e', claimE);
    insEnt.run('p-d', legacyProxyEntityName(claimD), 'memory', T0);
    insEnt.run('p-e', legacyProxyEntityName(claimE), 'memory', T0);
    link.run('m-d', 'p-d', 'subject'); link.run('m-e', 'p-e', 'subject');
    insRel.run('r-de', 'p-e', 'p-d', AUTO, T0_EDGE);

    // 3. Shared legacy proxy (Codex round 4): two memories with the same
    //    60-character opening share ONE proxy; only the second carries the
    //    claim. The edge to the contradicting memory must be kept.
    const opening = 'Weekly maintenance summary for the Atlas platform team, week 37. ';
    const sharedA = `${opening}No changes.`;
    const sharedB = `${opening}The project uses React 18.`;
    const claimC = 'The project uses Svelte 5 on the portal.';
    expect(legacyProxyEntityName(sharedA)).toBe(legacyProxyEntityName(sharedB));
    insMem.run('m-s1', 'h-s1', sharedA); insMem.run('m-s2', 'h-s2', sharedB); insMem.run('m-c2', 'h-c2', claimC);
    insEnt.run('p-s', legacyProxyEntityName(sharedA), 'memory', T0);
    insEnt.run('p-c2', legacyProxyEntityName(claimC), 'memory', T0);
    link.run('m-s1', 'p-s', 'subject'); link.run('m-s2', 'p-s', 'subject'); link.run('m-c2', 'p-c2', 'subject');
    insRel.run('r-sc', 'p-c2', 'p-s', AUTO, T0_EDGE);

    // 4. Look-alike user entities that must stay untouched:
    //    u-1 unlinked; u-2 linked to a memory with a different derived name;
    //    u-3 exact-name coincidence linked as 'mention', no edge;
    //    u-4 exact name + subject link but a NON-automatic edge;
    //    u-5 (Codex round 4): exact name + subject link + automatic edge —
    //        but created 9 days BEFORE the edge: the system reused a user
    //        entity as an endpoint. Fingerprint complete, provenance absent.
    insEnt.run('u-1', 'memory:working', 'memory', T0);
    insEnt.run('u-2', 'memory:scratch notes', 'memory', T0); link.run('m-a', 'u-2', 'mention');
    const reportC = 'Consolidation run on 2026-09-15 merged 1 decayed 2 pruned 3';
    insMem.run('m-c', 'h-c', reportC);
    insEnt.run('u-3', legacyProxyEntityName(reportC), 'memory', T0); link.run('m-c', 'u-3', 'mention');
    insMem.run('m-w', 'h-w', 'working');
    expect(legacyProxyEntityName('working')).toBe('memory:working');
    insEnt.run('u-4', 'memory:working', 'memory', T0); link.run('m-w', 'u-4', 'subject');
    insRel.run('r-w', 'u-4', 'u-1', '{}', T0_EDGE);
    const userFact = 'the project uses React 18';
    insMem.run('m-x', 'h-x', userFact);
    insEnt.run('u-5', legacyProxyEntityName(userFact), 'memory', '2026-09-01T00:00:00.000Z');
    link.run('m-x', 'u-5', 'subject');
    insRel.run('r-x5', 'u-5', 'p-a', AUTO, T0_EDGE);

    db.prepare('DELETE FROM schema_version').run();
    db.prepare(
      "INSERT INTO schema_version (version, applied_at, description) VALUES (14, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'simulated v14')",
    ).run();

    runMigrations(db, dbPath, logger);

    const typeOf = (id: string): string =>
      (db.prepare('SELECT entity_type FROM entities WHERE id = ?').get(id) as { entity_type: string }).entity_type;
    for (const id of ['p-a', 'p-b', 'p-d', 'p-e', 'p-s', 'p-c2']) expect(typeOf(id), id).toBe(MEMORY_PROXY_TYPE);
    for (const id of ['u-1', 'u-2', 'u-3', 'u-4', 'u-5']) expect(typeOf(id), id).toBe('memory');

    const metaOf = (id: string): { proxy_for_memory_id?: string; proxy_for_memory_ids?: string[]; retyped_from?: string } =>
      JSON.parse((db.prepare('SELECT metadata FROM entities WHERE id = ?').get(id) as { metadata: string }).metadata);
    expect(metaOf('p-a')).toMatchObject({ proxy_for_memory_id: 'm-a', proxy_for_memory_ids: ['m-a'], retyped_from: 'memory' });
    expect(metaOf('p-s').proxy_for_memory_ids?.sort()).toEqual(['m-s1', 'm-s2']);

    const edge = (id: string): { is_deleted: number; metadata: string } =>
      db.prepare('SELECT is_deleted, metadata FROM relations WHERE id = ?').get(id) as { is_deleted: number; metadata: string };
    expect(edge('r-ab').is_deleted).toBe(1);
    expect(JSON.parse(edge('r-ab').metadata)).toMatchObject({ auto: true, removed_by: 'v15-no-claim-evidence' });
    expect(edge('r-de').is_deleted).toBe(0);
    expect(edge('r-sc').is_deleted).toBe(0);   // evidence via the shared proxy's second memory
    expect(edge('r-w').is_deleted).toBe(0);    // not automatic, not proxies
    expect(edge('r-x5').is_deleted).toBe(0);   // one endpoint is a real (user) entity

    const ver = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(ver.v).toBe(SCHEMA_VERSION);

    // Idempotent: a second run retypes and prunes nothing.
    expect(retypeProvenMemoryProxies(db)).toBe(0);
    expect(pruneUnsupportedAutoContradictions(db)).toBe(0);
  });
});
