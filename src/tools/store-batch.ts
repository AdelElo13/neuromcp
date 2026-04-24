/**
 * store-batch.ts — fast-path bulk ingest for benchmarks and migrations.
 *
 * Skips dedup, contradiction detection, claim extraction, surprise scoring.
 * Does fast regex-based entity extraction (for the graph-boost path in
 * searchMemory to have something to spread over). Use storeMemory() for
 * production single-doc writes with all the safety machinery; use
 * storeMemoryBatch() when you have N trusted documents and need throughput.
 *
 * Speedup: ~100x for N>>1 because:
 *   - Single embedder.embedBatch() call instead of N embed() calls
 *   - Single transaction wrapping all INSERTs
 *   - No dedup query per doc (caller ensures uniqueness if needed)
 */
import { randomBytes, createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { VectorStore } from '../vectors/types.js';
import type { Logger } from '../observability/logger.js';
import { upsertEntity, linkMemoryEntity } from '../graph/entities.js';
import { extractEntitiesViaLLM } from '../graph/llm-entities.js';

// sprint2.3 Codex Q1 fix: bounded-concurrency runner for the LLM entity
// post-pass. Avoids p-limit dependency to keep neuromcp dependency-light.
async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]!();
    }
  });
  await Promise.all(workers);
  return results;
}

// Words that start sentences or are common but not proper nouns.
// Kept small and lowercased. Extracted entities filter against this to
// avoid storing "The", "When", "Today" etc. as entities.
const _STOPWORDS = new Set([
  'the', 'a', 'an', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'my', 'your',
  'his', 'her', 'our', 'their', 'me', 'him', 'us', 'them', 'this', 'that',
  'these', 'those', 'and', 'or', 'but', 'if', 'so', 'as', 'is', 'was', 'are',
  'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can', 'shall',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'about', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'up', 'down',
  'over', 'under', 'again', 'further', 'then', 'once', 'yes', 'no', 'not',
  'also', 'well', 'just', 'only', 'very', 'too', 'more', 'most', 'some',
  'any', 'all', 'each', 'every', 'other', 'such', 'no', 'own', 'same',
  'so', 'than', 'now', 'when', 'where', 'why', 'how', 'what', 'who', 'whom',
  'whose', 'which', 'today', 'yesterday', 'tomorrow', 'user', 'assistant',
  'question', 'answer', 'hi', 'hello', 'hey', 'ok', 'okay', 'thanks', 'thank',
  'please', 'sorry', 'actually', 'yeah', 'really', 'oh', 'wow', 'sure',
  'like', 'just', 'get', 'got', 'getting', 'make', 'made', 'making', 'take',
  'took', 'taking', 'go', 'went', 'going', 'come', 'came', 'coming', 'see',
  'saw', 'seeing', 'know', 'knew', 'knowing', 'think', 'thought', 'thinking',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
]);

/**
 * Fast regex-based proper-noun extraction for conversational text.
 * Captures single + multi-word Capitalized tokens that aren't stopwords
 * and aren't pure date prefixes. This is intentionally noisy — the graph
 * boost later tolerates false positives (they just don't match anything at
 * query time) but it CAN'T tolerate zero entities.
 *
 * Returns unique {name, type} pairs. Type is a best-guess bucket:
 *   - 'person' if name looks like a first name (single Capital word 3-12 chars
 *     that doesn't match common place suffixes). Noisy. Treated as 'name'.
 *   - 'name' for everything else.
 */
function extractConversationalEntities(content: string): Array<{ name: string; type: string }> {
  // Strip our inline date prefix [YYYY-MM-DD] and role labels so they don't
  // pollute the capture.
  const cleaned = content
    .replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '')
    .replace(/\b(user|assistant):\s*/gi, ' ');

  const seen = new Map<string, { name: string; type: string }>();

  // Pattern: sequences of 1-4 consecutive Capital-first tokens.
  const re = /\b([A-Z][a-z]{1,20})(?:\s+([A-Z][a-z]{1,20})){0,3}\b/g;
  for (const m of cleaned.matchAll(re)) {
    const phrase = m[0].trim();
    const lower = phrase.toLowerCase();
    // Skip if any token in the phrase is a stopword (filters "Monday breakfast"
    // → "Monday" alone, filters "The Zara Boots" → stays "Zara Boots")
    const tokens = lower.split(/\s+/);
    if (tokens.every(t => _STOPWORDS.has(t))) continue;
    // Skip if the whole phrase is just numbers/junk
    if (!/[a-z]/.test(lower)) continue;
    // Skip 1-token names that are stopwords
    if (tokens.length === 1 && _STOPWORDS.has(tokens[0]!)) continue;
    // Skip overly long phrases (likely sentence fragments)
    if (phrase.length > 60) continue;
    if (seen.has(lower)) continue;
    seen.set(lower, { name: phrase, type: 'name' });
    if (seen.size >= 40) break; // cap per chunk
  }

  return Array.from(seen.values());
}

