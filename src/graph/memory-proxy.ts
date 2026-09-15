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
 * (both of which a user may legitimately choose — Codex PR-18 [P2]), and
 * the proxy name embeds the memory id so one proxy represents exactly one
 * memory (the legacy 60-character name let memories with the same opening
 * share a proxy — Codex PR-18 round 4 [P2]).
 */

/** Reserved entity_type for contradiction-edge proxies. Rejected by create_entity. */
export const MEMORY_PROXY_TYPE = 'memory_proxy';

/** Legacy (pre-v0.29.5) type proxies were created with. */
export const LEGACY_PROXY_TYPE = 'memory';

/** Name prefix every proxy carries; kept for readability of the edge. */
export const PROXY_NAME_PREFIX = 'memory:';

function contentStem(content: string): string {
  return content.slice(0, 60).replace(/[^\w\s-]/g, '').trim();
}

/**
 * Proxy name for a memory: readable stem + the FULL memory id, so two
 * memories can never share a proxy (a truncated id could still collide —
 * Codex PR-18 round 5) and a user name can only collide by copying the id
 * on purpose.
 */
export function proxyEntityName(content: string, memoryId: string): string {
  return `${PROXY_NAME_PREFIX}${contentStem(content)} #${memoryId}`;
}

/**
 * The pre-v0.29.5 derivation (stem only). The v15 migration uses it to
 * recognise legacy proxies; nothing writes names in this form any more.
 */
export function legacyProxyEntityName(content: string): string {
  return `${PROXY_NAME_PREFIX}${contentStem(content)}`;
}
