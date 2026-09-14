import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';
import type { EmbeddingProvider } from '../embeddings/types.js';
import { degradedNotice } from '../embeddings/runtime.js';

export type RegisterFn = (server: McpServer, deps: ServerDeps) => void;

export function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/**
 * Make a degraded (FTS-only) start visible to the agent calling the tool.
 * Returns the payload UNCHANGED when embeddings are healthy, so normal
 * responses keep their exact 0.29.2 shape.
 */
export function withDegradedNotice(embedder: EmbeddingProvider, payload: unknown): unknown {
  const notice = degradedNotice(embedder);
  if (notice === null) return payload;
  if (Array.isArray(payload)) return { results: payload, neuromcp_notice: notice };
  if (payload !== null && typeof payload === 'object') {
    return { ...(payload as Record<string, unknown>), neuromcp_notice: notice };
  }
  return { result: payload, neuromcp_notice: notice };
}
