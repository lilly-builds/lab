'use strict';
/* THIS FILE IS FOR pointer, gesture and keyboard interaction and the zoom UI. Loaded after app-04-editor.js, before app-06-toolbar.js. Plain globals; no IIFE. */

  /* ---------- pointer interaction ---------- */
  var drag = null, lastTap = { id: null, t: 0 }, interactId = null;
  function pt(e) { return toWorld(e.clientX, e.clientY); }
  function styled(el) {
    el.strokeColor = cur.strokeColor; el.strokeWidth = cur.strokeWidth;
    if (isClosed(el.type)) { el.fill = cur.fill; el.dashed = cur.dashed; }
    else if (el.type === 'line' || el.type === 'arrow') el.dashed = cur.dashed;
    return el;
  }
  /* zoom: set the view (instant, no transition), then redraw everything that follows the scale */
  var ptrs = {}, pinch = null;
  function setView(v) {
    view = { x: v.x, y: v.y, z: clampZ(v.z) };
    saveView(); draw();
    if (editing) placeEditor();
  }
  function zoomBy(f, cx, cy) { setView(zoomAround(view, f, cx, cy)); }
  function zoomReset() {
    /* back to 100% around the current view center */
    var c = toWorld(W / 2, H / 2);
    setView({ x: c.x - W / 2, y: c.y - H / 2, z: 1 });
  }
  function ptrIds() { return Object.keys(ptrs); }
  function pinchGeom() {
    var ids = ptrIds(), a = ptrs[ids[0]], b = ptrs[ids[1]];
    return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  }
  /* a second finger turns the gesture into a pinch: whatever the first finger was doing is undone, leaving no stray element */
  function cancelDrag() {
    var d = drag; drag = null;
    if (!d) return;
    if (d.kind === 'erase') endErase(false);
    else if (d.kind === 'pen' || d.kind === 'shape' || d.kind === 'handle' || d.kind === 'move' || (d.kind === 'text' && d.isNew)) {
      if (undoStack.length) { els = JSON.parse(undoStack.pop()); syncUndo(); save(); }
      if (selId && !selEl()) selId = null;
    } else if (d.kind === 'pan') saveView();
    eraseCur.style.display = 'none';
    draw();
  }
  cv.addEventListener('pointerdown', function (e) {
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (ptrIds().length >= 2 && e.pointerType !== 'mouse') {
      if (editing) commitEdit();
      cancelDrag();
      try { cv.setPointerCapture(e.pointerId); } catch (err) {}
      pinch = pinchGeom();
      return;
    }
    if (!e.isPrimary || drag) return;
    closePanel();
    var p = pt(e);
    var wasEditing = !!editing;
    if (editing) commitEdit();
    cv.setPointerCapture(e.pointerId);
    if (tool === 'erase') {
      drag = { kind: 'erase', lx: p.x, ly: p.y };
      eraseTo(p.x, p.y, p.x, p.y);
      showEraseCur(e);
    } else if (tool === 'pen') {
      snap();
      var el = styled({ id: newId(), type: 'pen', x: p.x, y: p.y, pts: [[0, 0]] });
      els.push(el); drag = { kind: 'pen', el: el };
    } else if (tool === 'note') {
      snap();
      var n = { id: newId(), type: 'note', x: p.x - NOTE / 2, y: p.y - NOTE / 2, w: NOTE, h: NOTE, text: '', fill: cur.noteFill };
      els.push(n); drag = { kind: 'none' };
      setTimeout(function () { editNote(n); }, 0);
    } else if (tool === 'text') {
      var ex = topAt(p.x, p.y);
      if (wasEditing) drag = { kind: 'none' };
      else if (ex && ex.type === 'text') drag = { kind: 'text', el: ex, isNew: false };
      else {
        snap();
        var vz = view.z, tw = Math.max(120, Math.min(280, (W - 32) / vz));
        var tn = { id: newId(), type: 'text', x: Math.max(view.x + 8 / vz, Math.min(p.x, view.x + (W - 8) / vz - tw)), y: p.y, text: '', size: cur.size, color: cur.strokeColor, w: tw };
        els.push(tn); drag = { kind: 'text', el: tn, isNew: true };
      }
    } else if (SHAPES.indexOf(tool) >= 0) {
      snap();
      var sh = styled({ id: newId(), type: tool, x: p.x, y: p.y, w: 0, h: 0 });
      els.push(sh); drag = { kind: 'shape', el: sh, sx: p.x, sy: p.y };
    } else {
      var sel = selEl(), hi = sel ? handleAt(sel, p.x, p.y) : -1;
      if (hi >= 0) {
        snap();
        var hs = handles(sel), anchor = hs[(hi + 2) % 4] || hs[0];
        drag = { kind: 'handle', el: sel, i: hi, ax: anchor.x, ay: anchor.y, ex: sel.x + sel.w, ey: sel.y + sel.h };
        if (sel.type === 'image') { drag.w0 = sel.w; drag.h0 = sel.h; }
        if (sel.type === 'text') { var b0 = bbox(sel); drag.w0 = b0.w; drag.h0 = b0.h; drag.size0 = sel.size; drag.ew0 = sel.w; }
      } else {
        var t = topAt(p.x, p.y);
        if (t) { snap(); selId = t.id; drag = { kind: 'move', el: t, sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y, moved: false }; }
        else { selId = null; drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y }; }
      }
    }
    draw();
  });
  /* eraser: object eraser, hit-tested along the pointer path; removal happens once on release */
  var ERASE_TOL = 8, eraseCur = document.getElementById('eraseCur');
  function eraseHit(el, px, py) {
    if (el.type === 'pen') {
      for (var i = 0; i < el.pts.length; i++) {
        var a = el.pts[i], b = el.pts[i + 1] || a;
        if (distSeg(px, py, el.x + a[0], el.y + a[1], el.x + b[0], el.y + b[1]) < ERASE_TOL / view.z) return true;
      }
      return false;
    }
    return hit(el, px, py);
  }
  function eraseTo(x0, y0, x1, y1) {
    var n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * view.z / 4)), changed = false;
    for (var k = 0; k <= n; k++) {
      var px = x0 + (x1 - x0) * k / n, py = y0 + (y1 - y0) * k / n;
      for (var i = 0; i < els.length; i++) if (!eraseIds[els[i].id] && eraseHit(els[i], px, py)) { eraseIds[els[i].id] = true; changed = true; }
    }
    if (changed) draw();
  }
  function showEraseCur(e) {
    if (tool !== 'erase') { eraseCur.style.display = 'none'; return; }
    eraseCur.style.display = 'block';
    eraseCur.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
  }
  function endErase(remove) {
    var ids = eraseIds, any = Object.keys(ids).length > 0;
    eraseIds = {};
    if (any && remove) {
      snap();
      els = els.filter(function (x) { return !ids[x.id]; });
      if (selId && ids[selId]) selId = null;
      save();
    }
    if (any) draw();
  }
  cv.addEventListener('pointermove', function (e) { if (tool === 'erase') showEraseCur(e); });
  cv.addEventListener('pointerleave', function () { if (!drag) eraseCur.style.display = 'none'; });
  cv.addEventListener('pointermove', function (e) {
    if (ptrs[e.pointerId]) ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (pinch && ptrIds().length >= 2) {
      var g = pinchGeom(), v = zoomAround(view, g.d / pinch.d, pinch.mx, pinch.my);
      /* the world point that was under the old midpoint follows the new midpoint, so the pinch pans too */
      v.x += (pinch.mx - g.mx) / v.z; v.y += (pinch.my - g.my) / v.z;
      pinch = g; view = v; draw();
      if (editing) placeEditor();
      return;
    }
    if (!drag || !e.isPrimary) return;
    var p = pt(e);
    if (drag.kind === 'erase') {
      eraseTo(drag.lx, drag.ly, p.x, p.y); drag.lx = p.x; drag.ly = p.y;
    } else if (drag.kind === 'pen') {
      var el = drag.el, last = el.pts[el.pts.length - 1], q = [p.x - el.x, p.y - el.y];
      if (Math.hypot(q[0] - last[0], q[1] - last[1]) >= 1.5) { el.pts.push(q); draw(); }
    } else if (drag.kind === 'shape') {
      var s = drag.el;
      if (isClosed(s.type)) { s.x = Math.min(drag.sx, p.x); s.y = Math.min(drag.sy, p.y); s.w = Math.abs(p.x - drag.sx); s.h = Math.abs(p.y - drag.sy); }
      else { s.w = p.x - drag.sx; s.h = p.y - drag.sy; }
      draw();
    } else if (drag.kind === 'handle') {
      var h = drag.el;
      if (h.type === 'text') {
        /* corner drag scales the font and wrap width together, never distorts */
        var k = Math.max(Math.abs(p.x - drag.ax) / drag.w0, Math.abs(p.y - drag.ay) / drag.h0);
        h.size = clampSize(drag.size0 * k);
        h.w = Math.max(40, Math.min(2000, drag.ew0 * h.size / drag.size0));
        var nb = bbox(h), right = drag.i === 0 || drag.i === 3, bottom = drag.i === 0 || drag.i === 1;
        h.x = right ? drag.ax - nb.w : drag.ax; h.y = bottom ? drag.ay - nb.h : drag.ay;
      } else if (h.type === 'line' || h.type === 'arrow') {
        if (drag.i === 0) { h.x = p.x; h.y = p.y; h.w = drag.ex - p.x; h.h = drag.ey - p.y; }
        else { h.w = p.x - h.x; h.h = p.y - h.y; }
      } else if (h.type === 'image') {
        /* always proportional from the opposite corner; 24px on the short side up to 1600px on the long side */
        var ik = Math.max(Math.abs(p.x - drag.ax) / drag.w0, Math.abs(p.y - drag.ay) / drag.h0);
        ik = Math.max(24 / Math.min(drag.w0, drag.h0), Math.min(1600 / Math.max(drag.w0, drag.h0), ik));
        h.w = drag.w0 * ik; h.h = drag.h0 * ik;
        h.x = (drag.i === 0 || drag.i === 3) ? drag.ax - h.w : drag.ax; h.y = (drag.i === 0 || drag.i === 1) ? drag.ay - h.h : drag.ay;
      } else {
        var mw = h.type === 'embed' ? EMB_MIN_W : 8, mh = h.type === 'embed' ? EMB_MIN_H : 8;
        h.w = Math.max(mw, Math.abs(p.x - drag.ax)); h.h = Math.max(mh, Math.abs(p.y - drag.ay));
        h.x = p.x < drag.ax ? drag.ax - h.w : drag.ax; h.y = p.y < drag.ay ? drag.ay - h.h : drag.ay;
      }
      draw();
    } else if (drag.kind === 'move') {
      var dx = (e.clientX - drag.sx) / view.z, dy = (e.clientY - drag.sy) / view.z;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      drag.el.x = drag.ox + dx; drag.el.y = drag.oy + dy; draw();
    } else if (drag.kind === 'pan') {
      view.x = drag.vx - (e.clientX - drag.sx) / view.z; view.y = drag.vy - (e.clientY - drag.sy) / view.z; draw();
    }
  });
  function end(e) {
    if (!drag || (e && !e.isPrimary)) return;
    var d = drag; drag = null;
    if (d.kind === 'erase') {
      endErase(!(e && e.type === 'pointercancel'));
      if (e && e.pointerType && e.pointerType !== 'mouse') eraseCur.style.display = 'none';
      return;
    }
    if (d.kind === 'move') {
      if (!d.moved) {
        undoStack.pop(); syncUndo();
        if (d.el.type === 'note') editNote(d.el);
        else if (d.el.type === 'text') {
          var nowT = Date.now();
          if (lastTap.id === d.el.id && nowT - lastTap.t < 350) { lastTap = { id: null, t: 0 }; editText(d.el, false); }
          else lastTap = { id: d.el.id, t: nowT };
        }
        else if (d.el.type === 'embed') {
          var now = Date.now();
          if (lastTap.id === d.el.id && now - lastTap.t < 350 && !d.el.pending) { interactId = d.el.id; lastTap = { id: null, t: 0 }; }
          else lastTap = { id: d.el.id, t: now };
        }
      }
      else save();
    } else if (d.kind === 'text') editText(d.el, d.isNew);
    else if (d.kind === 'pan') saveView();
    else if (d.kind === 'shape') {
      if (Math.hypot(d.el.w, d.el.h) < 6) { els = els.filter(function (x) { return x !== d.el; }); undoStack.pop(); syncUndo(); }
      else { setTool('move'); selId = d.el.id; save(); }
    }
    else save();
    draw();
  }
  function up(e) {
    delete ptrs[e.pointerId];
    if (pinch && ptrIds().length < 2) { pinch = null; saveView(); }
    end(e);
  }
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  if (window.NoteResize) NoteResize.init({
    cv: cv, getSel: selEl, getView: function () { return view; }, toScreen: toScreen,
    canResize: function () { return tool === 'move' && !editing && !drag && !pinch; },
    snap: snap, popUndo: function () { undoStack.pop(); syncUndo(); }, save: save, draw: draw
  });

  /* ctrl+wheel and trackpad pinch zoom around the pointer; plain wheel is left alone. preventDefault stops browser page zoom */
  window.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (modalOpen || cOpen) return;
    var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    zoomBy(Math.exp(-dy * (Math.abs(dy) >= 50 ? 0.002 : 0.01)), e.clientX, e.clientY);
  }, { passive: false });
  /* Safari reports pinch as gesture events; keep them from zooming the page */
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (n) { document.addEventListener(n, function (e) { e.preventDefault(); }); });
  document.addEventListener('keydown', function (e) {
    if (modalOpen || cOpen || e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.25, W / 2, H / 2); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(1 / 1.25, W / 2, H / 2); }
    else if (e.key === '0') { e.preventDefault(); zoomReset(); }
  });
  var zOut = document.getElementById('zOut'), zIn = document.getElementById('zIn'), zPct = document.getElementById('zPct');
  zOut.addEventListener('click', function () { zoomBy(1 / 1.25, W / 2, H / 2); });
  zIn.addEventListener('click', function () { zoomBy(1.25, W / 2, H / 2); });
  zPct.addEventListener('click', zoomReset);
  function syncZoomUI() {
    if (!zPct) return;
    var t = Math.round(view.z * 100) + '%';
    if (zPct.textContent !== t) zPct.textContent = t;
    zOut.disabled = view.z <= MIN_Z + 1e-6; zIn.disabled = view.z >= MAX_Z - 1e-6;
    document.getElementById('embeds').style.setProperty('--iz', String(1 / view.z));
  }
  syncZoomUI();
  /* keep the control above the toolbar/AI prompt, whatever height the dock has */
  (function () {
    var dk = document.getElementById('dock'), zc = document.getElementById('zoom');
    function fit() { zc.style.setProperty('--dockH', dk.offsetHeight + 'px'); }
    fit();
    if (window.ResizeObserver) new ResizeObserver(fit).observe(dk); else window.addEventListener('resize', fit);
  })();

