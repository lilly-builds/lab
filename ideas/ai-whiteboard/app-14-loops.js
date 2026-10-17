'use strict';
/* THIS FILE IS FOR the additive Dream and Want loops (delete this file and its tag to remove them). Loaded after app-13-make-it-real.js, before app-15-boot.js. Plain globals; no IIFE. */

  /* DREAM-LOOP-BEGIN (additive: a note landing in the Dream circle gets one offer to plan it; delete this block to revert) */
  /* the provisional product defaults, one place to swap each */
  var DREAM_DEFAULTS = { personality: 'voice' /* a voice from the board, no face */, planShape: 'notes' /* sticky notes beside the dream */ };
  var DREAM_COPY = {
    ask: 'Do you want to make a plan to make this dream real? Your team can get it started, then we can collaborate until it fits your flow.',
    busy: 'Your team is sketching a plan...', wall: 'Your team hit a wall.', next: "First step's on the board. Want me to make it real?"
  };
  var DREAM_SYSTEM = 'You help turn a dream into a small plan. Reply with JSON only, no prose: {"goal": string (max 12 words), "milestones": string[] (3 to 5 items, each max 10 words), "firstAction": string (max 10 words, one concrete thing to do today)}. Plain, warm, specific.';
  var dreamBox = null, dreamRaf = 0, dreamSnap = {}, dreamFocus = null;
  (function () {
    var st = document.createElement('style');
    st.textContent = '.dream-bubble{position:fixed;z-index:30;width:250px;box-sizing:border-box;padding:12px 14px;background:#fff;border:1.5px solid #1e1e1e;border-radius:14px 16px 13px 17px;font:14px/1.4 "Special Elite","Courier New",monospace;color:#1e1e1e;box-shadow:2px 3px 0 rgba(0,0,0,.12)}' +
      '.dream-bubble:before{content:"";position:absolute;left:-8px;top:18px;width:12px;height:12px;background:#fff;border-left:1.5px solid #1e1e1e;border-bottom:1.5px solid #1e1e1e;transform:rotate(45deg)}' +
      '.dream-bubble.flip:before{left:auto;right:-8px;transform:rotate(225deg)}' +
      '.dream-bubble p{margin:0 0 10px}.dream-bubble button{font:inherit;margin-right:8px;padding:4px 10px;background:#fff;border:1.5px solid #1e1e1e;border-radius:10px;cursor:pointer}' +
      '.dream-bubble button.go{background:#ffec99}';
    document.head.appendChild(st);
  })();
  /* the Dream circle: an ellipse whose top edge carries a "Dream" text label */
  function dreamCircle(label) {
    var best = null, bd = 1e9;
    els.forEach(function (t) {
      if (t.type !== 'text' || String(t.text || '').trim().toLowerCase() !== (label || 'dream')) return;
      var tb = bbox(t), cx = tb.x + tb.w / 2, cy = tb.y + tb.h / 2;
      els.forEach(function (c) {
        if (c.type !== 'ellipse' || !(c.w > 0) || !(c.h > 0)) return;
        if (cx < c.x || cx > c.x + c.w || Math.abs(cy - c.y) > c.h * 0.3) return;
        var d = Math.abs(cy - c.y) + Math.abs(cx - (c.x + c.w / 2));
        if (d < bd) { bd = d; best = c; }
      });
    });
    return best;
  }
  function inDream(n, label) {
    var c = dreamCircle(label);
    if (!c) return false;
    var dx = (n.x + n.w / 2 - (c.x + c.w / 2)) / (c.w / 2), dy = (n.y + n.h / 2 - (c.y + c.h / 2)) / (c.h / 2);
    return dx * dx + dy * dy <= 1;
  }
  function dreamClose() { if (dreamBox) { dreamBox.remove(); dreamBox = null; } cancelAnimationFrame(dreamRaf); }
  function dreamPlace(el) {
    if (!dreamBox) return;
    var r = toScreen(el.x + el.w, el.y), l = toScreen(el.x, el.y), bw = dreamBox.offsetWidth, bh = dreamBox.offsetHeight;
    var flip = r.x + 14 + bw > W - 8 && l.x - 14 - bw > 8;
    dreamBox.classList.toggle('flip', flip);
    dreamBox.style.left = Math.max(8, Math.min(W - bw - 8, flip ? l.x - 14 - bw : r.x + 14)) + 'px';
    dreamBox.style.top = Math.max(8, Math.min(H - bh - 8, r.y)) + 'px';
    dreamRaf = requestAnimationFrame(function () { dreamPlace(el); });
  }
  /* one bubble at a time; buttons is [[label, handler, primary]] */
  function dreamBubble(el, text, buttons) {
    dreamClose();
    dreamBox = document.createElement('div');
    dreamBox.className = 'dream-bubble';
    dreamBox.setAttribute('role', 'status');
    var p = document.createElement('p'); p.textContent = text; dreamBox.appendChild(p);
    (buttons || []).forEach(function (b) {
      var bt = document.createElement('button'); bt.type = 'button'; bt.textContent = b[0]; if (b[2]) bt.className = 'go';
      bt.addEventListener('click', b[1]); dreamBox.appendChild(bt);
    });
    if (!buttons || !buttons.length) p.style.margin = '0';
    document.body.appendChild(dreamBox);
    dreamPlace(el);
  }
  function dreamOffer(el) {
    el.dreamAsked = true; save();
    dreamBubble(el, DREAM_COPY.ask, [['Make a plan', function () { dreamPlan(el, 0); }, true], ['Not now', dreamClose]]);
  }
  async function dreamPlan(el, tries) {
    var key = getKey(PROVIDER);
    if (!key) { openModal({ opener: magic, resume: true }); return; }
    dreamBubble(el, DREAM_COPY.busy);
    var box = dreamBox, ac = new AbortController(), timer = setTimeout(function () { ac.abort(); }, 25000);
    try {
      var reply = await providers[PROVIDER].complete({ system: DREAM_SYSTEM, text: 'Dream: ' + String(el.text || '').slice(0, 600), model: modelFor('fast'), key: key, signal: ac.signal, maxTokens: 400,
        job: 'plan', ask: String(el.text || '').slice(0, 600) });
      var o = parseReply(reply), ms = o && Array.isArray(o.milestones) ? o.milestones.filter(function (m) { return typeof m === 'string' && m.trim(); }).slice(0, 5) : [];
      if (!o || typeof o.goal !== 'string' || !o.goal.trim() || !ms.length || typeof o.firstAction !== 'string' || !o.firstAction.trim()) throw new Error('bad plan');
      if (dreamBox !== box) return; /* dismissed or replaced while thinking */
      dreamWrite(el, o.goal, ms, o.firstAction);
    } catch (err) {
      if (dreamBox !== box) return;
      if (err && (err.status === 401 || err.status === 403)) { dreamClose(); openModal({ opener: magic, resume: true, replace: true, message: "That key didn't work." }); return; }
      if (tries < 1) dreamBubble(el, DREAM_COPY.wall, [['Retry', function () { dreamPlan(el, tries + 1); }, true], ['Not now', dreamClose]]);
      else dreamClose();
    } finally { clearTimeout(timer); }
  }
  /* amber goal, green milestones in a column, blue first action; ordinary notes, one undo step */
  function dreamWrite(el, goal, ms, first) {
    if (DREAM_DEFAULTS.planShape !== 'notes') return;
    var mk = function (text, fill) { var n = { id: newId(), type: 'note', x: 0, y: 0, w: NOTE, h: NOTE, text: String(text).trim().slice(0, 120), fill: fill }; fitNote(n); return n; };
    var g = mk(goal, '#ffec99'), col = ms.map(function (m) { return mk(m, '#b2f2bb'); }), f = mk(first, '#bfd7ff');
    var colH = g.h + col.reduce(function (a, n) { return a + n.h + 12; }, 12), width = g.w + 16 + f.w;
    var others = els.filter(function (e) { return e.type !== 'ellipse' && e.type !== 'text' && e !== el; }).map(bbox);
    var x0 = el.x + el.w + 30, y0 = el.y;
    for (var k = 0; k < 8; k++) {
      var hit = others.some(function (b) { return x0 < b.x + b.w + 12 && x0 + width + 12 > b.x && y0 < b.y + b.h + 12 && y0 + colH + 12 > b.y; });
      if (!hit) break;
      x0 += 40; y0 += k % 2 ? 0 : 40;
    }
    g.x = x0; g.y = y0; f.x = x0 + g.w + 16; f.y = y0;
    var y = y0 + g.h + 12;
    col.forEach(function (n) { n.x = x0; n.y = y; y += n.h + 12; });
    snap();
    [g].concat(col, [f]).forEach(function (n) { els.push(n); });
    save(); draw();
    dreamBubble(f, DREAM_COPY.next, [['Make it real', function () { dreamClose(); ask.value = first.trim(); openPanel(); makeItReal(); }, true], ['Not now', dreamClose]]);
  }
  function dreamCheck(n) { if (n && n.type === 'note' && !n.dreamAsked && String(n.text || '').trim() && inDream(n)) dreamOffer(n); }
  /* fresh text: the note editor closed with different words than it opened with */
  ta.addEventListener('focus', function () { var n = els.filter(function (e) { return e.id === editing; })[0]; dreamFocus = n ? { id: n.id, text: n.text } : null; });
  ta.addEventListener('blur', function () {
    var f = dreamFocus; dreamFocus = null;
    var n = f && els.filter(function (e) { return e.id === f.id; })[0];
    if (n && n.text !== f.text) dreamCheck(n);
  });
  /* fresh placement: only notes already known at pointer-down that ended somewhere else (loads never trigger) */
  cv.addEventListener('pointerdown', function () { dreamSnap = {}; els.forEach(function (e) { if (e.type === 'note') dreamSnap[e.id] = e.x + ',' + e.y; }); });
  cv.addEventListener('pointerup', function () {
    els.forEach(function (e) { if (e.type === 'note' && dreamSnap[e.id] && dreamSnap[e.id] !== e.x + ',' + e.y) dreamCheck(e); });
    dreamSnap = {};
  });
  /* DREAM-LOOP-END */
  /* juice.js: which circle a note sits in; the completion call site is Juice.earn(note) */
  if (window.Juice) Juice.circleOf = function (n) { return inDream(n) ? 'dream' : inDream(n, 'want to do') ? 'want-to' : inDream(n, 'have to do') ? 'have-to' : null; };

  /* WANT-LOOP-BEGIN (additive: a note landing in the Want to do circle gets one playful team bubble; no AI, no key; delete this block to revert) */
  var WANT_DEFAULTS = { personality: 'voice' /* a voice from the board, no face */ };
  var WANT_COPY = ["Oooh tell me more. Let's make it happen.", "Ooh, I like this one. Say more!", "Yes! Let's go get this done.", "Now we're talking. What's the first move?", "Ooh, this has legs. Let's do it."];
  var wantSnap = {}, wantFocus = null;
  function wantCheck(n) {
    if (!n || n.type !== 'note' || n.wantAsked || !String(n.text || '').trim()) return;
    if (inDream(n) || !inDream(n, 'want to do')) return; /* dream wins an overlap */
    n.wantAsked = true; save();
    var last = -1;
    try { last = parseInt(localStorage.getItem('wb_want_last'), 10); } catch (e) {}
    var i = Math.floor(Math.random() * WANT_COPY.length);
    if (i === last) i = (i + 1) % WANT_COPY.length;
    try { localStorage.setItem('wb_want_last', String(i)); } catch (e) {}
    dreamBubble(n, WANT_COPY[i], [['Love it', dreamClose, true]]);
  }
  ta.addEventListener('focus', function () { var n = els.filter(function (e) { return e.id === editing; })[0]; wantFocus = n ? { id: n.id, text: n.text } : null; });
  ta.addEventListener('blur', function () {
    var f = wantFocus; wantFocus = null;
    var n = f && els.filter(function (e) { return e.id === f.id; })[0];
    if (n && n.text !== f.text) wantCheck(n);
  });
  cv.addEventListener('pointerdown', function () { wantSnap = {}; els.forEach(function (e) { if (e.type === 'note') wantSnap[e.id] = e.x + ',' + e.y; }); });
  cv.addEventListener('pointerup', function () {
    els.forEach(function (e) { if (e.type === 'note' && wantSnap[e.id] && wantSnap[e.id] !== e.x + ',' + e.y) wantCheck(e); });
    wantSnap = {};
  });
  /* WANT-LOOP-END */
