// Cortex — Tilemap viewer (deck.gl + Datashader server tiles).
//
// Engages when the URL has ``?viz=tilemap``. Renders /api/tile/{z}/{x}/{y}.png
// via deck.gl's TileLayer over an OrthographicView in the Cartesian
// coordinate system, plus a quadtree-backed hover layer that resolves
// hit-tests locally from a single /api/quadtree fetch.
//
// Loading discipline:
//   * Scripts and the quadtree fetch start in parallel at mount time.
//   * The canvas mounts as soon as deck.gl loads — tiles stream from
//     the server progressively. The user is never blocked on the full
//     dependency closure.
//   * Hover/click handlers no-op silently until the Arrow + Flatbush
//     deps and the quadtree payload all arrive; then they light up.
//   * Progress surfaces in a small top-left pill, not a centered
//     blocker, so the canvas stays interactive throughout.
//
// Public API:
//   window.JUG.mountTilemap(container)
//
// Mounted by workflow_graph.js when the gate flag is on.
(function () {
  'use strict';

  // Tilemap third-party deps. Served from vendored copies under
  // ``ui/unified/vendor/`` so the view never depends on a CDN being
  // reachable — unpkg outages, restricted networks, or air-gapped
  // installs all work by design now.
  //
  // Fallback: if a vendored file is unexpectedly missing (e.g. a
  // partial sync), the loader falls back to the original CDN URL so a
  // dev machine still works without a vendor sync first.
  //
  // flatbush@4.x ships only an unminified UMD build; ``flatbush.min.js``
  // returns 404 on the CDN — local file is ``flatbush.js``.
  // source: cortex@HEAD~ ui/unified/js/workflow_graph_tilemap.js (2026-05-18)
  // source: https://unpkg.com/flatbush@4.4.0/package.json (files: index.js, flatbush.js)
  var DECKGL_URL = '/vendor/deck.gl.min.js';
  var ARROW_URL  = '/vendor/apache-arrow.min.js';
  var FLATBUSH_URL = '/vendor/flatbush.js';
  var DECKGL_FALLBACK = 'https://unpkg.com/deck.gl@9.0.27/dist.min.js';
  var ARROW_FALLBACK  = 'https://unpkg.com/apache-arrow@17.0.0/Arrow.es2015.min.js';
  var FLATBUSH_FALLBACK = 'https://unpkg.com/flatbush@4.4.0/flatbush.js';

  var KIND_COLOR = {
    domain:    [252, 211,  77, 230],
    tool_hub:  [249, 115,  22, 230],
    skill:     [251, 146,  60, 230],
    command:   [250, 204,  21, 230],
    hook:      [168,  85, 247, 230],
    agent:     [236,  72, 153, 230],
    mcp:       [ 99, 102, 241, 230],
    memory:    [ 16, 185, 129, 230],
    discussion:[239,  68,  68, 230],
    entity:    [ 80, 176, 200, 230],
    file:      [  6, 182, 212, 230],
    symbol:    [100, 116, 139, 230],
  };

  function loadScriptOne(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url; s.crossOrigin = 'anonymous';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('failed to load ' + url)); };
      document.head.appendChild(s);
    });
  }

  // Try the local (vendored) URL first; on failure, fall back to the
  // upstream CDN. Either succeeds → the dep is on window. Both fail →
  // reject with the fallback error so the message stays informative
  // for offline diagnostics.
  // source: cortex@HEAD~ ui/unified/js/workflow_graph_tilemap.js (2026-05-18)
  function loadScript(localUrl, fallbackUrl) {
    return loadScriptOne(localUrl).catch(function () {
      if (!fallbackUrl) throw new Error('failed to load ' + localUrl);
      return loadScriptOne(fallbackUrl);
    });
  }

  // Fetch the raw quadtree bytes. Decoding is deferred until Apache
  // Arrow is loaded so the network round-trip can overlap script loads.
  // ``no_layout`` (HTTP 503) is reported as a tagged Error so the
  // caller can drive recompute without re-reading the body.
  async function fetchQuadtreeBytes() {
    var resp = await fetch('/api/quadtree');
    if (resp.status === 503) {
      var detail = await resp.json().catch(function () { return {}; });
      var err = new Error('quadtree 503: ' + (detail.reason || 'unknown'));
      err.reason = detail.reason || 'unknown';
      err.detail = detail.detail || null;
      throw err;
    }
    if (!resp.ok) throw new Error('quadtree fetch failed: ' + resp.status);
    return await resp.arrayBuffer();
  }

  function decodeQuadtree(buf) {
    var Arrow = window.Arrow || window.apacheArrow || (window['arrow'] || {});
    if (!Arrow.tableFromIPC) throw new Error('Apache Arrow JS not loaded');
    var table = Arrow.tableFromIPC(new Uint8Array(buf));
    var n = table.numRows;
    var ids = new Array(n);
    var kinds = new Array(n);
    var xs = new Float32Array(n);
    var ys = new Float32Array(n);
    var idCol = table.getChild('id');
    var kindCol = table.getChild('kind');
    var xCol = table.getChild('x');
    var yCol = table.getChild('y');
    for (var i = 0; i < n; i++) {
      ids[i] = idCol.get(i);
      kinds[i] = kindCol.get(i);
      xs[i] = xCol.get(i);
      ys[i] = yCol.get(i);
    }
    return { ids: ids, kinds: kinds, xs: xs, ys: ys, count: n };
  }

  // Build a flatbush index over the quadtree positions. Hover queries
  // use bbox search around the cursor's world coordinates; the screen
  // → world projection is provided by deck.gl at hover time.
  function buildIndex(qt) {
    if (!window.Flatbush) throw new Error('Flatbush not loaded');
    var idx = new window.Flatbush(qt.count);
    for (var i = 0; i < qt.count; i++) {
      idx.add(qt.xs[i], qt.ys[i], qt.xs[i], qt.ys[i]);
    }
    idx.finish();
    return idx;
  }

  // Yield to the event loop before the build so the canvas can paint
  // a frame first. For N up to a few hundred thousand this completes
  // in a single tick anyway, but the yield costs nothing.
  function buildIndexAsync(qt) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        try { resolve(buildIndex(qt)); } catch (e) { reject(e); }
      }, 0);
    });
  }

  function pickAt(idx, qt, wx, wy, worldRadius) {
    var hits = idx.search(
      wx - worldRadius, wy - worldRadius,
      wx + worldRadius, wy + worldRadius,
    );
    if (!hits.length) return -1;
    var bestI = -1, bestD = Infinity;
    for (var k = 0; k < hits.length; k++) {
      var h = hits[k];
      var dx = qt.xs[h] - wx, dy = qt.ys[h] - wy;
      var d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; bestI = h; }
    }
    return bestI;
  }

  function createCanvasHost(container) {
    var host = document.createElement('div');
    host.style.cssText = 'position:absolute;inset:0;background:#080810;';
    container.appendChild(host);
    return host;
  }

  function createHoverLabel(container) {
    var label = document.createElement('div');
    label.style.cssText = 'position:absolute;pointer-events:none;background:rgba(8,8,16,0.92);'
      + 'border:1px solid rgba(120,180,200,0.4);border-radius:4px;padding:4px 8px;'
      + "color:#e0e6ec;font:11px/1.3 'JetBrains Mono', monospace;display:none;z-index:5;";
    container.appendChild(label);
    return label;
  }

  // Non-blocking corner pill. The canvas keeps the rest of the
  // surface — the pill only owns 12px of inset. Methods are
  // idempotent so callers can repeatedly post status updates.
  function createStatusPill(container) {
    var el = document.createElement('div');
    el.style.cssText = 'position:absolute;left:12px;top:12px;z-index:10;'
      + "font:11px/1.4 'JetBrains Mono',monospace;color:#9aa4b2;"
      + 'padding:6px 10px;border:1px solid rgba(120,180,200,0.25);'
      + 'border-radius:4px;background:rgba(8,8,16,0.85);'
      + 'max-width:420px;pointer-events:none;'
      + 'transition:opacity 0.25s ease;opacity:0.92;';
    container.appendChild(el);
    function set(color, text) { el.style.color = color; el.textContent = text; el.style.display = 'block'; el.style.opacity = '0.92'; }
    return {
      info:  function (m) { set('#9aa4b2', m); },
      warn:  function (m) { set('#ffb86b', m); },
      error: function (m) { set('#ff8888', m); },
      html:  function (h) { el.innerHTML = h; el.style.display = 'block'; el.style.opacity = '0.92'; },
      hide:  function () { el.style.opacity = '0'; setTimeout(function () { el.style.display = 'none'; }, 300); },
      remove:function () { el.remove(); },
    };
  }

  // Resolve the quadtree bytes, triggering a layout recompute if the
  // server reports no_layout. Each step posts to the pill but never
  // blocks the canvas — recompute runs in this promise chain alone.
  async function ensureQuadtreeBytes(pill) {
    try {
      return await fetchQuadtreeBytes();
    } catch (err) {
      if (!err || err.reason !== 'no_layout') throw err;
      pill.warn('No layout cached. Computing (≈90 s for 1M nodes)…');
      var rr = await fetch('/api/recompute_layout');
      var recompute = await rr.json().catch(function () { return {}; });
      if (recompute.status === 'ok') {
        pill.info('Layout ready (' + recompute.node_count + ' nodes); fetching quadtree…');
        return await fetchQuadtreeBytes();
      }
      if (recompute.reason === 'igraph_missing') {
        pill.html(
          '<div style="color:#ffb86b;margin-bottom:4px"><b>viz-tile extras required</b></div>'
          + '<div style="color:#9aa4b2">'
          + 'Install: <code>pip install -e \'.[viz-tile]\'</code><br>'
          + 'Or: <code>uv pip install \'.[viz-tile]\'</code></div>'
        );
        throw new Error('viz-tile extras required');
      }
      if (recompute.reason === 'no_graph_cached') {
        throw new Error('Graph not built. Visit /api/graph first then retry.');
      }
      throw new Error('Layout failed: ' + JSON.stringify(recompute));
    }
  }

  function makeTileLayer(deck) {
    var TileLayer = deck.TileLayer;
    var BitmapLayer = deck.BitmapLayer;
    var COORDINATE_SYSTEM = deck.COORDINATE_SYSTEM;
    return new TileLayer({
      id: 'graph-tiles',
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      getTileData: function (tile) {
        var z = tile.index.z, x = tile.index.x, y = tile.index.y;
        return fetch('/api/tile/' + z + '/' + x + '/' + y + '.png')
          .then(function (r) { return r.blob(); })
          .then(function (b) { return createImageBitmap(b); });
      },
      tileSize: 512,
      minZoom: 0,
      maxZoom: 10,
      // World ↔ tile mapping. World extent is [-1, 1] on each axis;
      // z=0 has one tile spanning that range.
      extent: [-1, -1, 1, 1],
      renderSubLayers: function (props) {
        var t = props.tile;
        var span = 2 / Math.pow(2, t.index.z);
        var minX = -1 + t.index.x * span;
        var maxX = minX + span;
        var maxY = 1 - t.index.y * span;
        var minY = maxY - span;
        return new BitmapLayer(props, {
          data: null,
          image: props.data,
          bounds: [minX, minY, maxX, maxY],
        });
      },
    });
  }

  // Hover / click handlers are wired at deck construction time but
  // read picking state lazily from the shared ``state`` object.
  // Before the index is built, both no-op silently — the canvas pans
  // and zooms normally; only the tooltip is dormant.
  function handleHover(info, state) {
    if (!state.qt || !state.idx) { state.hoverLabel.style.display = 'none'; return; }
    if (!info || info.coordinate == null) { state.hoverLabel.style.display = 'none'; return; }
    var wx = info.coordinate[0];
    var wy = info.coordinate[1];
    var worldRadius = 12 / Math.pow(2, info.viewport.zoom);
    var hit = pickAt(state.idx, state.qt, wx, wy, worldRadius);
    if (hit < 0) { state.hoverLabel.style.display = 'none'; return; }
    state.hoverLabel.style.display = 'block';
    state.hoverLabel.style.left = (info.x + 12) + 'px';
    state.hoverLabel.style.top = (info.y + 12) + 'px';
    state.hoverLabel.textContent = state.qt.kinds[hit] + ' · ' + state.qt.ids[hit];
  }

  function handleClick(info, state, container) {
    if (!state.qt || !state.idx) return;
    if (!info || info.coordinate == null) return;
    var wx = info.coordinate[0];
    var wy = info.coordinate[1];
    var worldRadius = 18 / Math.pow(2, info.viewport.zoom);
    var hit = pickAt(state.idx, state.qt, wx, wy, worldRadius);
    if (hit < 0) return;
    if (!(window.JUG && JUG._wfg && JUG._wfg.buildSidePanel)) return;
    var qt = state.qt;
    var ctx = state.panelCtx;
    if (!ctx) {
      ctx = { byId: {} };
      for (var k = 0; k < qt.count; k++) {
        ctx.byId[qt.ids[k]] = { id: qt.ids[k], kind: qt.kinds[k] };
      }
      state.panelCtx = ctx;
    }
    var panel = window._tilemap_panel ||
      (window._tilemap_panel = JUG._wfg.buildSidePanel(container));
    try { panel.show(ctx.byId[qt.ids[hit]], ctx); } catch (_) {}
  }

  function createDeck(canvasHost, state, container) {
    var deck = window.deck;
    var OrthographicView = deck.OrthographicView;
    return new deck.Deck({
      parent: canvasHost,
      style: { position: 'absolute', inset: 0 },
      views: [new OrthographicView({
        id: 'ortho',
        controller: { dragRotate: false, scrollZoom: { speed: 0.01, smooth: true } },
      })],
      initialViewState: { target: [0, 0, 0], zoom: 0 },
      onHover: function (info) { handleHover(info, state); },
      onClick: function (info) { handleClick(info, state, container); },
      layers: [makeTileLayer(deck)],
    });
  }

  // Background work that turns hover/click on once all three
  // ingredients arrive. Failures degrade gracefully — the canvas
  // remains pannable and tiles keep rendering even if hover never
  // comes online.
  async function activateHover(state, pill, bytesP, arrowP, flatbushP) {
    try {
      var buf = await bytesP;
      await arrowP;
      pill.info('Decoding quadtree…');
      state.qt = decodeQuadtree(buf);
      if (!state.qt.count) {
        pill.warn('Layout empty. Run /api/recompute_layout to populate.');
        return;
      }
      await flatbushP;
      pill.info('Indexing ' + state.qt.count + ' nodes…');
      state.idx = await buildIndexAsync(state.qt);
      pill.info('Ready · ' + state.qt.count + ' nodes · hover & click live');
      pill.hide();
    } catch (err) {
      pill.warn('Hover unavailable: ' + (err && err.message || String(err)));
    }
  }

  async function mount(container) {
    container.innerHTML = '';
    var canvasHost = createCanvasHost(container);
    var pill = createStatusPill(container);
    var state = {
      deck: null,
      qt: null,
      idx: null,
      panelCtx: null,
      hoverLabel: createHoverLabel(container),
    };

    // Everything async starts now. Scripts, the quadtree fetch, and
    // (if needed) the layout recompute all overlap with each other
    // and with the canvas mount below.
    pill.info('Loading viewer…');
    var deckP = loadScript(DECKGL_URL, DECKGL_FALLBACK);
    var arrowP = loadScript(ARROW_URL, ARROW_FALLBACK);
    var flatbushP = loadScript(FLATBUSH_URL, FLATBUSH_FALLBACK);
    var bytesP = ensureQuadtreeBytes(pill);

    // Phase A — canvas as soon as deck.gl alone is ready. Tiles
    // stream progressively from /api/tile/*.png. Hover stays dark
    // until phase B; pan/zoom work immediately.
    try {
      await deckP;
    } catch (err) {
      pill.error('deck.gl failed to load: ' + err.message);
      return;
    }
    if (!window.deck || !window.deck.Deck) {
      pill.error('deck.gl loaded but did not expose window.deck');
      return;
    }
    state.deck = createDeck(canvasHost, state, container);
    pill.info('Tiles streaming · indexing in background…');

    // Phase B — fire-and-forget. The pill reflects progress; if the
    // index never arrives the canvas is still useful.
    activateHover(state, pill, bytesP, arrowP, flatbushP);

    return {
      destroy: function () {
        try { state.deck && state.deck.finalize(); } catch (_) {}
        if (canvasHost.parentNode) canvasHost.parentNode.removeChild(canvasHost);
        state.hoverLabel.remove();
        pill.remove();
      },
    };
  }

  window.JUG = window.JUG || {};
  window.JUG.mountTilemap = mount;
})();
