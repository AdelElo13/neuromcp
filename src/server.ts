import type Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VectorStore } from './vectors/types.js';
import type { EmbeddingProvider } from './embeddings/types.js';
import type { NeuromcpConfig } from './config.js';
import type { Logger } from './observability/logger.js';
import type { Metrics } from './observability/metrics.js';
import { registerCoreTools } from './registration/core.js';
import { registerGraphTools } from './registration/graph.js';
import { registerEpisodeTools } from './registration/episodes.js';
import { registerAgentTools } from './registration/agents.js';
import { registerVerbatimTools } from './registration/verbatim.js';
import { registerWikiTools } from './registration/wiki.js';
import { registerAttributionTools, registerReflectionTool } from './registration/attribution.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';

export interface ServerDeps {
  readonly db: Database.Database;
  readonly vecStore: VectorStore;
  readonly embedder: EmbeddingProvider;
  readonly config: NeuromcpConfig;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

export function createServer(deps: ServerDeps): McpServer {
  const { logger } = deps;

  const server = new McpServer(
    { name: 'neuromcp', version: '0.17.7' },
    {
      capabilities: {
        resources: {},
        tools: {},
        prompts: {},
      },
    },
  );

  registerCoreTools(server, deps);
  registerGraphTools(server, deps);
  registerEpisodeTools(server, deps);
  registerAgentTools(server, deps);
  registerVerbatimTools(server, deps);
  registerWikiTools(server, deps);
  registerAttributionTools(server, deps);
  registerReflectionTool(server, deps);
  registerResources(server, deps);
  registerPrompts(server, deps);

  logger.info('server', 'MCP server created', {
    tools: 42,
    resources: 13,
    prompts: 3,
  });

  return server;
}
