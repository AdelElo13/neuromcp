import type { RelationType } from '../types.js';

export interface ExtractedEntity {
  readonly name: string;
  readonly type: string;
}

export interface ExtractedRelation {
  readonly source: string;
  readonly target: string;
  readonly type: RelationType;
}

export interface LLMExtractionResult {
  readonly entities: readonly ExtractedEntity[];
  readonly relations: readonly ExtractedRelation[];
}

const SYSTEM_PROMPT = `Extract named entities and relationships from the given text. Return ONLY valid JSON.

Entity types: person, project, tool, config, concept, package, service, pattern, error, organization, system, language, framework, database
Relation types: causes, fixes, contradicts, relates_to, part_of, depends_on, supersedes, similar_to

Rules:
- Extract real names, not generic descriptions
- Skip stop words and common phrases
- Each entity must have a clear, specific name
- Relations must reference entities by exact name from the entities list

Response format:
{"entities":[{"name":"...","type":"..."}],"relations":[{"source":"...","target":"...","type":"..."}]}`;

const VALID_RELATION_TYPES = new Set([
  'causes', 'fixes', 'contradicts', 'relates_to', 'part_of',
  'depends_on', 'supersedes', 'similar_to',
]);

/**
 * Extract entities and relations from text using Ollama chat completion.
 * Uses structured JSON output for reliable parsing.
 */
export async function extractWithLLM(
  content: string,
  ollamaHost: string,
  model: string,
): Promise<LLMExtractionResult> {
  const res = await fetch(`${ollamaHost}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
      format: 'json',
      stream: false,
      options: { temperature: 0, num_predict: 1024 },
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Ollama chat failed: ${res.status}`);
  }

  const data = await res.json() as { message?: { content?: string } };
  const raw = data.message?.content;
  if (!raw) throw new Error('Ollama returned empty response');

  const parsed = JSON.parse(raw) as {
    entities?: Array<{ name?: string; type?: string }>;
    relations?: Array<{ source?: string; target?: string; type?: string }>;
  };

  // Validate and filter entities
  const entities: ExtractedEntity[] = (parsed.entities ?? [])
    .filter(e => e.name && e.type && e.name.length >= 2 && e.name.length <= 100)
    .map(e => ({ name: e.name!, type: e.type!.toLowerCase() }));

  // Build entity name set for relation validation
  const entityNames = new Set(entities.map(e => e.name.toLowerCase()));

  // Validate and filter relations
  const relations: ExtractedRelation[] = (parsed.relations ?? [])
    .filter(r =>
      r.source && r.target && r.type &&
      entityNames.has(r.source.toLowerCase()) &&
      entityNames.has(r.target.toLowerCase()) &&
      VALID_RELATION_TYPES.has(r.type.toLowerCase()),
    )
    .map(r => ({
      source: r.source!,
      target: r.target!,
      type: r.type!.toLowerCase() as RelationType,
    }));

  return { entities, relations };
}
