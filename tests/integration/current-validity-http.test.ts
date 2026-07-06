import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { startHttpTransport, type HttpDeps } from '../../src/transport/http.js';

function httpReq(method: 'GET', url: string): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpRequest(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => { raw += c.toString(); });
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, data: raw }); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const PAST = '2000-01-01T00:00:00.000Z';

describe('HTTP /api/search — current-validity invariant', () => {
  let ctx: TestContext;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    ctx = setupTestDb();
    const deps: HttpDeps = {
      db: ctx.db, vecStore: ctx.vecStore, embedder: ctx.embedder,
      config: ctx.config, logger: ctx.logger, metrics: ctx.metrics,
    };
    const mcpServer = new McpServer({ name: 'test', version: '0.0.0' });
    server = await startHttpTransport(mcpServer, { port: 0, host: '127.0.0.1' }, ctx.logger, deps);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server.close();
    teardownTestDb(ctx);
  });

  async function seed(id: string, content: string, createdAt: string): Promise<void> {
    insertTestMemory(ctx, { id, content, namespace: 'default', category: 'code', created_at: createdAt });
    const e = await ctx.embedder.embed(content);
    ctx.vecStore.upsert(id, e);
    const row = ctx.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
    ctx.db
      .prepare('INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, ?, ?)')
      .run(row.rowid, content, '[]', 'code');
  }

  beforeEach(() => {
    ctx.db.prepare('DELETE FROM memories').run();
    ctx.db.prepare('DELETE FROM memories_fts').run();
    ctx.vecStore.clear();
  });

  it('chrono default hides superseded rows', async () => {
    await seed('old', 'deploy uses ruby 2', '2026-01-01T00:00:00.000Z');
    await seed('new', 'deploy uses ruby 3', '2026-02-01T00:00:00.000Z');
    ctx.db.prepare('UPDATE memories SET superseded_by_id = ? WHERE id = ?').run('new', 'old');

    const { status, data } = await httpReq('GET', `${baseUrl}/api/search?chrono=1&limit=100`);
    expect(status).toBe(200);
    const ids = (data as { results: Array<{ id: string }> }).results.map((r) => r.id);
    expect(ids).toContain('new');
    expect(ids).not.toContain('old');
  });

  it('chrono default hides window-closed rows', async () => {
    await seed('expired', 'token ttl is 5m', '2026-01-01T00:00:00.000Z');
    await seed('live', 'token ttl is 60m', '2026-02-01T00:00:00.000Z');
    ctx.db.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run(PAST, 'expired');

    const { data } = await httpReq('GET', `${baseUrl}/api/search?chrono=1&limit=100`);
    const ids = (data as { results: Array<{ id: string }> }).results.map((r) => r.id);
    expect(ids).toContain('live');
    expect(ids).not.toContain('expired');
  });

  it('chrono include_superseded=1 returns superseded rows', async () => {
    await seed('old', 'deploy uses ruby 2', '2026-01-01T00:00:00.000Z');
    await seed('new', 'deploy uses ruby 3', '2026-02-01T00:00:00.000Z');
    ctx.db.prepare('UPDATE memories SET superseded_by_id = ? WHERE id = ?').run('new', 'old');

    const { data } = await httpReq('GET', `${baseUrl}/api/search?chrono=1&limit=100&include_superseded=1`);
    const ids = (data as { results: Array<{ id: string }> }).results.map((r) => r.id);
    expect(ids).toContain('old');
    expect(ids).toContain('new');
  });

  it('chrono valid_at returns the historical row', async () => {
    await seed('old', 'server port 8080', '2026-01-01T00:00:00.000Z');
    await seed('new', 'server port 9090', '2026-06-01T00:00:00.000Z');
    ctx.db
      .prepare('UPDATE memories SET superseded_by_id = ?, valid_from = ?, valid_to = ? WHERE id = ?')
      .run('new', '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 'old');

    const { data } = await httpReq(
      'GET',
      `${baseUrl}/api/search?chrono=1&limit=100&valid_at=2026-03-01T00:00:00.000Z`,
    );
    const ids = (data as { results: Array<{ id: string }> }).results.map((r) => r.id);
    expect(ids).toContain('old');
  });

  it('hybrid path (with query) hides superseded rows', async () => {
    await seed('old', 'the cache backend is memcached', '2026-01-01T00:00:00.000Z');
    await seed('new', 'the cache backend is redis', '2026-02-01T00:00:00.000Z');
    ctx.db.prepare('UPDATE memories SET superseded_by_id = ? WHERE id = ?').run('new', 'old');

    const { data } = await httpReq('GET', `${baseUrl}/api/search?q=cache+backend&limit=10`);
    const ids = (data as { results: Array<{ id: string }> }).results.map((r) => r.id);
    expect(ids).toContain('new');
    expect(ids).not.toContain('old');
  });
});
