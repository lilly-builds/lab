'use strict';
/* THIS FILE IS FOR text layout, geometry, drawing and canvas resize. Loaded after app-02-state.js, before app-04-editor.js. Plain globals; no IIFE. */

  /* ---------- text layout ---------- */
  var FAMILY = '"Special Elite", "Courier New", monospace';
  var FONT = '400 16px ' + FAMILY;
  /* real advance of the face at 1em: the larger of M and n, measured once the font is loaded */
  function advanceEm() {
    ctx.font = '400 100px ' + FAMILY;
    return Math.max(ctx.measureText('M').width, ctx.measureText('n').width) / 100;
  }
  function wrap(text, maxW, font) {
    ctx.font = font;
    var out = [];
    String(text || '').split('\n').forEach(function (para) {
      var words = para.split(/\s+/).filter(Boolean), line = '';
      if (!words.length) { out.push(''); return; }
      words.forEach(function (w) {
        var t = line ? line + ' ' + w : w;
        if (line && ctx.measureText(t).width > maxW) { out.push(line); line = w; } else line = t;
      });
      out.push(line);
    });
    return out;
  }
  function fitNote(el) {
    if (el.sized) return;
    var s = NOTE;
    while (s < 280 && wrap(el.text, s - 16, FONT).length * 20 > s - 16) s += 20;
    el.w = el.h = s;
  }
  /* note text: 16px, shrinking one px at a time to 12px when the square is too small */
  function noteLayout(el) {
    var fs = 16, font, lh, lines;
    for (; fs >= 12; fs--) {
      font = '400 ' + fs + 'px ' + FAMILY; lh = Math.round(fs * 1.25);
      lines = wrap(el.text, el.w - 16, font);
      if (lines.length * lh <= el.h - 16) break;
    }
    return { font: font, lh: lh, lines: lines, max: Math.floor((el.h - 16) / lh) };
  }
  function textLH(el) { return Math.round(el.size * 1.4); }
  function textBox(el) {
    var font = '400 ' + el.size + 'px ' + FAMILY, lh = textLH(el);
    var lines = wrap(el.text, el.w, font);
    var w = 0; lines.forEach(function (l) { w = Math.max(w, ctx.measureText(l).width); });
    return { lines: lines, font: font, lh: lh, w: Math.max(24, w), h: Math.max(1, lines.length) * lh };
  }

  /* ---------- geometry ---------- */
  function bbox(el) {
    if (el.type === 'pen') {
      var minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      el.pts.forEach(function (p) { minx = Math.min(minx, p[0]); miny = Math.min(miny, p[1]); maxx = Math.max(maxx, p[0]); maxy = Math.max(maxy, p[1]); });
      return { x: el.x + minx, y: el.y + miny, w: maxx - minx, h: maxy - miny };
    }
    if (el.type === 'text') { var t = textBox(el); return { x: el.x, y: el.y, w: t.w, h: t.h }; }
    if (el.type === 'line' || el.type === 'arrow') return { x: Math.min(el.x, el.x + el.w), y: Math.min(el.y, el.y + el.h), w: Math.abs(el.w), h: Math.abs(el.h) };
    return { x: el.x, y: el.y, w: el.w, h: el.h };
  }
  function distSeg(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function hit(el, px, py) {
    var pad = 10 / view.z, pad4 = 4 / view.z;
    if (el.type === 'pen') {
      for (var i = 0; i < el.pts.length; i++) {
        var a = el.pts[i], b = el.pts[i + 1] || a;
        if (distSeg(px, py, el.x + a[0], el.y + a[1], el.x + b[0], el.y + b[1]) < pad) return true;
      }
      return false;
    }
    if (el.type === 'line' || el.type === 'arrow') return distSeg(px, py, el.x, el.y, el.x + el.w, el.y + el.h) < pad;
    var b2 = bbox(el);
    return px >= b2.x - pad4 && px <= b2.x + b2.w + pad4 && py >= b2.y - pad4 && py <= b2.y + b2.h + pad4;
  }
  function topAt(px, py) { for (var i = els.length - 1; i >= 0; i--) if (hit(els[i], px, py)) return els[i]; return null; }

  /* resize handles: corners for boxes, both ends for lines and arrows */
  function handles(el) {
    if (el.type === 'line' || el.type === 'arrow') return [{ x: el.x, y: el.y }, { x: el.x + el.w, y: el.y + el.h }];
    if (el.type === 'text') { var tb = bbox(el); return [{ x: tb.x, y: tb.y }, { x: tb.x + tb.w, y: tb.y }, { x: tb.x + tb.w, y: tb.y + tb.h }, { x: tb.x, y: tb.y + tb.h }]; }
    if (isClosed(el.type) || el.type === 'image' || el.type === 'embed') return [{ x: el.x, y: el.y }, { x: el.x + el.w, y: el.y }, { x: el.x + el.w, y: el.y + el.h }, { x: el.x, y: el.y + el.h }];
    return [];
  }
  function handleAt(el, px, py) {
    var hs = handles(el);
    for (var i = 0; i < hs.length; i++) if (Math.hypot(px - hs[i].x, py - hs[i].y) < 16 / view.z) return i;
    return -1;
  }

  /* ---------- rendering ---------- */
  /* images: first as a CORS-clean canvas image, then once more as a plain DOM image (tainted: shown by the overlay, never drawn on a canvas) */
  function loadImage(url, done) {
    var c = imgCache[url];
    if (c) { if (c.ok || c.tainted) done(c); else c.waiters.push(done); return; }
    c = imgCache[url] = { img: null, ok: false, tainted: false, w: 0, h: 0, waiters: [done] };
    function fin(good, im) {
      var ws = c.waiters; c.waiters = [];
      if (good) { c.w = im.naturalWidth || 300; c.h = im.naturalHeight || 300; } else delete imgCache[url];
      ws.forEach(function (f) { f(good ? c : null); });
    }
    var a = new Image();
    a.crossOrigin = 'anonymous';
    a.onload = function () { c.ok = true; c.img = a; fin(true, a); };
    a.onerror = function () {
      var b = new Image();
      b.referrerPolicy = 'no-referrer';
      b.onload = function () { c.tainted = true; fin(true, b); };
      b.onerror = function () { fin(false); };
      b.src = url;
    };
    a.src = url;
  }
  function getImage(el) {
    var c = imgCache[el.url];
    if (c && c.ok) return c.img;
    if (c && c.tainted) { el.tainted = true; return null; }
    if (!c) loadImage(el.url, function (r) {
      if (r) { draw(); return; }
      var n = els.length;
      els = els.filter(function (e) { return !(e.type === 'image' && e.url === el.url); });
      if (els.length !== n) { if (selId && !selEl()) selId = null; save(); draw(); showErr('An image could not be loaded and was removed.'); }
    });
    return null;
  }
  var imgLayer = document.getElementById('imgs'), imgNodes = {};
  function syncImages() {
    var seen = {};
    els.forEach(function (el) {
      var c = el.type === 'image' ? imgCache[el.url] : null;
      if (!c || !c.tainted) return;
      el.tainted = true; seen[el.id] = true;
      var n = imgNodes[el.id];
      if (!n) {
        n = imgNodes[el.id] = document.createElement('img');
        n.setAttribute('referrerpolicy', 'no-referrer'); n.setAttribute('decoding', 'async'); n.setAttribute('alt', ''); n.draggable = false;
        n.src = el.url; imgLayer.appendChild(n);
      }
      if (n.getAttribute('src') !== el.url) n.src = el.url;
      var sp = toScreen(el.x, el.y);
      n.style.left = sp.x + 'px'; n.style.top = sp.y + 'px'; n.style.transform = 'scale(' + view.z + ')';
      n.style.width = el.w + 'px'; n.style.height = el.h + 'px';
      n.style.opacity = eraseIds[el.id] ? '0.3' : '';
    });
    Object.keys(imgNodes).forEach(function (id) { if (!seen[id]) { imgNodes[id].remove(); delete imgNodes[id]; } });
  }
  function elWidth(el) { return WIDTHS.indexOf(el.strokeWidth) >= 0 ? el.strokeWidth : (el.type === 'pen' ? 2.2 : 1.5); }
  function elDashed(el) { return el.type === 'pen' ? false : (el.dashed != null ? !!el.dashed : !!el.ai); }
  function shapePath(g, el, x, y) {
    g.beginPath();
    if (el.type === 'rect') g.rect(x, y, el.w, el.h);
    else if (el.type === 'diamond') { g.moveTo(x + el.w / 2, y); g.lineTo(x + el.w, y + el.h / 2); g.lineTo(x + el.w / 2, y + el.h); g.lineTo(x, y + el.h / 2); g.closePath(); }
    else { g.ellipse(x + el.w / 2, y + el.h / 2, Math.abs(el.w / 2), Math.abs(el.h / 2), 0, 0, Math.PI * 2); g.closePath(); }
  }
  function drawEl(g, el, ox, oy) {
    var ai = !!el.ai;
    var col = pick(el.strokeColor, STROKES, ai ? '#555' : '#000');
    var lw = elWidth(el);
    g.save();
    g.lineWidth = lw;
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = col;
    g.fillStyle = col;
    if (elDashed(el)) { var k = Math.max(1, lw / 2); g.setLineDash([7 * k, 5 * k]); }
    var x = el.x - ox, y = el.y - oy;
    if (el.type === 'pen') {
      var p = el.pts;
      g.beginPath();
      if (p.length === 1) { g.arc(x + p[0][0], y + p[0][1], Math.max(1.4, lw / 2), 0, Math.PI * 2); g.closePath(); g.fill(); }
      else {
        g.moveTo(x + p[0][0], y + p[0][1]);
        for (var i = 1; i < p.length - 1; i++) g.quadraticCurveTo(x + p[i][0], y + p[i][1], x + (p[i][0] + p[i + 1][0]) / 2, y + (p[i][1] + p[i + 1][1]) / 2);
        g.lineTo(x + p[p.length - 1][0], y + p[p.length - 1][1]);
        g.stroke();
      }
    } else if (el.type === 'note') {
      g.setLineDash([]);
      g.fillStyle = pick(el.fill, NOTE_FILLS, '#bfd7ff'); g.fillRect(x, y, el.w, el.h);
      g.lineWidth = 1; g.strokeStyle = ai ? '#555' : '#000';
      g.setLineDash(ai ? [4, 3] : []);
      g.strokeRect(x + .5, y + .5, el.w - 1, el.h - 1);
      g.setLineDash([]);
      if (editing !== el.id) {
        var nl = noteLayout(el);
        g.fillStyle = '#000'; g.textBaseline = 'top'; g.font = nl.font;
        nl.lines.slice(0, nl.max).forEach(function (l, i) { g.fillText(l, x + 8, y + 8 + i * nl.lh); });
      }
      if (el.l1Done && window.Loop1) Loop1.stamp(g, el, x, y);
    } else if (el.type === 'text') {
      if (editing !== el.id) {
        var t = textBox(el);
        g.font = t.font; g.textBaseline = 'middle'; g.textAlign = 'left';
        g.fillStyle = pick(el.color, STROKES, pick(el.strokeColor, STROKES, '#1e1e1e'));
        t.lines.forEach(function (l, i) { g.fillText(l, x, y + i * t.lh + t.lh / 2); });
      }
    } else if (isClosed(el.type)) {
      shapePath(g, el, x, y);
      var f = pick(el.fill, FILLS, 'none');
      if (f !== 'none') { g.fillStyle = f; g.fill(); }
      g.stroke();
      label(g, el, x + el.w / 2, y + el.h / 2, el.type === 'rect' ? el.w - 12 : el.w * (el.type === 'diamond' ? 0.5 : 0.7));
    } else if (el.type === 'line' || el.type === 'arrow') {
      var x2 = x + el.w, y2 = y + el.h;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
      if (el.type === 'arrow') {
        var a = Math.atan2(el.h, el.w), hl = 12 + lw * 2;
        g.setLineDash([]);
        g.beginPath(); g.moveTo(x2 - hl * Math.cos(a - 0.45), y2 - hl * Math.sin(a - 0.45)); g.lineTo(x2, y2); g.lineTo(x2 - hl * Math.cos(a + 0.45), y2 - hl * Math.sin(a + 0.45)); g.stroke();
      }
    } else if (el.type === 'embed') {
      g.setLineDash(el.pending ? [4, 3] : []); g.lineWidth = 1; g.strokeStyle = '#000'; g.fillStyle = '#000';
      g.strokeRect(x + .5, y + .5, el.w - 1, el.h - 1);
      g.beginPath(); g.moveTo(x, y + 32.5); g.lineTo(x + el.w, y + 32.5); g.stroke();
      g.font = '400 11px ' + FAMILY; g.textBaseline = 'middle';
      var tt = String(el.title || '').toUpperCase(), room = Math.max(0, el.w - 60);
      while (tt && g.measureText(tt).width > room) tt = tt.slice(0, -1);
      g.fillText(tt, x + 10, y + 16);
    } else if (el.type === 'image') {
      var im = getImage(el);
      if (im && !el.tainted) g.drawImage(im, x, y, el.w, el.h);
    }
    g.restore();
  }
  function label(g, el, cx, cy, maxW) {
    if (!el.text) return;
    g.setLineDash([]); g.fillStyle = '#000'; g.font = FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
    var ls = wrap(el.text, Math.max(30, maxW), FONT);
    g.font = FONT;
    ls.forEach(function (l, i) { g.fillText(l, cx, cy + (i - (ls.length - 1) / 2) * 20); });
    g.textAlign = 'left';
  }
  function drawSel(g, el) {
    if (el.type === 'embed') return;
    var b = bbox(el), z = view.z, o = toScreen(b.x, b.y), x = o.x, y = o.y;
    g.save();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineWidth = 1; g.strokeStyle = '#000'; g.setLineDash([4, 3]);
    g.strokeRect(x - 5.5, y - 5.5, b.w * z + 11, b.h * z + 11);
    g.setLineDash([]); g.fillStyle = '#fff';
    handles(el).forEach(function (h) { var hp = toScreen(h.x, h.y); g.fillRect(hp.x - 4.5, hp.y - 4.5, 9, 9); g.strokeRect(hp.x - 4.5, hp.y - 4.5, 9, 9); });
    if (el.type === 'note' && window.NoteResize) NoteResize.paint(g, el, toScreen);
    g.restore();
  }
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, 0, 0);
    var fp = fade ? Math.min(1, (performance.now() - fade.t0) / 250) : 1;
    els.forEach(function (el) {
      if (eraseIds[el.id]) { ctx.save(); ctx.globalAlpha = 0.3; drawEl(ctx, el, view.x, view.y); ctx.restore(); }
      else if (fade && fade.ids[el.id]) { ctx.save(); ctx.globalAlpha = fp; drawEl(ctx, el, view.x, view.y); ctx.restore(); }
      else drawEl(ctx, el, view.x, view.y);
    });
    if (fade) { if (fp < 1) requestAnimationFrame(draw); else fade = null; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var s = selEl();
    if (s && editing !== s.id) drawSel(ctx, s);
    renderProps();
    syncZoomUI();
    syncImages();
    syncEmbeds();
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    draw();
    if (editing) placeEditor();
  }
  window.addEventListener('resize', resize);

