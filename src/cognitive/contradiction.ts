import type Database from 'better-sqlite3';
import type { VectorStore } from '../vectors/types.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import type { Contradiction } from '../types.js';
import { extractTriplesFromText } from './claims.js';
// resolveJsonModule default import; tsup/esbuild inlines the JSON into the
// bundle so there is no runtime ESM JSON-attribute requirement.
import predicateClasses from '../config/predicate-classes.json';

// Predicates that express a single-valued fact: a new claim with the same
// subject and a different object genuinely SUPERSEDES the old one. Anything
// not on this list defaults to ADDITIVE (coexist) — keyword heuristics alone
// must never auto-invalidate a memory, since a false supersede silently
// deletes a true fact and becomes a hallucination vector downstream.
const MUTUALLY_EXCLUSIVE_PREDICATES = new Set(
  (predicateClasses.mutually_exclusive as readonly string[]).map((p) => p.toLowerCase()),
);

function normalizeSubject(s: string): string {
  return s.toLowerCase().trim().replace(/^(the|a|an)\s+/, '').replace(/\s+/g, ' ');
}

/**
 * Canonicalize a predicate for equality comparison. The mutually-exclusive
 * list carries singular + plural forms (uses/use, is/are, runs/run); collapse
 * them so "uses" and "use" compare equal, while "uses" and "requires" do NOT.
 */
function normalizePredicate(p: string): string {
  const lower = p.toLowerCase().trim();
  // is/are/was/were → be; has/have/had → have
  if (lower === 'is' || lower === 'are' || lower === 'was' || lower === 'were') return 'be';
  if (lower === 'has' || lower === 'have' || lower === 'had') return 'have';
  // Strip a trailing 's' for third-person singular (uses → use, runs → run).
  return lower.endsWith('s') ? lower.slice(0, -1) : lower;
}

/**
 * Gate for auto-supersede: returns true only when the new and existing
 * content share a claim with the SAME subject, the SAME (normalized)
 * mutually-exclusive predicate, but a DIFFERENT object — i.e. a real
 * single-valued-fact update.
 *
 * v0.29 (Codex Task1 #4) tightened two false-positive sources:
 *   - predicates must MATCH after normalization ("uses React 18" is not
 *     superseded by "requires Node 22" — different predicate, additive fact);
 *   - subjects must be EXACTLY equal after normalization (no bare substring:
 *     "the app" and "the mapping app" are different subjects). A false
 *     supersede silently deletes a true fact — a hallucination vector.
 */
export function predicatesAllowSupersede(newContent: string, existingContent: string): boolean {
  const newTriples = extractTriplesFromText(newContent);
  if (newTriples.length === 0) return false;
  const oldTriples = extractTriplesFromText(existingContent);
  if (oldTriples.length === 0) return false;

  for (const nt of newTriples) {
    if (!MUTUALLY_EXCLUSIVE_PREDICATES.has(nt.predicate.toLowerCase())) continue;
    const ns = normalizeSubject(nt.subject);
    if (ns.length === 0) continue;
    const np = normalizePredicate(nt.predicate);
    for (const ot of oldTriples) {
      if (!MUTUALLY_EXCLUSIVE_PREDICATES.has(ot.predicate.toLowerCase())) continue;
      // Same predicate (normalized) required — additive facts across
      // different predicates must never auto-invalidate each other.
      if (np !== normalizePredicate(ot.predicate)) continue;
      const os = normalizeSubject(ot.subject);
      // Exact subject equality — substring alignment produced false supersedes.
      if (ns !== os) continue;
      if (nt.object.toLowerCase().trim() !== ot.object.toLowerCase().trim()) {
        return true;
      }
    }
  }
  return false;
}

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
  // v0.29 Fase 1B (Codex [MEDIUM]): push the namespace into the vec query so
  // other namespaces cannot fill the global top-k and hide same-namespace
  // contradictions. '*' → undefined (search all namespaces).
  const scopedNamespace = namespace === '*' ? undefined : namespace;
  const neighbors = vecStore.search(embedding, 10, scopedNamespace);

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
      // Resolution ladder: strong signal → supersede, medium → coexist, weak → flag
      let resolution: 'supersede' | 'coexist' | 'flag' =
        signals.score > 0.5 ? 'supersede' :
        signals.score > 0.35 ? 'coexist' : 'flag';

      // Predicate-class gate: keyword heuristics alone (negation words,
      // numeric diffs) are NOT enough to invalidate a memory. Auto-supersede
      // requires claim-level evidence — same subject, mutually-exclusive
      // predicate, different object. Otherwise downgrade to coexist so both
      // memories survive and a human/LLM can adjudicate.
      if (resolution === 'supersede' && !predicatesAllowSupersede(content, existing.content)) {
        resolution = 'coexist';
      }

      contradictions.push({
        existing_id: existing.id,
        new_content: content,
        existing_content: existing.content,
        similarity,
        resolution,
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
