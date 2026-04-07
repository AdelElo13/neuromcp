import type Database from 'better-sqlite3';
import type { Entity } from '../types.js';
import { upsertEntity, linkMemoryEntity } from './entities.js';
import { createRelation } from './relations.js';
import { extractWithLLM } from './llm-extract.js';

/**
 * Dispatch entity extraction: LLM first (if available), regex fallback.
 */
export async function extractEntitiesDispatch(
  db: Database.Database,
  memoryId: string,
  content: string,
  namespace: string,
  config: { entityExtractionMode: string; ollamaHost: string; ollamaChatModel: string },
  logger: { debug: (module: string, msg: string, meta?: Record<string, unknown>) => void },
): Promise<readonly Entity[]> {
  if (config.entityExtractionMode !== 'regex') {
    try {
      const result = await extractWithLLM(content, config.ollamaHost, config.ollamaChatModel);
      const entities: Entity[] = [];
      const entityMap = new Map<string, Entity>();

      // Upsert entities (filter out file paths, URLs, and sentence-like names)
      for (const e of result.entities) {
        if (isNoiseEntity(e.name, e.type)) continue;
        const entity = upsertEntity(db, e.name, e.type, namespace);
        linkMemoryEntity(db, memoryId, entity.id);
        entities.push(entity);
        entityMap.set(e.name.toLowerCase(), entity);
      }

      // Create relations
      for (const r of result.relations) {
        const source = entityMap.get(r.source.toLowerCase());
        const target = entityMap.get(r.target.toLowerCase());
        if (source && target) {
          createRelation(db, source.id, target.id, r.type, namespace);
        }
      }

      if (entities.length > 0) {
        logger.debug('extract', 'LLM extraction succeeded', {
          entities: entities.length,
          relations: result.relations.length,
        });
      }
      return entities;
    } catch (err: unknown) {
      if (config.entityExtractionMode === 'llm') {
        throw err; // strict mode: don't fall back
      }
      logger.debug('extract', 'LLM extraction failed, falling back to regex');
    }
  }

  return extractEntities(db, memoryId, content, namespace);
}

/**
 * Entity extraction from memory content.
 * Uses pattern matching with aggressive filtering to reduce false positives.
 *
 * Extracts:
 * - Bracketed type markers: [person], [project], [tool], [config]
 * - Technical identifiers: file paths, package names, URLs
 * - Structured key:value patterns
 * - Capitalized multi-word proper nouns (2+ words, strict filtering)
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
    const normalized = name.trim();
    const key = `${normalized.toLowerCase()}:${entityType}`;
    if (seen.has(key)) return;
    if (normalized.length < 2 || normalized.length > 100) return;
    seen.add(key);

    const entity = upsertEntity(db, normalized, entityType, namespace);
    linkMemoryEntity(db, memoryId, entity.id);
    extracted.push(entity);
  };

  // 1. Bracketed type markers — highest confidence
  //    e.g. [person] Name, [project] GoAmanah, [tool] Playwright
  const bracketPattern = /\[(\w+)\]\s+([^\n.,:;]+)/g;
  for (const match of content.matchAll(bracketPattern)) {
    const entityType = match[1]!.toLowerCase();
    const name = match[2]!.trim().split(/\s{2,}/)[0]!.trim();
    if (name.length >= 2 && VALID_ENTITY_TYPES.has(entityType)) {
      addEntity(name, entityType);
    }
  }

  // 2. Package names (npm-style: @scope/package)
  const scopedPackagePattern = /@[\w-]+\/[\w.-]+/g;
  for (const match of content.matchAll(scopedPackagePattern)) {
    addEntity(match[0], 'package');
  }

  // 3. GitHub-style references (owner/repo#123)
  const ghRefPattern = /[\w-]+\/[\w.-]+#\d+/g;
  for (const match of content.matchAll(ghRefPattern)) {
    addEntity(match[0], 'reference');
  }

  // 6. Multi-word proper nouns — strict: only 2-4 capitalized words
  //    NOT at sentence start, NOT common phrases
  const sentences = content.split(/[.!?\n]/);
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length === 0) continue;

    const words = trimmed.split(/\s+/);
    let i = 1; // skip first word (sentence start)
    while (i < words.length) {
      if (/^[A-Z][a-z]{2,}$/.test(words[i]!)) {
        const phrase: string[] = [words[i]!];
        let j = i + 1;
        while (j < words.length && j - i < 4 && /^[A-Z][a-z]{2,}$/.test(words[j]!)) {
          phrase.push(words[j]!);
          j++;
        }
        // Only accept multi-word proper nouns (single words are too noisy)
        if (phrase.length >= 2) {
          const name = phrase.join(' ');
          if (!STOP_PHRASES.has(name.toLowerCase())) {
            addEntity(name, 'concept');
          }
        }
        i = j;
      } else {
        i++;
      }
    }
  }

  // 7. Key: Value patterns — only for well-known keys
  const kvPattern = /(?:^|\n)\s*((?:Project|Stack|Domain|Repo|Version|Status|Region|Provider|Host|Port|Database|Table|Key|Token|Model)):\s*(.{3,60})$/gmi;
  for (const match of content.matchAll(kvPattern)) {
    const key = match[1]!.trim();
    const value = match[2]!.trim();
    if (!STOP_WORDS.has(key.toLowerCase()) && !STOP_WORDS.has(value.toLowerCase())) {
      addEntity(`${key}: ${value}`, 'attribute');
    }
  }

  return extracted;
}

const VALID_ENTITY_TYPES = new Set([
  'person', 'project', 'tool', 'config', 'system', 'service',
  'package', 'library', 'framework', 'database', 'api', 'concept',
  'organization', 'team', 'product', 'feature', 'error', 'pattern',
]);

const STOP_PHRASES = new Set([
  'the following', 'for example', 'in order', 'such as',
  'as well', 'in the', 'on the', 'at the', 'to the',
  'not found', 'no such', 'has been', 'will be', 'can be',
]);

/**
 * Filter out noise entities: file paths, URLs, sentences, and overly generic names.
 */
function isNoiseEntity(name: string, entityType: string): boolean {
  // File paths
  if (name.startsWith('/') || name.startsWith('~/') || name.startsWith('./')) return true;
  // URLs
  if (/^https?:\/\//.test(name)) return true;
  // Entity type is path or url
  if (entityType === 'path' || entityType === 'url') return true;
  // Sentence-like: contains a verb or is too long with spaces
  if (name.length > 40 && name.includes(' ')) return true;
  // Very short noise
  if (name.length < 2) return true;
  return false;
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
