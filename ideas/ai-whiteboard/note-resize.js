/* NOTE RESIZE: drag the bottom-right corner of a selected sticky note to resize it live.
   Pointer events, so mouse, pen and touch all work. The hit area is 28px on screen at any
   zoom; the handle is a thin black outline square. Width and height are independent.
   Resized notes carry `sized: true` so fitNote leaves them alone; old boards have no flag.
   Text re-fit needs no code here: noteLayout scales the font from el.w / el.h. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.NoteResize = api;
})(typeof self !== 'undefined' ? self : this, function () {
  var MIN = 100, MAX = 360, HIT = 28, HANDLE = 9;

  /* a note already outside the range keeps its size until the drag actually moves it inside */
  function clampDim(v, start) {
    var lo = Math.min(MIN, start), hi = Math.max(MAX, start);
    v = Number(v);
    if (!isFinite(v)) return start;
    return Math.round(Math.max(lo, Math.min(hi, v)));
  }
  /* new size for a drag of (dx, dy) world units from a note that started at w0 x h0 */
  function nextSize(w0, h0, dx, dy) {
    return { w: clampDim(w0 + dx, w0), h: clampDim(h0 + dy, h0) };
  }
  /* is the screen point (sx, sy) on the 28px hit area centred on the note's bottom-right corner? */
  function hitCorner(el, toScreen, sx, sy) {
    if (!el || el.type !== 'note') return false;
    var c = toScreen(el.x + el.w, el.y + el.h);
    return Math.abs(sx - c.x) <= HIT / 2 && Math.abs(sy - c.y) <= HIT / 2;
  }
  /* screen-space paint: g already has the dpr transform */
  function paint(g, el, toScreen) {
    if (!el || el.type !== 'note') return;
    var c = toScreen(el.x + el.w, el.y + el.h);
    g.save();
    g.setLineDash([]); g.lineWidth = 1; g.strokeStyle = '#000'; g.fillStyle = '#fff';
    g.fillRect(c.x - HANDLE / 2, c.y - HANDLE / 2, HANDLE, HANDLE);
    g.strokeRect(c.x - HANDLE / 2 + 0.5, c.y - HANDLE / 2 + 0.5, HANDLE - 1, HANDLE - 1);
    g.restore();
  }

  /* o: { cv, win, getSel(), getView(), toScreen(x,y), canResize(), snap(), popUndo(), save(), draw() } */
  function init(o) {
    var win = o.win || (typeof window !== 'undefined' ? window : null);
    var st = null;
    if (!win) return null;

    function finish(cancel) {
      var s = st; st = null;
      if (!s) return;
      try { o.cv.releasePointerCapture(s.id); } catch (err) {}
      var el = s.el, changed = el.w !== s.w0 || el.h !== s.h0;
      if (cancel || !changed) {
        el.w = s.w0; el.h = s.h0;
        if (s.sized0) el.sized = true; else delete el.sized;
        o.popUndo();
        o.draw();
        return;
      }
      o.save();
      o.draw();
    }
    win.addEventListener('pointerdown', function (e) {
      if (st) { finish(true); return; } /* a second finger: restore, let the pinch take over */
      if (e.target !== o.cv || !e.isPrimary || !o.canResize()) return;
      var el = o.getSel();
      if (!el || !hitCorner(el, o.toScreen, e.clientX, e.clientY)) return;
      e.stopPropagation(); e.preventDefault();
      o.snap();
      st = { id: e.pointerId, el: el, sx: e.clientX, sy: e.clientY, w0: el.w, h0: el.h, sized0: el.sized === true };
      try { o.cv.setPointerCapture(e.pointerId); } catch (err) {}
    }, true);
    win.addEventListener('pointermove', function (e) {
      if (!st || e.pointerId !== st.id) return;
      var z = o.getView().z, n = nextSize(st.w0, st.h0, (e.clientX - st.sx) / z, (e.clientY - st.sy) / z);
      if (n.w !== st.el.w || n.h !== st.el.h) {
        st.el.w = n.w; st.el.h = n.h; st.el.sized = true;
        o.draw();
      }
    });
    win.addEventListener('pointerup', function (e) { if (st && e.pointerId === st.id) finish(false); });
    win.addEventListener('pointercancel', function (e) { if (st && e.pointerId === st.id) finish(true); });
    return { active: function () { return !!st; }, cancel: function () { finish(true); } };
  }

  return { MIN: MIN, MAX: MAX, HIT: HIT, HANDLE: HANDLE, clampDim: clampDim, nextSize: nextSize, hitCorner: hitCorner, paint: paint, init: init };
});
