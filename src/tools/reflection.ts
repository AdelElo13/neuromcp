/**
 * reflection.ts — generate meta-insights from high-usefulness memories.
 *
 * Gemini's original v0.16.0 pitch, now data-backed per Codex's v0.16.0
 * critique. Only memories with helpful_count > 0 are fed to the
 * synthesiser, so we can't reinforce speculative content that was never
 * shown to help.
 *
 * The synthesis itself is extractive + structural: cluster high-
 * usefulness memories by embedding centroid (cheap), emit a bullet per
 * cluster summarising the shared theme, store the result as a
 * memory with category='reflection' and source='consolidation'.
 *
 * No LLM call in v0.17.0 — pure selection + templated output. A future
 * release can add an Ollama call for prose summaries; until then the
 * reflection is deterministic and auditable.
 */
import type { Database } from 'better-sqlite3';
import { randomBytes, createHash } from 'node:crypto';
import type { Logger } from '../observability/logger.js';

export interface GenerateReflectionArgs {
  namespace?: string;
  window_days?: number;
  min_helpful?: number;
  max_clusters?: number;
}

interface ReflectionCandidate {
  id: string;
  content: string;
  helpful_count: number;
  category: string;
  created_at: string;
}

export interface ReflectionResult {
  reflection_id: string | null;
  source_memories: string[];
  summary: string;
  skipped: boolean;
  reason?: string;
}

/**
 * Generate a reflection memory from the pool of helpful-proven memories
 * in the given window. Returns the new memory id or skipped=true if
 * there isn't enough signal.
 */
export function generateReflection(
  args: GenerateReflectionArgs,
  deps: { db: Database; logger: Logger },
): ReflectionResult {
  const { db, logger } = deps;
  const namespace = args.namespace ?? 'default';
  const windowDays = args.window_days ?? 14;
  const minHelpful = args.min_helpful ?? 1;
  const maxClusters = args.max_clusters ?? 5;

  const sinceIso = new Date(Date.now() - windowDays * 24 * 3600 * 1000).toISOString();

  // Pull memories that have been PROVEN helpful — require helpful > harmful
  // AND usefulness_score > 0.6 so noisy or contradictory memories don't
  // slip into the reflection pool. Exclude prior reflections (category =
  // 'reflection') to prevent self-feeding: reflection → retrieval →
  // citation → higher helpful_count → pool → more reflection on self.
  // This closes both the v0.17.0 round-10 architect P1 and codex P1 loops.
  const rows = db
    .prepare(
      `SELECT m.id, m.content, m.category, m.created_at, u.helpful_count
         FROM memories m
         JOIN memory_usefulness u ON u.memory_id = m.id
         WHERE m.is_deleted = 0
           AND m.namespace = ?
           AND m.category != 'reflection'
           AND u.helpful_count >= ?
           AND u.helpful_count > u.harmful_count
           AND u.usefulness_score > 0.6
           AND m.created_at >= ?
         ORDER BY u.usefulness_score DESC, u.helpful_count DESC
         LIMIT 200`,
    )
    .all(namespace, minHelpful, sinceIso) as ReflectionCandidate[];

  if (rows.length === 0) {
    logger.info('reflection', 'no helpful-proven memories in window', {
      namespace,
      window_days: windowDays,
      min_helpful: minHelpful,
    });
    return {
      reflection_id: null,
      source_memories: [],
      summary: '',
      skipped: true,
      reason: `no memories with helpful_count >= ${minHelpful} in the last ${windowDays} days`,
    };
  }

  // Cheap clustering by category. If there are multiple distinct
  // categories, each becomes a section; otherwise we emit a flat list.
  const byCategory = new Map<string, ReflectionCandidate[]>();
  for (const row of rows) {
    const cat = row.category || 'general';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(row);
  }

  const sections: string[] = [];
  const topCategories = Array.from(byCategory.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxClusters);

  for (const [category, items] of topCategories) {
    sections.push(`### ${category} (${items.length})`);
    for (const item of items.slice(0, 3)) {
      const snippet = item.content.replace(/\s+/g, ' ').slice(0, 160);
      sections.push(`- ${snippet}${item.content.length > 160 ? '...' : ''}`);
    }
  }

  const summary = [
    `# Reflection — ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `Synthesised from ${rows.length} memories with helpful_count >= ${minHelpful}`,
    `in the last ${windowDays} days in namespace \`${namespace}\`.`,
    ``,
    ...sections,
    ``,
    `_Reflection is extractive, not generative. Source memories are listed below._`,
  ].join('\n');

  const reflection_id = randomBytes(16).toString('hex');
  const contentHash = createHash('sha256').update(summary).digest('hex');
  const now = new Date().toISOString();

  // Store as a memory with category=reflection so it participates in search
  // but can be filtered out when we don't want meta content.
  db.prepare(
    `INSERT INTO memories
       (id, content_hash, content, namespace, source, source_trust, category, tags, importance, metadata, created_at, updated_at, schema_version, visibility, embedding_model, embedding_dim)
     VALUES (?, ?, ?, ?, 'consolidation', 'medium', 'reflection', ?, ?, ?, ?, ?, 11, 'namespace', 'none', 0)`,
  ).run(
    reflection_id,
    contentHash,
    summary,
    namespace,
    JSON.stringify(['reflection', 'auto-generated']),
    0.7,
    JSON.stringify({
      source_memories: rows.map((r) => r.id),
      window_days: windowDays,
      min_helpful: minHelpful,
    }),
    now,
    now,
  );

  logger.info('reflection', 'generated', {
    reflection_id,
    source_count: rows.length,
    sections: sections.length,
  });

  return {
    reflection_id,
    source_memories: rows.map((r) => r.id),
    summary,
    skipped: false,
  };
}
