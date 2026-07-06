import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setupTestDb, teardownTestDb, insertTestMemory, type TestContext } from '../helpers/index.js';
import { createRestRequestHandler, type HttpDeps } from '../../src/transport/http.js';
import { createEntity, createRelation } from '../../src/tools/graph.js';

/**
 * v0.29 Fase 3 — daemon web-view /ui + read-only APIs, with security
 * hardening (CSP, XSS-safe, disabled under non-loopback, no error-detail leak,
 * namespace=* handled).
 */

interface Resp { status: number; body: string; headers: Record<string, string | string[] | undefined>; }

function req(baseUrl: string, path: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = httpRequest(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { Host: '127.0.0.1' } },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => { raw += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw, headers: res.headers }));
      },
    );
    r.on('error', reject);
    r.end();
  });
}

function makeServer(ctx: TestContext, extraAllowedHosts: Set<string>): Server {
  const deps: HttpDeps = {
    db: ctx.db, vecStore: ctx.vecStore, embedder: ctx.embedder,
    config: ctx.config, logger: ctx.logger, metrics: ctx.metrics,
  };
  const handler = createRestRequestHandler(ctx.logger, deps, extraAllowedHosts);
  return createServer((rq, rs) => { void handler(rq, rs); });
}

describe('web-view /ui — loopback (secure) mode', () => {
  let ctx: TestContext;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    ctx = setupTestDb();
    server = makeServer(ctx, new Set());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => { server.close(); teardownTestDb(ctx); });

  it('GET /ui returns HTML with a strict CSP header', async () => {
    const res = await req(baseUrl, '/ui');
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/html');
    const csp = String(res.headers['content-security-policy'] ?? '');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    // No external script/style hosts allowed.
    expect(csp).not.toContain('http://');
  });

  it('GET /ui does not use innerHTML with memory content (XSS-safe)', async () => {
    const res = await req(baseUrl, '/ui');
    // The client renders memory/entity strings via textContent / createTextNode,
    // never innerHTML with content.
    expect(res.body).not.toMatch(/\.innerHTML\s*=/);
  });

  it('GET /api/memory/:id returns a memory by id', async () => {
    insertTestMemory(ctx, { id: 'mem-1', content: 'hello world' });
    const res = await req(baseUrl, '/api/memory/mem-1');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { id: string; content: string };
    expect(body.id).toBe('mem-1');
    expect(body.content).toBe('hello world');
  });

  it('GET /api/memory/:id returns 404 for unknown id', async () => {
    const res = await req(baseUrl, '/api/memory/nope');
    expect(res.status).toBe(404);
  });

  it('GET /api/graph returns nodes/edges', async () => {
    const e1 = createEntity({ name: 'Alpha', entity_type: 'concept', namespace: 'default' }, ctx.db, ctx.config, ctx.logger, ctx.metrics);
    const e2 = createEntity({ name: 'Beta', entity_type: 'concept', namespace: 'default' }, ctx.db, ctx.config, ctx.logger, ctx.metrics);
    createRelation({ source_entity_id: e1.id, target_entity_id: e2.id, relation_type: 'relates_to', namespace: 'default' }, ctx.db, ctx.config, ctx.logger, ctx.metrics);

    const res = await req(baseUrl, '/api/graph?namespace=default');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { nodes: unknown[]; edges: unknown[] };
    expect(body.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it('GET /api/graph?namespace=* aggregates across namespaces (not empty)', async () => {
    createEntity({ name: 'InА', entity_type: 'concept', namespace: 'nsA' }, ctx.db, ctx.config, ctx.logger, ctx.metrics);
    createEntity({ name: 'InB', entity_type: 'concept', namespace: 'nsB' }, ctx.db, ctx.config, ctx.logger, ctx.metrics);

    const res = await req(baseUrl, '/api/graph?namespace=*');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { nodes: unknown[] };
    // Must not be silently empty — '*' means all namespaces.
    expect(body.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it('memory content with markup is returned verbatim as data (client renders via textContent)', async () => {
    const xss = '<img src=x onerror=alert(1)>';
    insertTestMemory(ctx, { id: 'xss-1', content: xss });
    const res = await req(baseUrl, '/api/memory/xss-1');
    expect(res.status).toBe(200);
    // Served as JSON, not HTML — so a browser never parses it as markup.
    expect(String(res.headers['content-type'])).toContain('application/json');
    const body = JSON.parse(res.body) as { content: string };
    expect(body.content).toBe(xss);
    // The /ui page must render such content via textContent, not innerHTML.
    const ui = await req(baseUrl, '/ui');
    expect(ui.body).not.toMatch(/\.innerHTML\s*=/);
    expect(ui.body).toContain('textContent');
  });

  it('GET /api/timeline returns timeline entries', async () => {
    insertTestMemory(ctx, { id: 't1', content: 'kubernetes upgrade notes' });
    const row = ctx.db.prepare('SELECT rowid FROM memories WHERE id = ?').get('t1') as { rowid: number };
    ctx.db.prepare('INSERT INTO memories_fts (rowid, content, summary, tags, category) VALUES (?, ?, NULL, ?, ?)').run(row.rowid, 'kubernetes upgrade notes', '[]', 'general');

    const res = await req(baseUrl, '/api/timeline?query=kubernetes');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { entries: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
  });
});

describe('web-view /ui — non-loopback (insecure) mode is disabled', () => {
  let ctx: TestContext;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    ctx = setupTestDb();
    // A non-empty extraAllowedHosts is the signal that the operator opted into
    // NEUROMCP_DAEMON_INSECURE_NON_LOOPBACK — the memory browser must be off.
    server = makeServer(ctx, new Set(['my-lan-host']));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => { server.close(); teardownTestDb(ctx); });

  it('GET /ui is 404 under non-loopback bind', async () => {
    const res = await req(baseUrl, '/ui');
    expect(res.status).toBe(404);
  });

  it('read APIs are 404 under non-loopback bind', async () => {
    insertTestMemory(ctx, { id: 'm', content: 'x' });
    expect((await req(baseUrl, '/api/memory/m')).status).toBe(404);
    expect((await req(baseUrl, '/api/graph')).status).toBe(404);
    expect((await req(baseUrl, '/api/timeline?query=x')).status).toBe(404);
  });
});
