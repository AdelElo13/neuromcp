import type Database from 'better-sqlite3';
import type { Entity } from '../types.js';
import { upsertEntity, linkMemoryEntity } from './entities.js';

/**
 * Lightweight entity extraction from memory content.
 * No LLM calls — uses pattern matching and heuristics.
 *
 * Extracts:
 * - Capitalized noun phrases (proper nouns, project names)
 * - Technical terms (URLs, file paths, package names)
 * - Structured patterns (key: value, key=value)
 */
export function extractEntities(
  db: Database.Database,
  memoryId: string,
  content: string,
  namespace: string,
): readonly Entity[] {
  const extracted: Entity[] = [];
  const seen = new Set<string>();

  const addEntity = (name: string, entityType: string): void => {
    const key = `${name.toLowerCase()}:${entityType}`;
    if (seen.has(key)) return;
    if (name.length < 2 || name.length > 100) return;
    seen.add(key);

    const entity = upsertEntity(db, name, entityType, namespace);
    linkMemoryEntity(db, memoryId, entity.id);
    extracted.push(entity);
  };

  // 1. Extract proper nouns (capitalized words not at sentence start)
  //    Match sequences of 1-4 capitalized words
  const properNounPattern = /(?:^|[.!?]\s+)(?:(?:[A-Z][a-z]+)(?:\s+[A-Z][a-z]+){0,3})/g;
  const sentences = content.split(/[.!?\n]/);
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length === 0) continue;

    // Skip the first word of each sentence, look at rest
    const words = trimmed.split(/\s+/);
    let i = 1; // skip first word
    while (i < words.length) {
      if (/^[A-Z][a-z]/.test(words[i]!)) {
        // Collect consecutive capitalized words
        const phrase: string[] = [words[i]!];
        let j = i + 1;
        while (j < words.length && /^[A-Z][a-z]/.test(words[j]!)) {
          phrase.push(words[j]!);
          j++;
        }
        const name = phrase.join(' ');
        if (!STOP_WORDS.has(name.toLowerCase())) {
          addEntity(name, 'concept');
        }
        i = j;
      } else {
        i++;
      }
    }
  }

  // 2. Extract technical identifiers
  // File paths
  const pathPattern = /(?:\/[\w.-]+){2,}/g;
  for (const match of content.matchAll(pathPattern)) {
    addEntity(match[0], 'path');
  }

  // Package names (npm-style: @scope/package or package-name)
  const packagePattern = /(?:@[\w-]+\/[\w.-]+|(?<=\s|^)[\w][\w.-]*(?:\/[\w.-]+))/g;
  for (const match of content.matchAll(packagePattern)) {
    const name = match[0];
    if (name.includes('/') && !name.startsWith('/') && name.length > 3) {
      addEntity(name, 'package');
    }
  }

  // URLs/domains
  const urlPattern = /https?:\/\/[\w.-]+(?:\/[\w./-]*)?/g;
  for (const match of content.matchAll(urlPattern)) {
    addEntity(match[0], 'url');
  }

  // GitHub-style references (owner/repo#123)
  const ghRefPattern = /[\w-]+\/[\w.-]+#\d+/g;
  for (const match of content.matchAll(ghRefPattern)) {
    addEntity(match[0], 'reference');
  }

  // 3. Extract key-value patterns as tagged entities
  const kvPattern = /(?:^|\n)\s*([\w\s]+):\s*(.{3,80})$/gm;
  for (const match of content.matchAll(kvPattern)) {
    const key = match[1]!.trim();
    if (key.split(/\s+/).length <= 3 && !STOP_WORDS.has(key.toLowerCase())) {
      addEntity(key, 'attribute');
    }
  }

  return extracted;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must',
  'this', 'that', 'these', 'those', 'it', 'its',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
  'each', 'every', 'all', 'any', 'few', 'more', 'most', 'some',
  'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
  'just', 'because', 'as', 'until', 'while', 'of', 'at', 'by',
  'for', 'with', 'about', 'against', 'between', 'through', 'during',
  'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down',
  'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further',
  'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'what', 'which', 'who', 'whom', 'if', 'unless', 'although',
  'however', 'also', 'note', 'see', 'use', 'using', 'used',
  'default', 'true', 'false', 'null', 'undefined', 'none',
]);
