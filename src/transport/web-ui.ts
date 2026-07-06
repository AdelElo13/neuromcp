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
  #gcanvas { width: 100%; height: 440px; display: block; border-radius: 6px; background: #8881; cursor: grab; touch-action: none; }
  #gcanvas.grabbing { cursor: grabbing; }
  #ghint { font-size: 0.78rem; opacity: 0.65; margin-top: 0.35rem; }
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
  <div class="panel"><h2>Graph (entities &amp; relations)</h2><canvas id="gcanvas"></canvas><div id="ghint"></div></div>
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

  // ── Force-directed graph on <canvas> ────────────────────────────────
  // Hand-rolled spring/repulsion sim — no external lib (CSP forbids CDN).
  // Labels drawn with fillText (canvas text is inert, no HTML injection),
  // so the XSS-safe invariant holds without innerHTML.
  var G = { nodes: [], edges: [], scale: 1, ox: 0, oy: 0, raf: 0, drag: null, pan: null, hover: null };

  function hashHue(s) { var h = 0, i; for (i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) % 360; } return h; }
  function nodeRadius(n) { return Math.max(5, Math.min(26, 5 + Math.sqrt(n.mem || 0) * 3.2)); }

  function fitView(cv) {
    // Center the cloud in the canvas on first layout.
    if (G.nodes.length === 0) return;
    var minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    G.nodes.forEach(function (n) { minx = Math.min(minx, n.x); miny = Math.min(miny, n.y); maxx = Math.max(maxx, n.x); maxy = Math.max(maxy, n.y); });
    var w = maxx - minx || 1, h = maxy - miny || 1;
    G.scale = Math.min(cv.width / (w + 120), cv.height / (h + 120), 1.6);
    G.ox = cv.width / 2 - (minx + maxx) / 2 * G.scale;
    G.oy = cv.height / 2 - (miny + maxy) / 2 * G.scale;
  }

  function step() {
    var i, j, a, b, dx, dy, d2, d, f, ns = G.nodes;
    for (i = 0; i < ns.length; i++) {
      a = ns[i];
      // centering gravity
      a.vx += -a.x * 0.0016; a.vy += -a.y * 0.0016;
      for (j = i + 1; j < ns.length; j++) {
        b = ns[j];
        dx = a.x - b.x; dy = a.y - b.y; d2 = dx * dx + dy * dy || 0.01; d = Math.sqrt(d2);
        f = 4200 / d2; // repulsion
        var ux = dx / d, uy = dy / d;
        a.vx += ux * f; a.vy += uy * f; b.vx -= ux * f; b.vy -= uy * f;
      }
    }
    G.edges.forEach(function (e) {
      a = e.a; b = e.b; if (!a || !b) return;
      dx = b.x - a.x; dy = b.y - a.y; d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      f = (d - 70) * 0.015; // spring toward rest length 70
      var ux = dx / d, uy = dy / d;
      a.vx += ux * f; a.vy += uy * f; b.vx -= ux * f; b.vy -= uy * f;
    });
    for (i = 0; i < ns.length; i++) {
      a = ns[i];
      if (a === (G.drag && G.drag.node)) { a.vx = 0; a.vy = 0; continue; }
      a.vx *= 0.86; a.vy *= 0.86;
      a.x += a.vx; a.y += a.vy;
    }
  }

  function draw(cv, ctx) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.save(); ctx.translate(G.ox, G.oy); ctx.scale(G.scale, G.scale);
    ctx.lineWidth = 1 / G.scale;
    G.edges.forEach(function (e) {
      if (!e.a || !e.b) return;
      var hot = G.hover && (e.a === G.hover || e.b === G.hover);
      ctx.strokeStyle = hot ? 'rgba(90,150,255,0.9)' : 'rgba(136,136,136,0.35)';
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();
    });
    ctx.font = (11 / G.scale) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    G.nodes.forEach(function (n) {
      var r = nodeRadius(n);
      var dim = G.hover && G.hover !== n && !(G.hover.adj && G.hover.adj[n.name]);
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'hsl(' + n.hue + ',65%,55%)'; ctx.fill();
      if (n === G.hover) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / G.scale; ctx.stroke(); }
      ctx.fillStyle = getComputedStyle(cv).color;
      ctx.fillText(n.name.length > 22 ? n.name.slice(0, 21) + '…' : n.name, n.x, n.y + r + 2);
      ctx.globalAlpha = 1;
    });
    ctx.restore();
  }

  function toWorld(cv, ev) {
    var rect = cv.getBoundingClientRect();
    var sx = (ev.clientX - rect.left) * (cv.width / rect.width);
    var sy = (ev.clientY - rect.top) * (cv.height / rect.height);
    return { x: (sx - G.ox) / G.scale, y: (sy - G.oy) / G.scale, sx: sx, sy: sy };
  }
  function pick(cv, ev) {
    var p = toWorld(cv, ev), i, n, dx, dy, r;
    for (i = G.nodes.length - 1; i >= 0; i--) {
      n = G.nodes[i]; dx = p.x - n.x; dy = p.y - n.y; r = nodeRadius(n) + 4 / G.scale;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }

  function loadGraph() {
    var cv = document.getElementById('gcanvas');
    var hint = document.getElementById('ghint');
    var ctx = cv.getContext('2d');
    hint.textContent = 'Loading graph…';
    // size the backing store to the element (device pixels)
    cv.width = cv.clientWidth || 600; cv.height = cv.clientHeight || 440;
    getJSON('/api/graph' + qs()).then(function (data) {
      var rawNodes = (data && data.nodes) || [];
      var rawEdges = (data && data.edges) || [];
      if (G.raf) { cancelAnimationFrame(G.raf); G.raf = 0; }
      if (rawNodes.length === 0) { ctx.clearRect(0, 0, cv.width, cv.height); hint.textContent = 'No entities in this namespace.'; return; }
      var byName = {};
      G.nodes = rawNodes.map(function (n, i) {
        var ent = n.entity || {};
        var nm = ent.name || '(unnamed)';
        var ang = (i / rawNodes.length) * Math.PI * 2;
        var node = {
          name: nm, type: ent.entity_type || 'entity', ns: ent.namespace || '',
          mem: n.memory_count || 0, hue: hashHue(ent.entity_type || nm),
          x: Math.cos(ang) * 140 + (i % 7) * 3, y: Math.sin(ang) * 140 + (i % 5) * 3,
          vx: 0, vy: 0, adj: {}
        };
        byName[nm] = node; return node;
      });
      G.edges = rawEdges.map(function (e) {
        var a = byName[e.source_name], b = byName[e.target_name];
        if (a && b) { a.adj[b.name] = 1; b.adj[a.name] = 1; }
        return { a: a, b: b, type: (e.relation && e.relation.relation_type) || 'rel' };
      });
      var warm = 0;
      function frame() {
        step();
        if (warm < 60) { warm++; if (warm === 60) fitView(cv); }
        draw(cv, ctx);
        G.raf = requestAnimationFrame(frame);
      }
      // pre-settle a bit, then fit + animate
      var k; for (k = 0; k < 120; k++) step();
      fitView(cv);
      hint.textContent = G.nodes.length + ' entities · ' + G.edges.length + ' relations · drag nodes, scroll to zoom, click a node to see its memories';
      frame();
    }).catch(function (err) { hint.textContent = 'Error: ' + err.message; });

    // interaction (bind once)
    if (!cv._wired) {
      cv._wired = true;
      cv.addEventListener('mousedown', function (ev) {
        var n = pick(cv, ev);
        if (n) { G.drag = { node: n, moved: false }; }
        else { var p = toWorld(cv, ev); G.pan = { sx: p.sx, sy: p.sy, ox: G.ox, oy: G.oy }; }
        cv.classList.add('grabbing');
      });
      cv.addEventListener('mousemove', function (ev) {
        if (G.drag) { var p = toWorld(cv, ev); G.drag.node.x = p.x; G.drag.node.y = p.y; G.drag.moved = true; }
        else if (G.pan) { var q = toWorld(cv, ev); G.ox = G.pan.ox + (q.sx - G.pan.sx); G.oy = G.pan.oy + (q.sy - G.pan.sy); }
        else { G.hover = pick(cv, ev); }
      });
      window.addEventListener('mouseup', function () {
        if (G.drag && !G.drag.moved) {
          // click (no drag) → load that entity's memories into the timeline
          document.getElementById('q').value = G.drag.node.name;
          loadTimeline();
        }
        G.drag = null; G.pan = null; cv.classList.remove('grabbing');
      });
      cv.addEventListener('wheel', function (ev) {
        ev.preventDefault();
        var p = toWorld(cv, ev), factor = ev.deltaY < 0 ? 1.1 : 0.9;
        G.scale *= factor;
        G.ox = p.sx - p.x * G.scale; G.oy = p.sy - p.y * G.scale;
      }, { passive: false });
    }
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