export interface BatchStoreItem {
  content: string;
  namespace?: string;
  category?: string;
  tags?: string[];
  source?: string;
  source_trust?: string;
  importance?: number;
  metadata?: Record<string, unknown>;
}

export interface BatchStoreDeps {
  db: Database;
  embedder: EmbeddingProvider;
  vecStore: VectorStore;
  logger: Logger;
}

export async function storeMemoryBatch(
  itemsInput: BatchStoreItem[],
  deps: BatchStoreDeps,
): Promise<{ inserted: number; ids: string[]; embed_ms: number; insert_ms: number }> {
  const { db, embedder, vecStore, logger } = deps;
  let items: BatchStoreItem[] = itemsInput;
  if (items.length === 0) return { inserted: 0, ids: [], embed_ms: 0, insert_ms: 0 };

  // Split items longer than the embedder's effective context limit
  // (~2000 chars / ~500 tokens for nomic-embed-text via Ollama) into
  // multiple sub-memories so we don't lose semantics past the limit.
  // Truncating worked but caused vector search to miss content past the
  // first 2000 chars — fatal on long haystack chunks.
  const MAX_CHARS = 2000;
  const expanded: BatchStoreItem[] = [];
  for (const item of items) {
    if (item.content.length <= MAX_CHARS) {
      expanded.push(item);
      continue;
    }
    // Split on word boundary near MAX_CHARS to avoid cutting tokens
    let start = 0;
    while (start < item.content.length) {
      let end = Math.min(start + MAX_CHARS, item.content.length);
      if (end < item.content.length) {
        const lastSpace = item.content.lastIndexOf(' ', end);
        if (lastSpace > start + MAX_CHARS * 0.5) end = lastSpace;
      }
      expanded.push({ ...item, content: item.content.slice(start, end) });
      start = end;
    }
  }
  const t0 = Date.now();
  // Single batch embed — typically ~5-10ms per doc instead of ~200ms each
  const vectors = await embedder.embedBatch(expanded.map((i) => i.content));
  const embedMs = Date.now() - t0;
  // Reassign items so the rest of the function uses the expanded list
  items = expanded;

  const t1 = Date.now();
  const insertMem = db.prepare(`
    INSERT INTO memories
      (id, content_hash, content, namespace, source, source_trust, category, tags,
       importance, metadata, created_at, updated_at, schema_version, visibility,
       embedding_model, embedding_dim, access_count, is_deleted, surprise_score,
       ease_factor, review_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 12, 'namespace', ?, ?, 0, 0, 0, 2.5, 0)
  `);
  const insertFts = db.prepare(
    `INSERT INTO memories_fts (rowid, content, summary, tags, category)
       SELECT rowid, content, '', tags, category FROM memories WHERE id = ?`
  );

  const ids: string[] = [];
  const vecEntries: Array<{ id: string; vec: Float32Array }> = [];

  // Match an inline [YYYY-MM-DD] prefix on chunk content. AMB's neuromcp
  // provider prepends the session date as a visible timestamp; we parse it
  // out and use it as the row's created_at so temporal filters actually
  // work. Without this every row gets now() and time-scoped queries fail.
  const INLINE_DATE_RE = /^\[(\d{4}-\d{2}-\d{2})\]/;

  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const vec = vectors[i]!;
      const id = randomBytes(16).toString('hex');
      const hash = createHash('sha256').update(item.content).digest('hex');
      const dateMatch = INLINE_DATE_RE.exec(item.content);
      const createdAt = dateMatch
        ? new Date(dateMatch[1] + 'T00:00:00.000Z').toISOString()
        : now;
      insertMem.run(
        id, hash, item.content,
        item.namespace ?? 'default',
        item.source ?? 'auto',
        item.source_trust ?? 'medium',
        item.category ?? 'batch-ingest',
        JSON.stringify(item.tags ?? []),
        item.importance ?? 0.5,
        JSON.stringify(item.metadata ?? {}),
        createdAt, createdAt,
        embedder.name,
        embedder.dimensions,
      );
      insertFts.run(id);
      ids.push(id);
      vecEntries.push({ id, vec });

      // Fast regex entity extraction — populates the graph so searchMemory's
      // graph_boost path can do 1-hop spreading at query time. Silent
      // failures (upsertEntity throwing) shouldn't abort the batch; wrap
      // in try/catch. Mostly relevant for multi-session questions where
      // the answer-bearing turn is in a session sharing an entity with
      // the query but not the query's exact wording.
      //
      // sprint2.3 Codex Q3 fix: when NEUROMCP_LLM_ENTITIES=1 we SKIP this
      // regex pass — running both produces dual entity rows for the same
      // memory (regex writes type='name', LLM writes type='person'/etc.)
      // which fragments the graph. LLM-only is cleaner.
      if (process.env.NEUROMCP_LLM_ENTITIES !== '1') {
        try {
          const ns = item.namespace ?? 'default';
          for (const e of extractConversationalEntities(item.content)) {
            const entity = upsertEntity(db, e.name, e.type, ns);
            linkMemoryEntity(db, id, entity.id);
          }
        } catch (err) {
          // Log and continue — entity extraction is best-effort.
          logger.warn('store-batch', `entity extraction failed for ${id}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  });
  tx();

  // sprint2.3: optional LLM entity extraction post-pass. Runs OUTSIDE the
  // SQLite transaction because it shells out to `claude -p --model haiku`
  // (network/IO bound). Falls back gracefully on any failure — the graph
  // simply lacks LLM-extracted entities for failed rows.
  //
  // Codex Sprint 2.3 Q1 fix: now ASYNC with bounded concurrency. spawnSync
  // would freeze the event loop for ~3s per row; here we cap at
  // NEUROMCP_LLM_ENTITY_CONCURRENCY (default 4) parallel Haiku calls.
  if (process.env.NEUROMCP_LLM_ENTITIES === '1') {
    const t2 = Date.now();
    const maxConcurrency = Math.max(
      1,
      parseInt(process.env.NEUROMCP_LLM_ENTITY_CONCURRENCY ?? '4', 10),
    );
    let llmEntityCount = 0;
    let llmFailures = 0;
    const tasks = items.map((item, i) => async () => {
      const id = ids[i]!;
      const ns = item.namespace ?? 'default';
      try {
        const llmEnts = await extractEntitiesViaLLM(item.content);
        if (llmEnts.length === 0) {
          llmFailures += 1;
          return;
        }
        // Wrap entity inserts in a small transaction so they hit the WAL
        // atomically and the graph is never half-populated for a row.
        db.transaction(() => {
          for (const e of llmEnts) {
            const entity = upsertEntity(db, e.name, e.type, ns);
            linkMemoryEntity(db, id, entity.id);
            llmEntityCount += 1;
          }
        })();
      } catch (err) {
        llmFailures += 1;
        logger.warn('store-batch', `LLM entity extraction failed for ${id}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    await runWithConcurrency(tasks, maxConcurrency);
    logger.info('store-batch', 'LLM entity extraction complete', {
      llm_entities_added: llmEntityCount,
      llm_empty_or_failed: llmFailures,
      llm_extract_ms: Date.now() - t2,
      concurrency: maxConcurrency,
    });
  }

  // Vector store batch insert outside the SQLite transaction (sqlite-vec
  // handles its own transactions on upsertBatch).
  vecStore.upsertBatch(vecEntries.map((e) => ({ id: e.id, embedding: e.vec })));

  const insertMs = Date.now() - t1;
  logger.info('store-batch', `bulk inserted ${items.length} memories`, {
    embed_ms: embedMs,
    insert_ms: insertMs,
    docs_per_sec: Math.round((items.length * 1000) / Math.max(embedMs + insertMs, 1)),
  });
  return { inserted: items.length, ids, embed_ms: embedMs, insert_ms: insertMs };
}
