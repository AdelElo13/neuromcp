import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerDeps } from '../server.js';
import type { Memory, OperationRecord } from '../types.js';
import { memoryStats } from '../tools/stats.js';

export function registerResources(server: McpServer, deps: ServerDeps): void {
  const { db, embedder, config, metrics } = deps;

  // ─── Static 1: memory://stats ────────────────────────────────────
  server.registerResource('global_stats', 'memory://stats', {
    description: 'Global memory statistics across all namespaces',
    mimeType: 'application/json',
  }, () => ({
    contents: [{
      uri: 'memory://stats',
      mimeType: 'application/json',
      text: JSON.stringify(memoryStats({ namespace: '*' }, db, embedder, config)),
    }],
  }));

  // ─── Static 2: memory://recent ───────────────────────────────────
  server.registerResource('recent_memories', 'memory://recent', {
    description: 'Last 20 memories across all namespaces',
    mimeType: 'application/json',
  }, () => {
    const rows = db.prepare(
      'SELECT * FROM memories WHERE is_deleted = 0 ORDER BY created_at DESC LIMIT 20',
    ).all() as Memory[];
    return {
      contents: [{
        uri: 'memory://recent',
        mimeType: 'application/json',
        text: JSON.stringify(rows),
      }],
    };
  });

  // ─── Static 3: memory://namespaces ───────────────────────────────
  server.registerResource('namespaces', 'memory://namespaces', {
    description: 'List all namespaces with memory counts',
    mimeType: 'application/json',
  }, () => {
    const rows = db.prepare(
      'SELECT namespace, COUNT(*) as count FROM memories WHERE is_deleted = 0 GROUP BY namespace ORDER BY count DESC',
    ).all() as Array<{ namespace: string; count: number }>;
    return {
      contents: [{
        uri: 'memory://namespaces',
        mimeType: 'application/json',
        text: JSON.stringify(rows),
      }],
    };
  });

  // ─── Static 4: memory://consolidation/log ────────────────────────
  server.registerResource('consolidation_log', 'memory://consolidation/log', {
    description: 'Recent consolidation log entries',
    mimeType: 'application/json',
  }, () => {
    const rows = db.prepare(
      'SELECT * FROM consolidation_log ORDER BY created_at DESC LIMIT 50',
    ).all();
    return {
      contents: [{
        uri: 'memory://consolidation/log',
        mimeType: 'application/json',
        text: JSON.stringify(rows),
      }],
    };
  });

  // ─── Static 5: memory://operations ───────────────────────────────
  server.registerResource('operations', 'memory://operations', {
    description: 'Active and recent operations',
    mimeType: 'application/json',
  }, () => {
    const rows = db.prepare(
      'SELECT * FROM operations ORDER BY started_at DESC LIMIT 20',
    ).all() as OperationRecord[];
    return {
      contents: [{
        uri: 'memory://operations',
        mimeType: 'application/json',
        text: JSON.stringify(rows),
      }],
    };
  });

  // ─── Static 6: memory://health ───────────────────────────────────
  server.registerResource('health', 'memory://health', {
    description: 'Server health check with metrics snapshot',
    mimeType: 'application/json',
  }, () => {
    const snapshot = metrics.snapshot();
    const totalRow = db.prepare(
      'SELECT COUNT(*) as count FROM memories WHERE is_deleted = 0',
    ).get() as { count: number };

    const health = {
      status: 'ok',
      version: '0.16.0',
      memory_count: totalRow.count,
      embedding_model: embedder.name,
      embedding_dimensions: embedder.dimensions,
      metrics: snapshot,
    };
    return {
      contents: [{
        uri: 'memory://health',
        mimeType: 'application/json',
        text: JSON.stringify(health),
      }],
    };
  });

  // ─── Template 7: memory://stats/{namespace} ──────────────────────
  server.registerResource(
    'namespace_stats',
    new ResourceTemplate('memory://stats/{namespace}', { list: undefined }),
    {
      description: 'Statistics for a specific namespace',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const namespace = String(variables.namespace);
      const stats = memoryStats({ namespace }, db, embedder, config);
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(stats),
        }],
      };
    },
  );

  // ─── Template 8: memory://recent/{namespace} ─────────────────────
  server.registerResource(
    'namespace_recent',
    new ResourceTemplate('memory://recent/{namespace}', { list: undefined }),
    {
      description: 'Last 20 memories in a specific namespace',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const namespace = String(variables.namespace);
      const rows = db.prepare(
        'SELECT * FROM memories WHERE is_deleted = 0 AND namespace = ? ORDER BY created_at DESC LIMIT 20',
      ).all(namespace) as Memory[];
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(rows),
        }],
      };
    },
  );

  // ─── Template 9: memory://id/{id} ────────────────────────────────
  server.registerResource(
    'memory_by_id',
    new ResourceTemplate('memory://id/{id}', { list: undefined }),
    {
      description: 'Retrieve a specific memory by its ID',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const id = String(variables.id);
      const row = db.prepare(
        'SELECT * FROM memories WHERE id = ?',
      ).get(id) as Memory | undefined;

      if (row === undefined) {
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ error: 'not_found', id }) }] };
      }
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(row),
        }],
      };
    },
  );

  // ─── Template 10: memory://tag/{tag} ─────────────────────────────
  server.registerResource(
    'memories_by_tag',
    new ResourceTemplate('memory://tag/{tag}', { list: undefined }),
    {
      description: 'Memories containing a specific tag (across all namespaces)',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const tag = String(variables.tag);
      const rows = db.prepare(
        "SELECT * FROM memories WHERE is_deleted = 0 AND tags LIKE ? ORDER BY created_at DESC LIMIT 50",
      ).all(`%"${tag}"%`) as Memory[];
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(rows),
        }],
      };
    },
  );

  // ─── Template 11: memory://tag/{namespace}/{tag} ─────────────────
  server.registerResource(
    'memories_by_namespace_tag',
    new ResourceTemplate('memory://tag/{namespace}/{tag}', { list: undefined }),
    {
      description: 'Memories with a specific tag in a specific namespace',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const namespace = String(variables.namespace);
      const tag = String(variables.tag);
      const rows = db.prepare(
        "SELECT * FROM memories WHERE is_deleted = 0 AND namespace = ? AND tags LIKE ? ORDER BY created_at DESC LIMIT 50",
      ).all(namespace, `%"${tag}"%`) as Memory[];
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(rows),
        }],
      };
    },
  );

  // ─── Template 12: memory://namespace/{ns} ────────────────────────
  server.registerResource(
    'namespace_memories',
    new ResourceTemplate('memory://namespace/{ns}', { list: undefined }),
    {
      description: 'All memories in a namespace (up to 100)',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const ns = String(variables.ns);
      const rows = db.prepare(
        'SELECT * FROM memories WHERE is_deleted = 0 AND namespace = ? ORDER BY created_at DESC LIMIT 100',
      ).all(ns) as Memory[];
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(rows),
        }],
      };
    },
  );

  // ─── Template 13: memory://consolidation/log/{operation_id} ──────
  server.registerResource(
    'consolidation_log_by_op',
    new ResourceTemplate('memory://consolidation/log/{operation_id}', { list: undefined }),
    {
      description: 'Consolidation log entries for a specific operation',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const operationId = String(variables.operation_id);
      const rows = db.prepare(
        'SELECT * FROM consolidation_log WHERE operation_id = ? ORDER BY created_at ASC',
      ).all(operationId);
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(rows),
        }],
      };
    },
  );
}
