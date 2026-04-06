import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Claim extraction: parse atomic, verifiable facts from text.
 * No LLM calls — uses sentence splitting + heuristic patterns.
 *
 * A "claim" is an atomic statement that can be independently verified:
 *   - "neuromcp uses SQLite for storage"
 *   - "The API has 12 endpoints"
 *   - "Python 3.12 added type parameter syntax"
 *
 * Claims are stored in the `claims` table and linked to their source memory.
 */

export interface Claim {
  readonly id: string;
  readonly memory_id: string;
  readonly content: string;
  readonly subject: string | null;
  readonly predicate: string | null;
  readonly object: string | null;
  readonly confidence: number;
  readonly created_at: string;
}

export interface ClaimExtractionResult {
  readonly claims: readonly Claim[];
  readonly raw_sentences: number;
  readonly filtered: number;
}

/**
 * Extract atomic claims from memory content.
 *
 * Pipeline:
 * 1. Split into sentences
 * 2. Filter to declarative sentences (not questions, commands, fragments)
 * 3. Extract subject-predicate-object triples where possible
 * 4. Score confidence based on specificity
 */
export function extractClaims(
  db: Database.Database,
  memoryId: string,
  content: string,
): ClaimExtractionResult {
  const sentences = splitSentences(content);
  const claims: Claim[] = [];
  const now = new Date().toISOString();

  let filtered = 0;

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!isDeclarative(trimmed)) {
      filtered++;
      continue;
    }

    // Normalize
    const normalized = trimmed
      .replace(/\s+/g, ' ')
      .replace(/^[-•*]\s*/, '') // Remove list markers
      .trim();

    if (normalized.length < 10 || normalized.length > 500) {
      filtered++;
      continue;
    }

    // Extract SPO triple
    const triple = extractTriple(normalized);
    const confidence = scoreConfidence(normalized, triple);

    if (confidence < 0.3) {
      filtered++;
      continue;
    }

    const id = createHash('sha256')
      .update(memoryId + ':' + normalized)
      .digest('hex')
      .slice(0, 32);

    const claim: Claim = {
      id,
      memory_id: memoryId,
      content: normalized,
      subject: triple?.subject ?? null,
      predicate: triple?.predicate ?? null,
      object: triple?.object ?? null,
      confidence,
      created_at: now,
    };

    // Insert (ignore duplicates)
    try {
      db.prepare(
        `INSERT OR IGNORE INTO claims (id, memory_id, content, subject, predicate, object, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, memoryId, normalized, claim.subject, claim.predicate, claim.object, confidence, now);
      claims.push(claim);
    } catch {
      // Duplicate or schema issue — skip silently
    }
  }

  return {
    claims,
    raw_sentences: sentences.length,
    filtered,
  };
}

/**
 * Retrieve claims for a memory.
 */
export function getClaimsForMemory(
  db: Database.Database,
  memoryId: string,
): readonly Claim[] {
  return db
    .prepare('SELECT * FROM claims WHERE memory_id = ? ORDER BY confidence DESC')
    .all(memoryId) as Claim[];
}

/**
 * Search claims by content.
 */
export function searchClaims(
  db: Database.Database,
  query: string,
  limit: number = 20,
): readonly Claim[] {
  return db
    .prepare(
      `SELECT * FROM claims
       WHERE content LIKE ? OR subject LIKE ? OR object LIKE ?
       ORDER BY confidence DESC
       LIMIT ?`,
    )
    .all(`%${query}%`, `%${query}%`, `%${query}%`, limit) as Claim[];
}

// ─── Internals ──────────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  // Split on sentence boundaries, list items, and newlines
  return text
    .split(/(?<=[.!?])\s+|\n+|(?<=[:;])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isDeclarative(sentence: string): boolean {
  // Filter out questions
  if (sentence.endsWith('?')) return false;
  // Filter out commands/imperatives (starts with verb)
  if (/^(run|install|use|set|add|remove|delete|create|update|check|note|see|todo)\b/i.test(sentence)) return false;
  // Filter out fragments (too few words)
  if (sentence.split(/\s+/).length < 3) return false;
  // Filter out headings (all caps or title-like)
  if (/^[A-Z][A-Z\s]+$/.test(sentence)) return false;
  // Filter out code-like content
  if (/^[{[\]()}`]|=>|->|function\s|const\s|let\s|var\s|import\s|export\s/.test(sentence)) return false;

  return true;
}

interface Triple {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
}

function extractTriple(sentence: string): Triple | null {
  // Pattern: "X is/are/was/were Y"
  const beMatch = sentence.match(/^(.+?)\s+(is|are|was|were|has|have|had)\s+(.+?)\.?$/i);
  if (beMatch !== null) {
    return {
      subject: beMatch[1]!.trim(),
      predicate: beMatch[2]!.trim(),
      object: beMatch[3]!.trim(),
    };
  }

  // Pattern: "X verb Y" (simple SVO)
  const svoMatch = sentence.match(/^(.+?)\s+(uses?|supports?|requires?|provides?|includes?|contains?|enables?|runs?|stores?|returns?|accepts?|produces?|generates?|implements?|handles?)\s+(.+?)\.?$/i);
  if (svoMatch !== null) {
    return {
      subject: svoMatch[1]!.trim(),
      predicate: svoMatch[2]!.trim(),
      object: svoMatch[3]!.trim(),
    };
  }

  return null;
}

function scoreConfidence(sentence: string, triple: Triple | null): number {
  let score = 0.5;

  // Boost for having a parseable triple
  if (triple !== null) score += 0.2;

  // Boost for containing specific entities (numbers, proper nouns, technical terms)
  if (/\d+/.test(sentence)) score += 0.1;
  if (/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/.test(sentence)) score += 0.05;
  if (/[A-Z]{2,}/.test(sentence)) score += 0.05;

  // Penalize vague language
  if (/\b(maybe|perhaps|might|could|possibly|seems|appears)\b/i.test(sentence)) score -= 0.2;
  if (/\b(some|various|several|many|few|certain)\b/i.test(sentence)) score -= 0.1;

  // Boost for being concise (< 100 chars)
  if (sentence.length < 100) score += 0.1;

  return Math.max(0, Math.min(1, score));
}
