'use strict';
/* THIS FILE IS FOR free-space and zone layout, the board-to-model scene and the busy state. Loaded after app-07-modal.js, before app-09-route.js. Plain globals; no IIFE. */

  /* ---------- sending ---------- */
  /* ---------- spatial sense: free space, zones, cluster layout ---------- */
  /* PURE-BEGIN (no DOM, no board state; exercised by a node test) */
  function rHit(a, b, pad) { pad = pad || 0; return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y; }
  function rIn(a, s) { return a.x >= s.x - 0.5 && a.y >= s.y - 0.5 && a.x + a.w <= s.x + s.w + 0.5 && a.y + a.h <= s.y + s.h + 0.5; }
  function snap8(v) { return Math.round(v / 8) * 8; }
  /* grid scan: 40px cells, a cell is free when it stays `margin` away from every obstacle; each run of free cells
     is grown downward into maximal rectangles, small and mostly-duplicate ones are dropped, largest first */
  function freeRects(region, obs, o) {
    o = o || {};
    var cell = o.cell || 40, margin = o.margin == null ? 24 : o.margin, minW = o.minW || 160, minH = o.minH || 120, max = o.max || 6;
    var cols = Math.ceil(region.w / cell), rows = Math.ceil(region.h / cell);
    if (!(cols > 0 && rows > 0)) return [];
    var free = [], down = [], r, c;
    for (r = 0; r < rows; r++) {
      free[r] = [];
      for (c = 0; c < cols; c++) {
        var cb = { x: region.x + c * cell, y: region.y + r * cell, w: Math.min(cell, region.w - c * cell), h: Math.min(cell, region.h - r * cell) };
        free[r][c] = !obs.some(function (b) { return rHit(cb, b, margin); });
      }
    }
    for (r = rows - 1; r >= 0; r--) {
      down[r] = [];
      for (c = 0; c < cols; c++) down[r][c] = free[r][c] ? 1 + (r + 1 < rows ? down[r + 1][c] : 0) : 0;
    }
    var cand = [];
    for (r = 0; r < rows; r++) for (var c0 = 0; c0 < cols; c0++) {
      var mh = 1e9;
      for (var c1 = c0; c1 < cols && down[r][c1] > 0; c1++) {
        mh = Math.min(mh, down[r][c1]);
        if (r > 0) { var up = true; for (var k = c0; k <= c1; k++) if (!free[r - 1][k]) { up = false; break; } if (up) continue; }
        var x = region.x + c0 * cell, y = region.y + r * cell;
        var w = Math.min(region.x + region.w, region.x + (c1 + 1) * cell) - x, h = Math.min(region.y + region.h, region.y + (r + mh) * cell) - y;
        if (w >= minW && h >= minH) cand.push({ x: x, y: y, width: w, height: h });
      }
    }
    cand.sort(function (a, b) { return b.width * b.height - a.width * a.height; });
    var out = [];
    cand.forEach(function (a) {
      if (out.length >= max) return;
      var A = a.width * a.height;
      var dup = out.some(function (b) {
        var iw = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), ih = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        return iw > 0 && ih > 0 && iw * ih > 0.7 * A;
      });
      if (!dup) out.push(a);
    });
    return out.map(function (a) { return { x: Math.round(a.x), y: Math.round(a.y), width: Math.round(a.width), height: Math.round(a.height) }; });
  }
  /* nearest top-left (8px aligned, inside S) for a w*h cluster: spiral outward from `want` in 40px steps */
  function spiralSpot(S, w, h, want, ok, o) {
    o = o || {};
    var step = o.step || 40, rings = o.rings == null ? 40 : o.rings;
    var minX = Math.ceil(S.x / 8) * 8, maxX = Math.floor((S.x + S.w - w) / 8) * 8;
    var minY = Math.ceil(S.y / 8) * 8, maxY = Math.floor((S.y + S.h - h) / 8) * 8;
    if (maxX < minX || maxY < minY) return null;
    var bx = Math.min(maxX, Math.max(minX, snap8(want.x))), by = Math.min(maxY, Math.max(minY, snap8(want.y)));
    for (var r = 0; r <= rings; r++) {
      var c = [];
      for (var i = -r; i <= r; i++) for (var j = -r; j <= r; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        var x = bx + i * step, y = by + j * step;
        if (x < minX || x > maxX || y < minY || y > maxY) continue;
        c.push({ x: x, y: y, d: i * i + j * j });
      }
      c.sort(function (a, b) { return a.d - b.d; });
      for (var n = 0; n < c.length; n++) if (ok(c[n].x, c[n].y)) return { x: c[n].x, y: c[n].y };
    }
    return null;
  }
  function shiftEls(list, dx, dy) { list.forEach(function (e) { e.x += dx; e.y += dy; }); }
  /* move one element; arrow/line endpoints that sat on its edges (box `ob`, measured before the move) follow it */
  function moveWithArrows(e, dx, dy, list, ob) {
    var near = function (px, py) { return px >= ob.x - 3 && px <= ob.x + ob.w + 3 && py >= ob.y - 3 && py <= ob.y + ob.h + 3; };
    list.forEach(function (a) {
      if (a === e || (a.type !== 'arrow' && a.type !== 'line')) return;
      var sx = a.x, sy = a.y, ex = a.x + a.w, ey = a.y + a.h;
      if (near(sx, sy)) { a.x += dx; a.y += dy; a.w -= dx; a.h -= dy; }
      if (near(ex, ey)) { a.w += dx; a.h += dy; }
    });
    e.x += dx; e.y += dy;
  }
  /* PURE-END */

  /* visible region minus the safe inset: 24px left/top/right, and room for the floating toolbar below */
  function safeRect() {
    var bot = 110;
    try { var r = dock.getBoundingClientRect(); if (r && r.height > 0) bot = Math.max(110, r.height + 32); } catch (e) {}
    var z = view.z;
    return { x: view.x + 24 / z, y: view.y + 24 / z, w: Math.max(0, (W - 48) / z), h: Math.max(0, (H - 24 - bot) / z) };
  }
  function isLinear(e) { return e.type === 'line' || e.type === 'arrow'; }
  function okBox(b) { return isFinite(b.x) && isFinite(b.y) && isFinite(b.w) && isFinite(b.h); }
  /* boxes that block placement; diagonal lines are sampled so their empty corner stays usable */
  function obstacleBoxes(list) {
    var out = [];
    list.forEach(function (e) {
      if (e.type === 'pen' && !(e.pts && e.pts.length)) return;
      if (isLinear(e) && Math.abs(e.w) > 24 && Math.abs(e.h) > 24) {
        var n = Math.ceil(Math.hypot(e.w, e.h) / 24);
        for (var i = 0; i <= n; i++) out.push({ x: e.x + e.w * i / n - 4, y: e.y + e.h * i / n - 4, w: 8, h: 8 });
      } else { var b = bbox(e); if (okBox(b)) out.push(b); }
    });
    return out;
  }
  function unionBox(boxes) {
    if (!boxes.length) return null;
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    boxes.forEach(function (b) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function boardBounds() { return unionBox(els.filter(function (e) { return !(e.type === 'pen' && !(e.pts && e.pts.length)); }).map(bbox).filter(okBox)); }

  /* zones: big closed shapes with a label and nothing nested inside, labelled by their own text or a text just above */
  function computeZones() {
    var out = [];
    els.forEach(function (s) {
      if (!isClosed(s.type) || !(s.w >= 200 && s.h >= 160) || out.length >= 8) return;
      var b = bbox(s);
      var nested = els.some(function (o) { return o !== s && isClosed(o.type) && rIn(bbox(o), b); });
      if (nested) return;
      var label = typeof s.text === 'string' ? s.text.trim() : '', inside = !!label, best = -1e9;
      if (!label) els.forEach(function (t) {
        if (t.type !== 'text' || !String(t.text).trim()) return;
        var tb = bbox(t), bottom = tb.y + tb.h, cx = tb.x + tb.w / 2;
        if (bottom <= b.y + 4 && bottom >= b.y - 60 && cx >= b.x && cx <= b.x + b.w && bottom > best) { best = bottom; label = String(t.text).trim(); }
      });
      if (!label) return;
      out.push({ id: s.id, label: label.slice(0, 60), x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.w), height: Math.round(b.h), shape: s.type, inside: inside });
    });
    return out;
  }
  function zoneArea(z) {
    var k = z.shape === 'ellipse' ? 0.7 : z.shape === 'diamond' ? 0.5 : 0;
    return k ? { x: z.x + z.width * (1 - k) / 2, y: z.y + z.height * (1 - k) / 2, w: z.width * k, h: z.height * k }
             : { x: z.x + 16, y: z.y + 16, w: z.width - 32, h: z.height - 32 };
  }
  /* row-major slots for n items of cell size cw*ch inside u, 12px gaps, rows hitting an obstacle (or the label band) are skipped */
  function zoneSlots(u, obs, cw, ch, n) {
    var gap = 12, maxCols = Math.max(1, Math.floor((u.w + gap) / (cw + gap))), best = [];
    for (var k = Math.min(n, maxCols); k >= 1; k--) {
      var gw = k * cw + (k - 1) * gap, x0 = u.x + Math.max(0, (u.w - gw) / 2), slots = [];
      var rowsNeeded = Math.ceil(n / k), total = rowsNeeded * ch + (rowsNeeded - 1) * gap;
      var y = obs.length ? u.y : u.y + Math.max(0, (u.h - total) / 2);
      while (y + ch <= u.y + u.h + 0.5 && slots.length < n) {
        var row = [];
        for (var c = 0; c < k; c++) {
          var s = { x: snap8(x0 + c * (cw + gap)), y: snap8(y), w: cw, h: ch };
          if (!obs.some(function (o) { return rHit(s, o, 6); })) row.push(s);
        }
        if (row.length) { slots = slots.concat(row); y += ch + gap; } else y += 8;
      }
      if (slots.length >= n) return slots.slice(0, n);
      if (slots.length > best.length) best = slots;
    }
    return best;
  }
  /* lay a zone's new notes/text into it; returns the items that did not fit anywhere sensible */
  function fillZone(z, items, list, others) {
    var u = zoneArea(z), zb = { x: z.x, y: z.y, w: z.width, h: z.height };
    var obs = obstacleBoxes(els.filter(function (e) { return e.id !== z.id; })).filter(function (b) { return rHit(b, u, 0); }).concat(others);
    if (z.inside) obs.push({ x: u.x - 1, y: z.y + z.height / 2 - 14, w: u.w + 2, h: 28 });
    items.forEach(function (e) { if (e.type === 'note') e._w0 = e.w; else e._s0 = e.size; });
    var res, sizes = function () {
      var bs = items.map(bbox);
      return { cw: Math.ceil(Math.max.apply(null, bs.map(function (b) { return b.w; }))), ch: Math.ceil(Math.max.apply(null, bs.map(function (b) { return b.h; }))) };
    };
    var tryFit = function () { var sz = sizes(); return zoneSlots(u, obs, sz.cw, sz.ch, items.length); };
    res = tryFit();
    [0.9, 0.8].forEach(function (s) {
      if (res.length >= items.length) return;
      items.forEach(function (e) { if (e.type === 'note') e.w = e.h = Math.round(e._w0 * s); });
      res = tryFit();
    });
    for (var g = 0; g < 8 && res.length < items.length && items.some(function (e) { return e.type === 'text' && e.size > 12; }); g++) {
      items.forEach(function (e) { if (e.type === 'text') e.size = Math.max(12, e.size - 2); });
      res = tryFit();
    }
    var placed = items.slice(0, res.length);
    placed.forEach(function (e, i) { moveWithArrows(e, res[i].x - e.x, res[i].y - e.y, list, bbox(e)); });
    var left = items.slice(res.length);
    if (!left.length) return left;
    /* overflow: a clean grid just outside the zone, on its outer side, never over other shapes */
    var bnd = boardBounds() || zb, sz = sizes(), gap = 12;
    var mid = (bnd.x + bnd.w / 2), zc = z.x + z.width / 2;
    var order = zc < mid - bnd.w / 6 ? ['left', 'bottom', 'right', 'top'] : zc > mid + bnd.w / 6 ? ['right', 'bottom', 'left', 'top'] : ['bottom', 'left', 'right', 'top'];
    var blockers = obstacleBoxes(els.filter(function (e) { return e.id !== z.id; })).concat(others);
    for (var si = 0; si < order.length; si++) {
      var side = order[si], horiz = side === 'bottom' || side === 'top';
      var k = horiz ? Math.max(1, Math.min(left.length, Math.floor((z.width + gap) / (sz.cw + gap)))) : Math.min(left.length, 2);
      var rows = Math.ceil(left.length / k), gw = k * sz.cw + (k - 1) * gap, gh = rows * sz.ch + (rows - 1) * gap;
      var gx = side === 'left' ? z.x - 24 - gw : side === 'right' ? z.x + z.width + 24 : z.x + (z.width - gw) / 2;
      var gy = side === 'bottom' ? z.y + z.height + 24 : side === 'top' ? z.y - 24 - gh - 60 : z.y;
      var slots = left.map(function (e, i) { return { x: snap8(gx + (i % k) * (sz.cw + gap)), y: snap8(gy + Math.floor(i / k) * (sz.ch + gap)), w: sz.cw, h: sz.ch }; });
      if (slots.some(function (s) { return blockers.some(function (o) { return rHit(s, o, 12); }); })) continue;
      left.forEach(function (e, i) { moveWithArrows(e, slots[i].x - e.x, slots[i].y - e.y, list, bbox(e)); });
      return [];
    }
    return left;
  }

  /* two new elements overlap unless one is nested in the other (container/label) */
  function clashes(a, b) {
    var ba = bbox(a), bb = bbox(b);
    if (!rHit(ba, bb, 4) || rIn(ba, bb) || rIn(bb, ba)) return false;
    return true;
  }
  function scrollToShow(box) {
    var S = safeRect(), nx = box.w <= S.w ? box.x - (S.x - view.x) - (S.w - box.w) / 2 : box.x - (S.x - view.x);
    var ny = box.h <= S.h ? box.y - (S.y - view.y) - (S.h - box.h) / 2 : box.y - (S.y - view.y);
    view.x = Math.round(nx); view.y = Math.round(ny);
    saveView();
  }
  /* never trust the model's coordinates: clamp, keep the cluster whole, pull it into view, clear of existing things */
  function layoutAdditions(list) {
    list = list.filter(function (e) {
      if (isLinear(e)) return [e.x, e.y, e.w, e.h].every(isFinite);
      if (!okBox(bbox(e))) return false;
      if (e.type === 'rect' || e.type === 'ellipse' || e.type === 'diamond' || e.type === 'image' || e.type === 'embed') {
        e.w = Math.max(e.type === 'embed' ? EMB_MIN_W : 24, Math.min(800, e.w)); e.h = Math.max(e.type === 'embed' ? EMB_MIN_H : 24, Math.min(800, e.h));
      }
      return true;
    });
    if (!list.length) return list;
    var S = safeRect(), zones = computeZones(), zmap = {}, fixed = [];
    zones.forEach(function (z) { zmap[z.id] = z; });
    /* E: items that name a known zone go into it */
    var groups = {};
    list.forEach(function (e) {
      if (typeof e._zone === 'string' && zmap[e._zone] && (e.type === 'note' || e.type === 'text')) (groups[e._zone] = groups[e._zone] || []).push(e);
    });
    var zoned = {};
    Object.keys(groups).forEach(function (id) {
      var left = fillZone(zmap[id], groups[id], list, fixed);
      groups[id].forEach(function (e) { if (left.indexOf(e) < 0) { zoned[e.id] = true; fixed.push(bbox(e)); } });
    });
    var rest = list.filter(function (e) { return !zoned[e.id]; });
    if (rest.length) {
      var obs = obstacleBoxes(els).concat(fixed);
      var boxed = rest.filter(function (e) { return !isLinear(e); });
      var C = unionBox(rest.map(bbox));
      /* a pile of notes/text that overlaps, sticks out, or sits in one row gets re-laid on a 24px grid */
      var onlyNT = rest.every(function (e) { return e.type === 'note' || e.type === 'text'; });
      if (onlyNT && rest.length > 1) {
        var bs = rest.map(bbox), mh = Math.max.apply(null, bs.map(function (b) { return b.h; })), cw = Math.ceil(Math.max.apply(null, bs.map(function (b) { return b.w; })));
        var mess = !rIn(C, S) || (rest.length >= 4 && C.h < 1.5 * mh) || bs.some(function (a, i) { return bs.some(function (b, j) { return j > i && rHit(a, b, 0); }); });
        if (mess) {
          var best = freeRects(S, obs)[0], bw = best ? best.width : S.w;
          var cols = Math.min(rest.length, bw >= 3 * cw + 48 ? 3 : bw >= 2 * cw + 24 ? 2 : 1), rowH = Math.ceil(mh), ox = C.x, oy = C.y;
          rest.forEach(function (e, i) { e.x = ox + (i % cols) * (cw + 24); e.y = oy + Math.floor(i / cols) * (rowH + 24); });
          C = unionBox(rest.map(bbox));
        }
      }
      var rel = boxed.map(bbox).map(function (b) { return { x: b.x - C.x, y: b.y - C.y, w: b.w, h: b.h }; });
      var fits = function (x, y) {
        return rel.every(function (r) { var b = { x: x + r.x, y: y + r.y, w: r.w, h: r.h }; return !obs.some(function (o) { return rHit(b, o, 12); }); });
      };
      var spot = null;
      if (C.w > S.w || C.h > S.h) {
        var anchor = freeRects(S, obs)[0], ax = anchor ? anchor.x : S.x, ay = anchor ? anchor.y : S.y;
        if (fits(ax, ay)) spot = { x: ax, y: ay };
      } else spot = spiralSpot(S, C.w, C.h, { x: C.x, y: C.y }, fits, { step: 40, rings: 40 });
      var scroll = false;
      if (!spot) {
        var B = unionBox(obs);
        if (B) { spot = { x: Math.ceil(B.x / 8) * 8, y: Math.ceil((B.y + B.h + 48) / 8) * 8 }; scroll = true; }
        else spot = { x: C.x, y: C.y };
      }
      shiftEls(rest, spot.x - C.x, spot.y - C.y);
      /* 4: still-overlapping elements slide right, then down, in 24px steps (their arrows follow) */
      var offs = [];
      for (var m = 0; m <= 10; m++) for (var q = 0; q <= 10; q++) if (m || q) offs.push({ dx: q * 24, dy: m * 24 });
      boxed.forEach(function (e, i) {
        var earlier = boxed.slice(0, i);
        if (!earlier.some(function (o) { return clashes(e, o); })) return;
        for (var pass = 0; pass < 2; pass++) for (var oi = 0; oi < offs.length; oi++) {
          var ob = bbox(e), nb = { x: ob.x + offs[oi].dx, y: ob.y + offs[oi].dy, w: ob.w, h: ob.h };
          if (pass === 0 && !rIn(nb, S)) continue;
          if (obs.some(function (o) { return rHit(nb, o, 6); })) continue;
          e.x += offs[oi].dx; e.y += offs[oi].dy;
          var bad = earlier.some(function (o) { return clashes(e, o); });
          e.x -= offs[oi].dx; e.y -= offs[oi].dy;
          if (bad) continue;
          moveWithArrows(e, offs[oi].dx, offs[oi].dy, rest, ob);
          return;
        }
      });
      /* 5: snap to the 8px grid; arrow ends that touched an element move with it */
      boxed.forEach(function (e) { moveWithArrows(e, snap8(e.x) - e.x, snap8(e.y) - e.y, rest, bbox(e)); });
      if (scroll) { var U0 = unionBox(list.map(bbox).filter(okBox)); if (U0) scrollToShow(U0); }
    }
    /* anything still outside the safe area (zone grids, oversize clusters): scroll the view so it is all visible */
    var U = unionBox(list.map(bbox).filter(okBox)), S2 = safeRect();
    if (U && !rIn(U, S2)) scrollToShow(U);
    list.forEach(function (e) { delete e._zone; delete e._w0; delete e._s0; });
    return list;
  }

  function sceneForModel() {
    var vis = { x: Math.round(view.x), y: Math.round(view.y), width: Math.round(W / view.z), height: Math.round(H / view.z) };
    var list = els.map(function (el) {
      var b = bbox(el), o = { id: el.id, type: el.type };
      if (el.type === 'line' || el.type === 'arrow') { o.x1 = Math.round(el.x); o.y1 = Math.round(el.y); o.x2 = Math.round(el.x + el.w); o.y2 = Math.round(el.y + el.h); }
      else { o.x = Math.round(b.x); o.y = Math.round(b.y); o.width = Math.round(b.w); o.height = Math.round(b.h); }
      if (el.text) o.text = el.text;
      else if (el.type === 'embed' && el.title) o.text = el.title;
      if (el.url) o.url = el.url;
      if (el.type === 'text') { o.size = el.size; o.color = el.color; }
      if (el.strokeColor) o.strokeColor = el.strokeColor;
      if (el.fill && el.fill !== 'none') o.fill = el.fill;
      if (el.strokeWidth) o.strokeWidth = el.strokeWidth;
      if (el.dashed != null) o.dashed = !!el.dashed;
      if (el.ai) o.byAI = true;
      return o;
    });
    var S = safeRect(), free = freeRects(S, obstacleBoxes(els)), b = boardBounds();
    var zones = computeZones().map(function (z) { return { id: z.id, label: z.label, x: z.x, y: z.y, width: z.width, height: z.height, shape: z.shape }; });
    var out = { view: vis, bounds: b ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.w), height: Math.round(b.h) } : null, free: free, elements: list };
    if (zones.length) out.zones = zones;
    return out;
  }
  function boardPng() {
    var k = Math.min(1, 1400 / Math.max(W, H));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W * k)); c.height = Math.max(1, Math.round(H * k));
    var g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.scale(k * view.z, k * view.z);
    els.forEach(function (el) { drawEl(g, el, view.x, view.y); });
    try { return c.toDataURL('image/png').split(',')[1]; } catch (e) { return null; }
  }
  var PHRASES = ['Thinking'];
  var statusEl = document.getElementById('status'), stopBtn = document.getElementById('stopBtn'), curAbort = null, phraseTimer = null, phraseSwap = null, timeoutTimer = null, timedOut = false;
  function showPhrase(i) {
    var sp = statusEl.firstChild;
    if (!sp) { sp = document.createElement('span'); statusEl.appendChild(sp); }
    sp.textContent = PHRASES[i]; sp.classList.add('on');
  }
  /* the words under the input; one list per stage, cycled while a call is in flight */
  function setPhrases(list) {
    PHRASES = list && list.length ? list : ['Thinking'];
    clearInterval(phraseTimer); clearTimeout(phraseSwap);
    var i = 0;
    showPhrase(0);
    if (PHRASES.length < 2) return;
    phraseTimer = setInterval(function () {
      i = (i + 1) % PHRASES.length;
      var sp = statusEl.firstChild;
      if (sp) sp.classList.remove('on');
      clearTimeout(phraseSwap);
      phraseSwap = setTimeout(function () { showPhrase(i); }, 200);
    }, 2500);
  }
  function startBusy() {
    busy = true; timedOut = false;
    magic.classList.add('busy'); panel.classList.add('busy'); document.body.classList.add('busy');
    panel.setAttribute('aria-busy', 'true');
    ask.disabled = true;
    setPhrases(['Thinking']);
  }
  function endBusy() {
    busy = false; curAbort = null;
    clearInterval(phraseTimer); clearTimeout(phraseSwap); clearTimeout(timeoutTimer);
    statusEl.textContent = '';
    magic.classList.remove('busy'); panel.classList.remove('busy'); document.body.classList.remove('busy');
    panel.removeAttribute('aria-busy');
    ask.disabled = false;
  }
  function cancelSend() { if (busy && curAbort) curAbort.abort(); }
  stopBtn.addEventListener('click', function () { cancelSend(); ask.focus(); });
