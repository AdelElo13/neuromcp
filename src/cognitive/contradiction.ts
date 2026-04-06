import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { Contradiction } from '../types.js';

/**
 * Detect potential contradictions between new content and existing memories.
 *
 * Strategy:
 * 1. Find semantically similar memories (same topic area)
 * 2. Check for signals that suggest contradiction:
 *    - High semantic similarity but different factual content
 *    - Negation patterns ("not", "no longer", "instead", "but")
 *    - Temporal supersession ("now", "updated", "changed", "was X, now Y")
 *
 * This is a heuristic approach — no LLM calls. It flags candidates for review
 * rather than making definitive judgments.
 */
export async function detectContradictions(
  content: string,
  namespace: string,
  db: Database.Database,
  vecStore: VectorStore,
  embedder: EmbeddingProvider,
  threshold: number,
): Promise<readonly Contradiction[]> {
  const embedding = await embedder.embed(content);
  const neighbors = vecStore.search(embedding, 10);

  const contradictions: Contradiction[] = [];
  const contentLower = content.toLowerCase();

  for (const neighbor of neighbors) {
    const similarity = 1 - neighbor.distance;

    // Consider memories in the contradiction-relevant similarity range:
    // Very high similarity (>0.95) may still be contradictions (factual differences in near-duplicates)
    // In range (threshold to 1.0) = same topic, possibly conflicting
    // Too different (<threshold) = unrelated
    if (similarity <= threshold) continue;
    // Skip exact matches (similarity ≈ 1.0)
    if (similarity > 0.999) continue;

    const existing = db
      .prepare(
        'SELECT id, content, namespace, is_deleted, valid_to FROM memories WHERE id = ? LIMIT 1',
      )
      .get(neighbor.id) as
      | { id: string; content: string; namespace: string; is_deleted: number; valid_to: string | null }
      | undefined;

    if (existing === undefined || existing.is_deleted === 1) continue;
    if (namespace !== '*' && existing.namespace !== namespace) continue;
    // Skip already-invalidated memories
    if (existing.valid_to !== null) continue;

    const existingLower = existing.content.toLowerCase();

    // Check contradiction signals
    const signals = computeContradictionSignals(contentLower, existingLower);

    if (signals.score > 0.3) {
      contradictions.push({
        existing_id: existing.id,
        new_content: content,
        existing_content: existing.content,
        similarity,
        resolution: signals.score > 0.5 ? 'supersede' : 'flag',
      });
    }
  }

  return contradictions;
}

interface ContradictionSignals {
  readonly score: number;
  readonly reasons: readonly string[];
}

function computeContradictionSignals(
  newContent: string,
  existingContent: string,
): ContradictionSignals {
  let score = 0;
  const reasons: string[] = [];

  // 1. Negation patterns in new content
  const negationPatterns = [
    /\bnot\b/, /\bno longer\b/, /\binstead\b/, /\brather than\b/,
    /\bactually\b/, /\bcorrection\b/, /\bwrong\b/, /\bincorrect\b/,
    /\bfalse\b/, /\bmistake\b/, /\bcontrary\b/, /\bhowever\b/,
  ];

  for (const pattern of negationPatterns) {
    if (pattern.test(newContent)) {
      score += 0.15;
      reasons.push(`negation pattern: ${pattern.source}`);
      break; // Only count one negation signal
    }
  }

  // 2. Temporal supersession patterns
  const temporalPatterns = [
    /\bnow\b/, /\bupdated\b/, /\bchanged\b/, /\bwas\b.*\bnow\b/,
    /\bpreviously\b/, /\bformerly\b/, /\bused to\b/, /\bno more\b/,
    /\bnew version\b/, /\breplaced\b/, /\bdeprecated\b/,
  ];

  for (const pattern of temporalPatterns) {
    if (pattern.test(newContent)) {
      score += 0.2;
      reasons.push(`temporal pattern: ${pattern.source}`);
      break;
    }
  }

  // 3. Numeric value differences
  // Extract numbers from both texts and check for mismatches
  const newNumbers = extractNumbers(newContent);
  const existingNumbers = extractNumbers(existingContent);

  if (newNumbers.length > 0 && existingNumbers.length > 0) {
    const setNew = new Set(newNumbers);
    const setExisting = new Set(existingNumbers);
    const onlyNew = newNumbers.filter((n) => !setExisting.has(n));
    const onlyOld = existingNumbers.filter((n) => !setNew.has(n));

    if (onlyNew.length > 0 && onlyOld.length > 0) {
      // Different numbers in similar context = strong contradiction signal
      score += 0.4;
      reasons.push(`numeric difference: ${onlyOld.join(',')} vs ${onlyNew.join(',')}`);
    }
  }

  // 4. Direct opposite words
  const opposites: Array<[string, string]> = [
    ['true', 'false'], ['yes', 'no'], ['enable', 'disable'],
    ['allow', 'deny'], ['accept', 'reject'], ['success', 'failure'],
    ['active', 'inactive'], ['valid', 'invalid'], ['open', 'closed'],
  ];

  for (const [a, b] of opposites) {
    if (
      (newContent.includes(a) && existingContent.includes(b)) ||
      (newContent.includes(b) && existingContent.includes(a))
    ) {
      score += 0.2;
      reasons.push(`opposite terms: ${a}/${b}`);
      break;
    }
  }

  return { score: Math.min(score, 1.0), reasons };
}

function extractNumbers(text: string): number[] {
  const matches = text.match(/\b\d+(?:\.\d+)?\b/g);
  if (matches === null) return [];
  return matches.map(Number).filter((n) => !isNaN(n) && n > 0);
}

/**
 * Apply contradiction resolution: invalidate the old memory by setting valid_to.
 */
export function supersedMemory(
  db: Database.Database,
  oldMemoryId: string,
  newMemoryId: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE memories SET valid_to = ?, superseded_by_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(now, newMemoryId, oldMemoryId);

  db.prepare(
    "UPDATE memories SET supersedes_id = ?, valid_from = COALESCE(valid_from, ?), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(oldMemoryId, now, newMemoryId);
}
