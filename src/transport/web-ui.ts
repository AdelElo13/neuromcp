/**
 * web-ui.ts — the self-contained, read-only memory browser served at GET /ui
 * (v0.29 Fase 3).
 *
 * Security invariants (enforced here + by the CSP header set in http.ts):
 *   - No external resources: all CSS/JS is inline, no CDN, no fonts/images.
 *   - Same-origin fetch only (`connect-src 'self'`).
 *   - XSS-safe: every value coming from the memory store is rendered via
 *     `textContent` / `document.createTextNode`, NEVER `innerHTML` with
 *     content. A memory containing `<img onerror=alert(1)>` renders as inert
 *     text.
 *   - Read-only: the page only issues GET requests to the browse APIs.
 *
 * Exported as a string constant so the daemon can serve it without a file
 * read at request time.
 */

export const WEB_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>neuromcp — memory browser</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 1.25rem; line-height: 1.45; }
  h1 { font-size: 1.15rem; margin: 0 0 1rem; }
  .row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
  input, button, select { font: inherit; padding: 0.4rem 0.6rem; border: 1px solid #8888; border-radius: 6px; background: transparent; color: inherit; }
  button { cursor: pointer; }
  .cols { display: grid; grid-template-columns: 1fr; gap: 1rem; }
  @media (min-width: 800px) { .cols { grid-template-columns: 1fr 1fr; } }
  .panel { border: 1px solid #8883; border-radius: 8px; padding: 0.75rem; overflow-x: auto; }
  .panel h2 { font-size: 0.95rem; margin: 0 0 0.5rem; }
  .item { padding: 0.4rem 0; border-bottom: 1px solid #8882; }
  .item:last-child { border-bottom: none; }
  .meta { font-size: 0.8rem; opacity: 0.7; }
  .content { white-space: pre-wrap; word-break: break-word; }
  .edge { font-size: 0.85rem; opacity: 0.85; }
  .err { color: #c0392b; }
</style>
</head>
<body>
<h1>neuromcp — memory browser <span class="meta">(read-only)</span></h1>
<div class="row">
  <input id="ns" placeholder="namespace (default: server default; * = all)" size="28" />
  <input id="q" placeholder="timeline topic query" size="24" />
  <button id="go">Load</button>
</div>
<div class="cols">
  <div class="panel"><h2>Graph (top entities)</h2><div id="graph"></div></div>
  <div class="panel"><h2>Timeline</h2><div id="timeline"></div></div>
</div>

<script>
(function () {
  'use strict';

  // el(tag, className?, text?) — builds an element; text is set via textContent
  // so store content can never be interpreted as HTML.
  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function showError(node, msg) {
    clear(node);
    node.appendChild(el('div', 'err', 'Error: ' + msg));
  }

  function getJSON(path) {
    return fetch(path, { headers: { 'Accept': 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function qs() {
    var ns = document.getElementById('ns').value.trim();
    return ns ? ('?namespace=' + encodeURIComponent(ns)) : '';
  }

  function loadGraph() {
    var node = document.getElementById('graph');
    clear(node);
    node.appendChild(el('div', 'meta', 'Loading…'));
    getJSON('/api/graph' + qs()).then(function (data) {
      clear(node);
      var nodes = (data && data.nodes) || [];
      var edges = (data && data.edges) || [];
      if (nodes.length === 0) { node.appendChild(el('div', 'meta', 'No entities.')); return; }
      nodes.forEach(function (n) {
        var item = el('div', 'item');
        var entity = n.entity || {};
        item.appendChild(el('div', 'content', entity.name || '(unnamed)'));
        item.appendChild(el('div', 'meta',
          (entity.entity_type || 'entity') + ' · ' + (n.memory_count || 0) + ' memories · ' + (entity.namespace || '')));
        node.appendChild(item);
      });
      if (edges.length > 0) {
        node.appendChild(el('div', 'meta', edges.length + ' edge(s):'));
        edges.forEach(function (e) {
          node.appendChild(el('div', 'edge',
            (e.source_name || '?') + ' —' + ((e.relation && e.relation.relation_type) || 'rel') + '→ ' + (e.target_name || '?')));
        });
      }
    }).catch(function (err) { showError(node, err.message); });
  }

  function loadTimeline() {
    var node = document.getElementById('timeline');
    var q = document.getElementById('q').value.trim();
    clear(node);
    if (!q) { node.appendChild(el('div', 'meta', 'Enter a topic query above.')); return; }
    node.appendChild(el('div', 'meta', 'Loading…'));
    var ns = document.getElementById('ns').value.trim();
    var path = '/api/timeline?query=' + encodeURIComponent(q) + (ns ? '&namespace=' + encodeURIComponent(ns) : '');
    getJSON(path).then(function (data) {
      clear(node);
      var entries = (data && data.entries) || [];
      if (data && data.topic_summary) node.appendChild(el('div', 'meta', data.topic_summary));
      if (entries.length === 0) { node.appendChild(el('div', 'meta', 'No memories for this topic.')); return; }
      entries.forEach(function (entry) {
        var m = entry.memory || {};
        var item = el('div', 'item');
        item.appendChild(el('div', 'content', m.content || ''));
        item.appendChild(el('div', 'meta', (m.created_at || '') + ' · ' + (m.category || '') + ' · id ' + (m.id || '')));
        node.appendChild(item);
      });
    }).catch(function (err) { showError(node, err.message); });
  }

  function loadAll() { loadGraph(); loadTimeline(); }
  document.getElementById('go').addEventListener('click', loadAll);
  document.getElementById('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadAll(); });
  loadGraph();
})();
</script>
</body>
</html>`;
