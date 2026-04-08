import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { NeuromcpConfig } from '../config.js';
import type { VerbatimEntry, VerbatimWithScore, VerbatimStats } from '../types.js';
import { maybeCheckpointWal } from '../storage/database.js';

function generateId(): string {
  return createHash('sha256')
    .update(Date.now() + '-' + Math.random())
    .digest('hex')
    .slice(0, 32);
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ─── Store Verbatim ────────────────────────────────────────────────

export interface StoreVerbatimInput {
  readonly content: string;
  readonly namespace?: string;
  readonly agent_id?: string;
  readonly episode_id?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface StoreVerbatimResult {
  readonly id: string;
  readonly deduplicated: boolean;
}

export function storeVerbatim(
  input: StoreVerbatimInput,
  db: Database.Database,
  config: NeuromcpConfig,
  logger: Logger,
  metrics: Metrics,
): StoreVerbatimResult {
  const namespace = input.namespace ?? config.defaultNamespace;
  const hash = contentHash(input.content);

  // Exact dedup by content hash + namespace
  const existing = db.prepare(
    'SELECT id FROM verbatim WHERE content_hash = ? AND namespace = ? LIMIT 1',
  ).get(hash, namespace) as { id: string } | undefined;

  if (existing !== undefined) {
    logger.debug('verbatim', 'exact dedup', { id: existing.id });
    metrics.increment('verbatim.dedup');
    return { id: existing.id, deduplicated: true };
  }

  const id = generateId();
  const metadataJson = JSON.stringify(input.metadata ?? {});

  db.prepare(`
    INSERT INTO verbatim (id, content, content_hash, namespace, agent_id, episode_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.content, hash, namespace, input.agent_id ?? null, input.episode_id ?? null, metadataJson);

  maybeCheckpointWal(db);

  logger.info('verbatim', 'stored', { id, namespace, length: input.content.length });
  metrics.increment('verbatim.stored');

  return { id, deduplicated: false };
}

// ─── Search Verbatim ───────────────────────────────────────────────

export interface SearchVerbatimInput {
  readonly query: string;
  readonly namespace?: string;
  readonly limit?: number;
  readonly after?: string;
  readonly before?: string;
  readonly episode_id?: string;
  readonly agent_id?: string;
}

function sanitizeFtsQuery(query: string): string {
  // Remove special FTS5 characters, split into words, join with OR for broad matching
  const words = query
    .replace(/[*"():^{}[\]]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2); // skip tiny words

  if (words.length === 0) return '"' + query.replace(/"/g, '""') + '"';

  // Use OR matching: each word contributes independently
  return words.map((w) => '"' + w.replace(/"/g, '""') + '"').join(' OR ');
}

export function searchVerbatim(
  input: SearchVerbatimInput,
  db: Database.Database,
  config: NeuromcpConfig,
  logger: Logger,
  metrics: Metrics,
): readonly VerbatimWithScore[] {
  const start = Date.now();
  const namespace = input.namespace ?? config.defaultNamespace;
  const limit = input.limit ?? 10;

  const ftsQuery = sanitizeFtsQuery(input.query);

  // Build WHERE conditions for post-filtering
  const conditions: string[] = [];
  const params: unknown[] = [ftsQuery, limit * 3];

  let sql = `
    SELECT v.*, rank AS fts_rank
    FROM verbatim_fts f
    JOIN verbatim v ON v.rowid = f.rowid
    WHERE verbatim_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `;

  let rows: Array<VerbatimEntry & { fts_rank: number }>;
  try {
    rows = db.prepare(sql).all(...params) as Array<VerbatimEntry & { fts_rank: number }>;
  } catch {
    logger.warn('verbatim', 'FTS query failed', { query: input.query });
    rows = [];
  }

  // Post-filter
  const results: VerbatimWithScore[] = [];
  for (const row of rows) {
    if (results.length >= limit) break;
    if (namespace !== '*' && row.namespace !== namespace) continue;
    if (input.after !== undefined && row.created_at < input.after) continue;
    if (input.before !== undefined && row.created_at > input.before) continue;
    if (input.episode_id !== undefined && row.episode_id !== input.episode_id) continue;
    if (input.agent_id !== undefined && row.agent_id !== input.agent_id) continue;

    results.push({
      id: row.id,
      content: row.content,
      content_hash: row.content_hash,
      namespace: row.namespace,
      agent_id: row.agent_id,
      episode_id: row.episode_id,
      metadata: row.metadata,
      created_at: row.created_at,
      relevance_score: -row.fts_rank, // FTS5 rank is negative (lower = better)
      source: 'verbatim',
    });
  }

  logger.info('verbatim', 'search complete', {
    query: input.query,
    results: results.length,
    namespace,
  });
  metrics.increment('verbatim.searches');
  metrics.record('verbatim.search_duration_ms', Date.now() - start);

  return results;
}

// ─── Verbatim Stats ────────────────────────────────────────────────

export function verbatimStats(
  db: Database.Database,
  config: NeuromcpConfig,
  namespace?: string,
): VerbatimStats {
  const ns = namespace ?? config.defaultNamespace;
  const nsFilter = ns === '*' ? '' : 'WHERE namespace = ?';
  const nsParams = ns === '*' ? [] : [ns];

  const total = (db.prepare(`SELECT COUNT(*) as count FROM verbatim ${nsFilter}`).get(...nsParams) as { count: number }).count;

  const byNs = db.prepare('SELECT namespace, COUNT(*) as count FROM verbatim GROUP BY namespace').all() as Array<{ namespace: string; count: number }>;
  const by_namespace: Record<string, number> = {};
  for (const row of byNs) {
    by_namespace[row.namespace] = row.count;
  }

  const oldest = (db.prepare(`SELECT MIN(created_at) as val FROM verbatim ${nsFilter}`).get(...nsParams) as { val: string | null }).val;
  const newest = (db.prepare(`SELECT MAX(created_at) as val FROM verbatim ${nsFilter}`).get(...nsParams) as { val: string | null }).val;
  const sizeRow = (db.prepare(`SELECT SUM(LENGTH(content)) as val FROM verbatim ${nsFilter}`).get(...nsParams) as { val: number | null });
  const total_size_bytes = sizeRow.val ?? 0;

  return { total, by_namespace, oldest, newest, total_size_bytes };
}
