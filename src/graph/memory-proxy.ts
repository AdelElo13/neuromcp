/**
 * Synthetic "memory proxy" entities.
 *
 * Relations connect entities, not memories. When contradiction detection
 * needs a 'contradicts' edge between two memories that have no extracted
 * entity, `createContradictionEdge` manufactures a proxy entity per memory.
 * Those proxies are plumbing, not knowledge: they must never show up in the
 * graph overview and must never be creatable through the public
 * `create_entity` tool.
 *
 * v0.29.5: proxies carry a RESERVED entity type so read paths can exclude
 * them exactly, instead of guessing from a free-form type or a name prefix
 * (both of which a user may legitimately choose — Codex PR-18 [P2]).
 */

/** Reserved entity_type for contradiction-edge proxies. Rejected by create_entity. */
export const MEMORY_PROXY_TYPE = 'memory_proxy';

/** Legacy (pre-v0.29.5) type proxies were created with. */
export const LEGACY_PROXY_TYPE = 'memory';

/** Name prefix every proxy carries; kept for readability of the edge. */
export const PROXY_NAME_PREFIX = 'memory:';

/**
 * Deterministic proxy name for a memory's content. This is the ONLY way a
 * proxy name is ever produced, so equality with this function's output for
 * a linked memory is structural proof that an entity is a proxy — the
 * migration that retypes legacy proxies relies on exactly that.
 */
export function proxyEntityName(content: string): string {
  return `${PROXY_NAME_PREFIX}${content.slice(0, 60).replace(/[^\w\s-]/g, '').trim()}`;
}
