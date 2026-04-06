import { createServer as createHttpServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../observability/logger.js';
import { eventBus } from './events.js';

export interface HttpTransportOptions {
  readonly port: number;
  readonly host: string;
}

/**
 * Start an HTTP server with Streamable HTTP transport.
 * Runs alongside stdio — enables remote MCP clients.
 */
export async function startHttpTransport(
  server: McpServer,
  options: HttpTransportOptions,
  logger: Logger,
): Promise<Server> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Health endpoint
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '0.2.0' }));
      return;
    }

    // SSE event stream endpoint
    if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const listener = (event: { type: string; data: unknown }): void => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      };

      eventBus.on('memory', listener);

      req.on('close', () => {
        eventBus.off('memory', listener);
      });

      // Send initial keepalive
      res.write(': keepalive\n\n');
      return;
    }

    // MCP Streamable HTTP endpoint
    if (url.pathname === '/mcp') {
      try {
        await transport.handleRequest(req, res);
      } catch (err: unknown) {
        logger.error('http', 'Request handling failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        }
      }
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await server.connect(transport);

  return new Promise((resolve) => {
    httpServer.listen(options.port, options.host, () => {
      logger.info('http', `HTTP transport listening on ${options.host}:${options.port}`, {
        endpoints: {
          mcp: `http://${options.host}:${options.port}/mcp`,
          events: `http://${options.host}:${options.port}/events`,
          health: `http://${options.host}:${options.port}/health`,
        },
      });
      resolve(httpServer);
    });
  });
}
