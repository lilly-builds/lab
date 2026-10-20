'use strict';
/* THIS FILE IS FOR booting: font repaint, Loop1 hand-off, welcome seed, the sync surface (window.AIWB) and dispatch. Loaded last, after app-14-loops.js. Plain globals; no IIFE. */

  if (document.fonts && document.fonts.load) {
    document.fonts.load('16px "Special Elite"').then(draw, draw);
    document.fonts.ready.then(draw);
  }

  /* LOOP1-HOOK (the Have to loop lives in loop1.js; this only hands it the board) */
  if (window.Loop1) Loop1.init({
    ta: ta, cv: cv, NOTE: NOTE, els: function () { return els; }, bbox: bbox, newId: newId, fitNote: fitNote, snap: snap, save: save, draw: draw, inDream: inDream,
    editingId: function () { return editing; }, bubble: dreamBubble, closeBubble: dreamClose, bubbleBox: function () { return dreamBox; },
    hasKey: function () { return !!getKey(PROVIDER); }, needKey: function () { openModal({ opener: magic }); },
    badKey: function () { openModal({ opener: magic, replace: true, message: "That key didn't work." }); },
    complete: function (o) { return providers[PROVIDER].complete({ system: o.system, text: o.text, model: modelFor('fast'), key: getKey(PROVIDER), signal: o.signal, maxTokens: o.maxTokens, job: o.job, ask: o.ask }); }
  });

  gcApps();
  resize();
  pollTick();
  var tplId = new URLSearchParams(location.search).get('template');
  /* first visit only: three ordinary notes explain the board; the flag keeps them from coming back */
  function seedWelcome() {
    if (els.length || lsGet(KEY_SCENE) || lsGet('aiwb.welcomed')) return;
    /* dream board, ring origins re-spaced for 580px rings: Dream top-center, Have to do / Want to do flanking below.
       the last number per ring is its label's x offset from the ring origin */
    var RD = 580;
    var rings = [[500, 0, 'Dream', 258], [40, 360, 'Have to do', 218], [960, 360, 'Want to do', 218]].map(function (p) {
      return { ring: { id: newId(), type: 'ellipse', x: p[0], y: p[1], w: RD, h: RD }, label: { id: newId(), type: 'text', x: p[0] + p[3], y: p[1] - 51, text: p[2], size: 24, w: 280 } };
    });
    /* every onboarding note is 1.3x the usual fitted size */
    var BIG = 1.3;
    var mk = function (text, fill, x, y) { var n = { id: newId(), type: 'note', x: x, y: y, w: NOTE, h: NOTE, text: text, fill: fill }; fitNote(n); n.w = n.h = Math.round(n.w * BIG); return n; };
    var G = '#b2f2bb', Y = '#ffec99', B = '#bfd7ff';
    var na = mk('welcome! this is a whiteboard where you can collab with ai, friends, and colleagues.', G, 30, 20);
    var nb = mk('draw or drop an idea, to-do, or dream.', Y, na.x + na.w + 20, 110);
    /* the have-to pair and the blank answer sit inside the Have to do circle */
    var nc = mk("What's some shit you have to do that you don't want to?", B, rings[1].ring.x + 90, rings[1].ring.y + 120);
    var nd = mk('the board will get it done.', Y, nc.x + nc.w + 20, nc.y + 50);
    /* the sparkle pair sits low and centered, nearest the dock's sparkle button */
    var ne = mk('tap the sparkle in the toolbar to bring ai to the table. ask a question, build a prototype, turn a dream into a plan.', B, 0, 780);
    var nf = mk('the first time, it will ask for your own AI key (Anthropic or OpenAI). it never leaves your device.', B, 0, 780);
    ne.x = Math.round(790 - (ne.w + 14 + nf.w) / 2); nf.x = ne.x + ne.w + 14;
    var notes = [na, nb, nc, nd, ne, nf];
    /* the thesis: the biggest note of the sequence lands centered in the Dream circle (1.6x on top of the bigger base) */
    var MANIFESTO = "here's why this exists: so you can dream and make your dreams real. so you spend more life in 'want to' instead of 'have to' moments.";
    var man = mk(MANIFESTO, G, 0, 0);
    man.w = man.h = Math.round(NOTE * BIG * 1.6);
    man.x = Math.round(rings[0].ring.x + RD / 2 - man.w / 2); man.y = Math.round(rings[0].ring.y + RD / 2 - man.h / 2);
    /* the final beat: a blank sticky answering the (c) question note; the one constant to swap for another spot */
    var blank = mk('', Y, nc.x + 30, nc.y + nc.h + 30);
    var fin = [];
    rings.forEach(function (r) { fin.push(r.ring, r.label); });
    fin = fin.concat(notes, [man, blank]);
    var full = notes.map(function (n) { return n.text; });
    var labelFull = rings.map(function (r) { return r.label.text; });
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    /* frame the board up front: fit its box above the dock with a small margin, zoom out only (never past 1) */
    els = fin.slice();
    var bb = boardBounds(), bot = 110;
    try { var dr = dock.getBoundingClientRect(); if (dr && dr.height > 0) bot = Math.max(110, dr.height + 32); } catch (e) {}
    view = { x: 0, y: 0, z: 1 };
    if (bb && bb.w > 0 && bb.h > 0 && W > 0 && H > 0) {
      var aw = Math.max(1, W - 48), ah = Math.max(1, H - 24 - bot);
      var fz = clampZ(Math.min(1, aw / bb.w, ah / bb.h));
      view = { x: Math.round(bb.x + bb.w / 2 - W / 2 / fz), y: Math.round(bb.y + bb.h / 2 - (24 + ah / 2) / fz), z: fz };
    }
    lsSet('aiwb.welcomed', '1');
    save(); saveView(); draw();
    if (still) return;
    /* replay toward the saved end state (ms): rings sweep 1.1s staggered 450ms, then each sticky eases in (soft rise + fade, 650ms)
       and types at 19 chars/s with 700ms of air between beats; then the manifesto, then a blank note with the editor open.
       Circle labels type in during their own draw-in. While the sparkle pair types, the dock's sparkle glows.
       Any tap or key jumps straight to the end; input is never blocked. */
    var RING = 1100, STAG = 450, CPS = 19, RISE = 650, TYPE_AT = 350, GAP = 700, GLOW_OUT = 900;
    var easeOut = function (u) { return 1 - Math.pow(1 - u, 3); };
    var easeInOut = function (u) { return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; };
    var clamp01 = function (u) { return Math.max(0, Math.min(1, u)); };
    var tt = RING + 2 * STAG + 500, seq = [];
    notes.concat([man]).forEach(function (n) {
      var big = n === man, txt = big ? MANIFESTO : full[notes.indexOf(n)], rise = big ? 900 : RISE;
      seq.push({ el: n, text: txt, start: tt, rise: rise, dist: big ? 28 : 14 });
      tt += Math.max(rise, TYPE_AT + txt.length * 1000 / CPS) + GAP;
    });
    seq.push({ el: blank, text: '', start: tt, rise: RISE, dist: 14 });
    var tFin = tt + RISE + 600;
    var gStart = seq[4].start, gEnd = seq[5].start + TYPE_AT + full[5].length * 1000 / CPS + 200;
    var t0 = performance.now(), raf = 0, done = false, mg = document.getElementById('magic');
    var glow = function (a, pulse) {
      if (!mg) return;
      mg.style.boxShadow = a > 0.01 ? '0 0 ' + Math.round(10 + 14 * pulse) + 'px ' + Math.round(2 + 4 * pulse) + 'px rgba(255,205,70,' + (a * (0.35 + 0.3 * pulse)).toFixed(3) + ')' : '';
    };
    function finish(open) {
      if (done) return;
      done = true; cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', finish, true); window.removeEventListener('keydown', finish, true);
      notes.forEach(function (n, i) { n.text = full[i]; });
      rings.forEach(function (r, i) { r.label.text = labelFull[i]; });
      man.text = MANIFESTO; blank.text = '';
      els = fin.slice(); fade = null;
      if (mg) { mg.style.transition = 'box-shadow .6s ease'; mg.style.boxShadow = ''; setTimeout(function () { mg.style.transition = ''; }, 700); }
      save(); draw();
      if (open === true) editNote(blank); /* a tap-skip leaves the editor closed so that tap can't discard the blank note */
    }
    window.addEventListener('pointerdown', finish, true); window.addEventListener('keydown', finish, true);
    (function frame(now) {
      if (done) return;
      var e = now - t0, vis = [], held = [];
      rings.forEach(function (r, i) {
        var lu = clamp01((e - i * STAG) / RING), nl = Math.floor(lu * labelFull[i].length);
        if (lu >= 1) vis.push(r.ring);
        if (nl > 0) { r.label.text = labelFull[i].slice(0, nl); vis.push(r.label); }
      });
      seq.forEach(function (s) {
        if (e < s.start) return;
        var a = clamp01((e - s.start) / s.rise);
        s.el.text = s.text.slice(0, Math.floor(Math.max(0, e - s.start - TYPE_AT) * CPS / 1000));
        if (a >= 1) vis.push(s.el); else held.push([s, easeOut(a)]);
      });
      els = vis;
      draw();
      rings.forEach(function (r, i) {
        var p = easeInOut(clamp01((e - i * STAG) / RING)), q = r.ring;
        if (p <= 0 || p >= 1) return;
        ctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, 0, 0);
        ctx.save(); ctx.lineWidth = elWidth(q); ctx.lineCap = 'round'; ctx.strokeStyle = '#000';
        ctx.beginPath(); ctx.ellipse(q.x + q.w / 2 - view.x, q.y + q.h / 2 - view.y, q.w / 2, q.h / 2, 0, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); ctx.stroke(); ctx.restore();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      });
      /* the landings: held out of els (unclickable) and painted over draw() with a soft rise + fade */
      held.forEach(function (h) {
        var el = h[0].el, oy = el.y;
        ctx.setTransform(dpr * view.z, 0, 0, dpr * view.z, 0, 0);
        ctx.save(); ctx.globalAlpha = h[1];
        el.y = oy + h[0].dist * (1 - h[1]); drawEl(ctx, el, view.x, view.y); el.y = oy;
        ctx.restore(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      });
      /* sparkle glow: eases in as the pair begins, pulses softly, eases out after it finishes */
      glow(easeInOut(clamp01((e - gStart) / 700)) * (1 - easeInOut(clamp01((e - gEnd) / GLOW_OUT))), 0.5 + 0.5 * Math.sin(e / 380));
      if (e >= tFin) finish(true); else raf = requestAnimationFrame(frame);
    })(performance.now());
  }
  /* sync integration surface (U4): the only door out of this IIFE. Null hooks
     mean "no sync" - sync.js fills them when the flag is on. */
  window.AIWB = {
    getEls: function () { return els; },
    setEls: function (v) { els = v; },
    draw: draw,
    loadEls: loadEls,
    save: save,
    clearUndo: function () { undoStack = []; syncUndo(); },
    afterSave: null, newId: null, adoptBoard: null
  };
  if (tplId) loadTemplate(tplId);
  else if (location.hash.indexOf('#board=') === 0) loadFromHash();
  else seedWelcome();
