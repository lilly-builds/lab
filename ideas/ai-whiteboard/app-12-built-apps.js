'use strict';
/* THIS FILE IS FOR built-app frames, the whirlwind animation, app build, add image/embed. Loaded after app-11-embeds.js, before app-13-make-it-real.js. Plain globals; no IIFE. */

  /* ---------- app frames ---------- */
  var gens = {};
  var APP_FAIL = { timeout: 'No response.', storage: 'Storage is full. Remove an app and retry.', noprompt: 'This idea was not saved. Type it again.' };
  /* real elapsed time, nothing invented */
  function clock(s) { s = Math.max(0, Math.floor(s)); var r = s % 60; return Math.floor(s / 60) + ':' + (r < 10 ? '0' : '') + r; }
  function appStatus(g) {
    return (g.retrying ? 'Trying again ' : 'Building ') + clock((Date.now() - g.t0) / 1000);
  }
  /* a quiet beat: 4s visible, then a 400ms fade (none with reduced motion) */
  function showBuilt(id, secs) {
    var n = embedNodes[id]; if (!n) return;
    clearTimeout(n.builtT1); clearTimeout(n.builtT2);
    n.built.textContent = 'built in ' + clock(secs);
    n.built.classList.remove('out'); n.built.hidden = false;
    var rm = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    n.builtT1 = setTimeout(function () {
      if (rm) { n.built.hidden = true; return; }
      n.built.classList.add('out');
      n.builtT2 = setTimeout(function () { n.built.hidden = true; }, 400);
    }, 4000);
  }
  function hideBuilt(n) { clearTimeout(n.builtT1); clearTimeout(n.builtT2); n.built.hidden = true; }
  /* failInfo to plain language: { msg: the reason, sub: small text under it } */
  function failText(fi) {
    var lab = (providers[fi.provider] && providers[fi.provider].label) || 'The service', st = fi.status, k = fi.kind;
    var model = fi.model ? 'Model: ' + fi.model : '';
    if (k === 'timeout-idle') return { msg: 'No answer for 60 seconds, so I stopped. The model may be busy.', sub: model };
    if (k === 'timeout-cap') return { msg: 'This took longer than 5 minutes, so I stopped.', sub: model };
    if (k === 'network') return { msg: 'Could not reach ' + lab + '. A network or browser block.', sub: model };
    if (k === 'cut') return { msg: /max/i.test(fi.apiMessage) ? 'The answer was cut off at the length limit.' : 'The answer ended before it was finished.', sub: model };
    if (k === 'invalid') return { msg: 'The answer was not a usable app.', sub: model };
    var said = (fi.apiMessage ? lab + ' said: ' + fi.apiMessage.replace(/[.\s]+$/, '') : lab + ' refused the request') + (st ? ' (' + st + ').' : '.');
    var n = Number(st);
    if (n === 404) return { msg: said + ' The model name can be changed in the Connect manage view.', sub: model };
    if (n === 429) return { msg: 'Your key hit its rate limit (429). Try again in a minute.', sub: model };
    if (n >= 500) return { msg: lab + ' is busy right now (' + st + '). Try again in a minute.', sub: model };
    return { msg: said, sub: model };
  }
  function closePops() {
    Object.keys(embedNodes).forEach(function (id) { var n = embedNodes[id]; n.pop.hidden = true; n.more.setAttribute('aria-expanded', 'false'); });
  }
  document.addEventListener('pointerdown', function (e) { if (!e.target.closest || !e.target.closest('.epop, .emore')) closePops(); }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePops(); });
  function updateAppNode(n, el) {
    var gen = gens[el.id], pend = !!el.pending && !!gen;
    var fail = pend ? null : (el.failed || (el.pending ? 'error' : null));
    n.root.classList.toggle('sel', selId === el.id);
    n.root.classList.toggle('erasing', !!eraseIds[el.id]);
    n.root.classList.toggle('act', interactId === el.id && !pend && !fail);
    n.root.classList.remove('stall');
    if (n.title.textContent !== el.title) n.title.textContent = el.title;
    n.open.hidden = true; n.retry.hidden = true;
    n.stop.hidden = !pend;
    n.pend.style.display = pend ? '' : 'none';
    n.status.hidden = !pend;
    if (pend) { n.sawPending = true; n.status.textContent = appStatus(gen); hideBuilt(n); }
    var hasBuilt = typeof el.builtSecs === 'number';
    n.popBuilt.hidden = !hasBuilt;
    if (hasBuilt) n.popBuilt.textContent = 'Built in ' + clock(el.builtSecs);
    var code = null;
    if (!pend && !fail) {
      if (n.appId !== el.appId) { dropFrame(n); n.appId = el.appId; }
      if (!n.iframe) {
        code = lsGet(KEY_APP + el.appId);
        if (!code) { n.appId = null; fail = 'missing'; }
      }
    } else { dropFrame(n); n.appId = null; }
    n.cActs.hidden = !fail; n.cOpen.hidden = true;
    n.cRetry.hidden = fail === 'missing' || fail === 'noprompt';
    if (fail) {
      n.cName.textContent = el.title;
      var ft = el.failInfo && fail !== 'noprompt' && fail !== 'storage' ? failText(el.failInfo) : null;
      n.cMsg.textContent = fail === 'missing' ? "This app's code is not on this device." : ft ? 'Could not build this.' : (APP_FAIL[fail] || 'Could not build this.');
      n.cHint.textContent = ft ? ft.msg : ''; n.cHint.hidden = !ft; n.cHint.classList.toggle('why', !!ft);
      n.cWhy.textContent = ft ? ft.sub : ''; n.cWhy.hidden = !(ft && ft.sub);
      n.card.hidden = false;
    } else n.card.hidden = true;
    var ready = !pend && !fail;
    n.int.hidden = !(selId === el.id && ready);
    n.int.setAttribute('aria-pressed', String(interactId === el.id));
    n.more.hidden = !ready;
    if (!ready) { n.pop.hidden = true; n.more.setAttribute('aria-expanded', 'false'); }
    n.pubOpen.hidden = !(ready && el.pubLive && el.publishedUrl);
    if (!n.pubOpen.hidden && n.pubOpen.getAttribute('href') !== el.publishedUrl) n.pubOpen.setAttribute('href', el.publishedUrl);
    if (ready && !n.iframe && code) {
      var f = document.createElement('iframe');
      /* generated code is arbitrary: scripts and forms only, an opaque origin, no popups, no navigation, no downloads */
      f.setAttribute('sandbox', 'allow-scripts allow-forms');
      f.setAttribute('referrerpolicy', 'no-referrer'); f.setAttribute('loading', 'lazy');
      f.setAttribute('title', el.title);
      if (n.sawPending) {
        f.className = 'fade'; n.sawPending = false;
        requestAnimationFrame(function () { requestAnimationFrame(function () { f.classList.remove('fade'); }); });
      }
      f.srcdoc = appDoc(code);
      n.hint.hidden = false; flashHint(n);
      n.iframe = f; n.body.insertBefore(f, n.pend);
    }
  }
  /* render-time only: lets a clipped generated page scroll, and takes wheel input relayed from the board */
  var APP_FIX = '<style>html{overflow-y:auto!important;height:auto!important;min-height:100%}body{overflow-y:auto!important;height:auto!important;min-height:100%}</style>' +
    '<script>addEventListener("message",function(e){var d=e.data;if(!d||d.eWheel!==1)return;var t=document.elementFromPoint(d.x,d.y);while(t&&t!==document.documentElement){var o=getComputedStyle(t).overflowY;if((o==="auto"||o==="scroll")&&t.scrollHeight>t.clientHeight&&t!==document.body){t.scrollBy(d.dx,d.dy);return}t=t.parentElement}scrollBy(d.dx,d.dy)});<\/script>';
  function appDoc(code) {
    try {
      var m = /<\/head\s*>/i.exec(code);
      if (m) return code.slice(0, m.index) + APP_FIX + code.slice(m.index);
      m = /<html[^>]*>/i.exec(code);
      if (m) return code.slice(0, m.index + m[0].length) + APP_FIX + code.slice(m.index + m[0].length);
      return APP_FIX + code;
    } catch (e) { return code; }
  }
  function appKeys() {
    var out = [];
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(KEY_APP) === 0) out.push(k); } } catch (e) {}
    return out;
  }
  /* an entry stays while the scene or any undo snapshot can still bring its frame back */
  function gcApps() {
    var seen = JSON.stringify(els) + undoStack.join('');
    appKeys().forEach(function (k) { if (seen.indexOf('"' + k.slice(KEY_APP.length) + '"') < 0) lsDel(k); });
  }
  function storeApp(appId, html) {
    if (html.length > APP_MAX_CHARS) return false;
    gcApps();
    var k = KEY_APP + appId, keys = appKeys();
    if (keys.indexOf(k) < 0 && keys.length >= APP_MAX_COUNT) return false;
    try { localStorage.setItem(k, html); return localStorage.getItem(k) === html; } catch (e) { return false; }
  }
  function newAppId() {
    var b = new Uint8Array(8), s = '';
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b); else for (var i = 0; i < 8; i++) b[i] = Math.floor(Math.random() * 256);
    for (var j = 0; j < 8; j++) s += (b[j] % 36).toString(36);
    return 'app-' + s;
  }
  function firstWords(t) { return t.replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ').slice(0, 60) || 'App'; }
  function settle(el, code) { if (code) el.failed = code; else delete el.failed; delete el.pending; delete el.since; save(); draw(); }

  /* ---------- the whirlwind: a paper storm that assembles the app while it builds ---------- */
  /* whirlwind:start */
  /* pure: advances storm pieces in place. dt and t in ms, w and h the frame size. no allocation. */
  function stormStep(pieces, dt, w, h, t) {
    var cx = w / 2 + Math.sin(t * 0.00031) * w * 0.07, cy = h / 2 + Math.cos(t * 0.00023) * h * 0.07;
    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i];
      if (!p.alive) continue;
      p.a += p.av * dt;
      p.rot = p.rot0 + Math.sin(t * p.rv + p.ph) * 0.4;
      var k = dt * p.ease; p.m += (p.tm - p.m) * (k > 1 ? 1 : k);
      var rr = p.r * (1 + 0.08 * Math.sin(t * 0.0011 + p.ph)) * p.m;
      p.x = cx + Math.cos(p.a) * rr * w * 0.5;
      p.y = cy + Math.sin(p.a) * rr * h * 0.5;
    }
  }
  /* pure: how many skeleton pieces the partial reply has earned (structural tags opened, at most 14) */
  function lockCount(text) {
    var re = /<(?:header|nav|main|section|button|input|li|h[1-3]|form|canvas|table)(?=[\s>\/])/gi, s = String(text || ''), n = 0;
    while (n < 14 && re.exec(s)) n++;
    return n;
  }
  /* whirlwind:end */

  var whirl = (function () {
    var W = {}, list = [], raf = 0, last = 0, listening = false, MAXSTORM = 3, MAXLOCK = 14;
    var DASH = [3, 3], NODASH = [];
    /* abstract skeleton in percent of the frame: x, y, w, h, kind (0 box, 1 circle) */
    var SKEL = [[4,4,92,10,0],[4,18,46,8,0],[70,18,26,8,0],[4,30,44,26,0],[52,30,44,26,0],[4,60,92,7,0],[4,70,92,7,0],[4,80,92,7,0],[4,91,60,6,0],[68,91,28,6,0],[54,18,12,8,1],[8,34,24,4,0],[56,34,24,4,0],[8,42,36,4,0]];
    function reduced() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }
    function cssVar(n, d) { var v = ''; try { v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); } catch (e) {} return v || d; }
    function rnd(a, b) { return a + Math.random() * (b - a); }

    function size(s) {
      var b = s.n.body, w = Math.max(60, (b.clientWidth || 0) - 16), h = Math.max(60, (b.clientHeight || 0) - 16);
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      s.w = w; s.h = h; s.c.width = Math.round(w * dpr); s.c.height = Math.round(h * dpr);
      s.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      s.u = Math.min(w, h) / 10;
      s.ctx.font = '300 ' + Math.max(9, Math.min(13, Math.round(Math.min(w, h) / 20))) + 'px ' + s.font;
      for (var i = 0; i < s.pieces.length; i++) { var p = s.pieces[i]; if (p.word) p.tw = s.ctx.measureText(p.word).width; }
      if (s.rm) draw(s, performance.now());
    }
    function build(s, words) {
      var P = s.pieces, i;
      function add(kind, word) {
        P.push({ kind: kind, word: word || '', tw: 0, alive: true, a: rnd(0, 6.283), av: 0, r: 0, ph: rnd(0, 6.283), rot0: rnd(-0.4, 0.4), rot: 0, rv: rnd(0.0008, 0.0018), m: 0, tm: 1, ease: 0.006, x: 0, y: 0, sz: rnd(0.8, 1.2) });
      }
      for (i = 0; i < words.length; i++) add(i % 2 ? 1 : 0, words[i]);
      for (i = 2; i <= 5; i++) add(i);
      for (i = Math.max(2, 14 - P.length); i > 0; i--) add(6);
      for (i = 0; i < P.length; i++) {
        P[i].r = 0.2 + 0.75 * ((i * 0.618) % 1);
        P[i].av = (0.0009 + 0.0011 * (1 - P[i].r)) * (i % 5 === 4 ? -1 : 1);
      }
    }
    function dust(s, x, y, now) {
      var n = 3 + ((Math.random() * 3) | 0), D = s.dust;
      for (var i = 0; i < D.length && n > 0; i++) {
        var d = D[i]; if (d.t0 && now - d.t0 < 420) continue;
        d.t0 = now; d.x = x; d.y = y; d.vx = rnd(-0.05, 0.05); d.vy = rnd(-0.06, 0.02); n--;
      }
    }
    function lockOne(s, now, big) {
      if (s.locked >= MAXLOCK) return;
      var i = s.locked++, b = SKEL[i];
      s.lt[i] = now; s.big[i] = big ? 1 : 0;
      if (s.mode === 'storm') for (var j = s.pieces.length - 1; j >= 0; j--) if (s.pieces[j].alive) { s.pieces[j].alive = false; break; }
      if (!s.rm) dust(s, (b[0] + b[2] / 2) / 100 * s.w, (b[1] + b[3] / 2) / 100 * s.h, now);
    }

    function shape(ctx, p, u, ink, paper) {
      var k = p.kind, q = u * p.sz;
      ctx.strokeStyle = ink; ctx.lineWidth = 1;
      if (k < 2) {
        var w = p.tw + 8, h = u * 0.9;
        if (k === 1) { ctx.fillStyle = paper; ctx.fillRect(-w / 2, -h / 2, w, h); ctx.setLineDash(NODASH); ctx.strokeRect(-w / 2 + .5, -h / 2 + .5, w - 1, h - 1); }
        ctx.fillStyle = ink; ctx.fillText(p.word, 0, 1);
        return;
      }
      ctx.setLineDash(k === 6 ? NODASH : DASH);
      if (k === 2) ctx.strokeRect(-q, -q * 0.6, q * 2, q * 1.2);
      else if (k === 3) { ctx.beginPath(); ctx.arc(0, 0, q * 0.8, 0, 6.283); ctx.stroke(); }
      else if (k === 4) { ctx.beginPath(); for (var i = -1; i <= 1; i++) { ctx.moveTo(-q, i * q * 0.35); ctx.lineTo(q, i * q * 0.35); } ctx.stroke(); }
      else if (k === 5) ctx.strokeRect(-q * 0.9, -q * 0.4, q * 1.8, q * 0.8);
      else {
        ctx.fillStyle = paper; ctx.fillRect(-q * 0.8, -q * 0.5, q * 1.6, q);
        ctx.strokeRect(-q * 0.8 + .5, -q * 0.5 + .5, q * 1.6 - 1, q - 1);
        ctx.beginPath(); ctx.moveTo(-q * 0.6, -q * 0.15); ctx.lineTo(q * 0.6, -q * 0.15); ctx.moveTo(-q * 0.6, q * 0.15); ctx.lineTo(q * 0.2, q * 0.15); ctx.stroke();
      }
      ctx.setLineDash(NODASH);
    }

    function draw(s, now) {
      var ctx = s.ctx, i, el = 0, alpha = 1;
      ctx.clearRect(0, 0, s.w, s.h);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, s.w, s.h); ctx.clip();
      ctx.strokeStyle = s.ink; ctx.lineWidth = 1;
      /* skeleton: dashed and a touch large while settling (120ms), then a hard 1px outline */
      for (i = 0; i < s.locked; i++) {
        var b = SKEL[i], age = now - s.lt[i], soft = !s.rm && age < 120, sc = soft ? 1 + (s.big[i] ? 0.12 : 0.06) * (1 - age / 120) : 1;
        var bw = b[2] / 100 * s.w, bh = b[3] / 100 * s.h, x = b[0] / 100 * s.w - bw * (sc - 1) / 2, y = b[1] / 100 * s.h - bh * (sc - 1) / 2;
        bw *= sc; bh *= sc;
        ctx.setLineDash(soft ? DASH : NODASH);
        if (b[4]) { ctx.beginPath(); ctx.ellipse(x + bw / 2, y + bh / 2, bw / 2, bh / 2, 0, 0, 6.283); ctx.stroke(); }
        else ctx.strokeRect(Math.round(x) + .5, Math.round(y) + .5, Math.round(bw), Math.round(bh));
      }
      ctx.setLineDash(NODASH);
      if (!s.rm) {
        if (s.mode !== 'storm') { el = (now - s.modeT) / 300; if (s.mode === 'scatter') alpha = Math.max(0, 1 - el); }
        if (!(s.mode === 'land' && el >= 1)) {
          ctx.globalAlpha = alpha; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          for (i = 0; i < s.pieces.length; i++) {
            var p = s.pieces[i]; if (!p.alive) continue;
            ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
            if (s.mode === 'land') { var f = Math.max(0.05, p.m); ctx.scale(f, f); }
            shape(ctx, p, s.u, s.ink, s.paper);
            ctx.restore();
          }
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = s.ink;
        for (i = 0; i < s.dust.length; i++) {
          var d = s.dust[i], a = d.t0 ? (now - d.t0) / 420 : 1; if (a >= 1) continue;
          ctx.globalAlpha = 1 - a; ctx.fillRect(d.x + d.vx * (now - d.t0), d.y + d.vy * (now - d.t0), 2, 2);
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }

    function tick(ts) {
      raf = 0;
      if (document.hidden) { last = 0; return; }
      var any = false, dt = last ? Math.min(50, ts - last) : 16;
      last = ts;
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (!s.vis || s.rm) continue;
        any = true;
        if (s.locked < s.target && ts - s.lastLock >= 90) { s.lastLock = ts; lockOne(s, ts, false); }
        stormStep(s.pieces, dt, s.w, s.h, ts);
        draw(s, ts);
      }
      if (any) raf = requestAnimationFrame(tick); else last = 0;
    }
    function kick() { if (!raf && list.length && !document.hidden) raf = requestAnimationFrame(tick); }
    function onVis() { last = 0; kick(); }
    function destroy(id) {
      var s = W[id]; if (!s) return;
      clearTimeout(s.t1); clearInterval(s.pace);
      if (s.io) s.io.disconnect();
      if (s.ro) s.ro.disconnect();
      if (s.c.parentNode) s.c.parentNode.removeChild(s.c);
      var k = list.indexOf(s); if (k >= 0) list.splice(k, 1);
      delete W[id];
      var res = s.res; s.res = null; if (res) res();
      if (!list.length) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0; last = 0;
        if (listening) { document.removeEventListener('visibilitychange', onVis); listening = false; }
      }
    }
    /* lock pieces up to n (reduced motion: at once, still) */
    function setTarget(s, n) {
      if (n <= s.target) return;
      s.target = Math.min(n, MAXLOCK);
      if (s.rm) { while (s.locked < s.target) lockOne(s, 0, false); draw(s, 0); }
      else kick();
    }

    return {
      begin: function (id, n, el) {
        if (W[id] || !window.HTMLCanvasElement) return;
        var rm = reduced(), cnt = 0, i;
        for (i = 0; i < list.length; i++) if (!list[i].rm) cnt++;
        if (!rm && cnt >= MAXSTORM) return;
        var c = document.createElement('canvas'); c.className = 'ewhirl'; c.setAttribute('aria-hidden', 'true');
        var ctx = c.getContext('2d'); if (!ctx) return;
        n.body.insertBefore(c, n.status);
        var words = String(el.title || el.prompt || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 12).map(function (w) { return w.slice(0, 14); });
        var s = W[id] = { id: id, n: n, c: c, ctx: ctx, rm: rm, pieces: [], dust: [], lt: [], big: [], locked: 0, target: 0, lastLock: 0, mode: 'storm', modeT: 0, vis: true,
          ink: cssVar('--ink', '#000'), paper: cssVar('--paper', '#fff'), font: cssVar('--mono', '"Special Elite", "Courier New", monospace'), t1: 0, pace: 0, res: null, io: null, ro: null };
        for (i = 0; i < 40; i++) s.dust.push({ x: 0, y: 0, vx: 0, vy: 0, t0: 0 });
        if (!rm) build(s, words);
        size(s);
        list.push(s);
        if (rm) return;
        if (window.IntersectionObserver) { s.io = new IntersectionObserver(function (es) { s.vis = es[es.length - 1].isIntersecting; last = 0; kick(); }); s.io.observe(c); }
        if (window.ResizeObserver) { s.ro = new ResizeObserver(function () { size(s); }); s.ro.observe(n.body); }
        if (!listening) { document.addEventListener('visibilitychange', onVis); listening = true; }
        kick();
      },
      progress: function (id, count) { var s = W[id]; if (s) setTarget(s, count); },
      /* no stream: a lock about every 2s; the last piece is left for the landing */
      pace: function (id) {
        var s = W[id]; if (!s || s.pace) return;
        s.pace = setInterval(function () { if (s.target < MAXLOCK - 1) setTarget(s, s.target + 1); }, 2000);
      },
      /* the app is ready: pieces collapse to the centre, the rest of the skeleton snaps in */
      land: function (id) {
        var s = W[id]; if (!s) return Promise.resolve();
        clearInterval(s.pace);
        var now = performance.now();
        s.target = MAXLOCK;
        while (s.locked < MAXLOCK) lockOne(s, now, true);
        s.mode = 'land'; s.modeT = now;
        if (s.rm) { draw(s, now); return Promise.resolve(); }
        for (var i = 0; i < s.pieces.length; i++) { s.pieces[i].tm = 0; s.pieces[i].ease = 0.012; }
        kick();
        return new Promise(function (res) { s.res = res; s.t1 = setTimeout(function () { s.res = null; res(); }, 300); });
      },
      /* failure or Stop: everything flies outward and fades, then the canvas is gone */
      scatter: function (id) {
        var s = W[id]; if (!s) return Promise.resolve();
        clearInterval(s.pace);
        if (s.rm) { destroy(id); return Promise.resolve(); }
        s.mode = 'scatter'; s.modeT = performance.now();
        for (var i = 0; i < s.pieces.length; i++) { s.pieces[i].tm = 2.6; s.pieces[i].ease = 0.005; }
        kick();
        return new Promise(function (res) { s.res = res; s.t1 = setTimeout(function () { destroy(id); }, 300); });
      },
      /* the real frame is in place: fade the canvas out over it, then drop it */
      finish: function (id) {
        var s = W[id]; if (!s) return;
        if (s.rm || s.mode !== 'land') { destroy(id); return; }
        s.c.classList.add('out');
        clearTimeout(s.t1); s.t1 = setTimeout(function () { destroy(id); }, 270);
      },
      kill: destroy
    };
  })();

  async function startApp(id, undoLen) {
    var el = embedById(id);
    if (!el || el.kind !== 'app' || gens[id]) return;
    if (!el.prompt) { delete el.failInfo; settle(el, 'noprompt'); return; }
    var key = getKey(PROVIDER);
    if (!key) { openModal({ opener: magic }); return; }
    var prov = providers[PROVIDER], ac = new AbortController();
    var g = gens[id] = { ac: ac, timedOut: '', stopped: false, removed: false, retrying: false, t0: Date.now(), undoLen: undoLen };
    /* hard cap: 300s from the first attempt. idle: 60s with no stream data, re-armed on every chunk */
    g.timer = setTimeout(function () { g.timedOut = 'cap'; ac.abort(); }, 300000);
    g.armIdle = function () { clearTimeout(g.idle); g.idle = setTimeout(function () { g.timedOut = 'idle'; ac.abort(); }, 60000); };
    g.tick = setInterval(function () { var n = embedNodes[id]; if (n) n.status.textContent = appStatus(g); }, 1000);
    el.pending = true; delete el.failed; delete el.failInfo; delete el.builtSecs; el.since = Date.now();
    save(); draw();
    if (embedNodes[id]) whirl.begin(id, embedNodes[id], el);
    var idea = el.prompt, outcome = null, info = null, attempt = 1, model = modelFor(ROUTES.build.model);
    /* strings only, each clamped; never the key or the prompt */
    function scrub(t) { t = String(t || ''); if (key) t = t.split(key).join('[key]'); return t.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[key]').slice(0, 240); }
    function classify(e) {
      var kind = g.timedOut ? (g.timedOut === 'idle' ? 'timeout-idle' : 'timeout-cap') : e && e.kind ? e.kind : e instanceof TypeError ? 'network' : 'invalid';
      return { provider: scrub(PROVIDER), model: scrub(model), status: e && e.status ? String(e.status) : '', apiMessage: scrub(e && e.apiMessage), kind: kind };
    }
    function logFail(fi) { console.error('[makeItReal]', { provider: fi.provider, model: fi.model, status: fi.status, kind: fi.kind, apiMessage: fi.apiMessage, attempt: attempt, elapsedMs: Date.now() - g.t0 }); }
    function pause(ms) {
      return new Promise(function (res, rej) {
        if (ac.signal.aborted) { rej(new Error('aborted')); return; }
        var t = setTimeout(function () { ac.signal.removeEventListener('abort', h); res(); }, ms);
        function h() { clearTimeout(t); rej(new Error('aborted')); }
        ac.signal.addEventListener('abort', h, { once: true });
      });
    }
    try {
      /* job, ask and ticket are for the AI Magic Toolbox: the idea text is what the server checks the ticket against */
      var req = { system: SYSTEM_APP, text: idea, model: model, key: key, signal: ac.signal, maxTokens: 9000, plainText: true, onChunk: g.armIdle,
        job: 'build', ask: idea, ticket: buildTickets[id] || null };
      delete buildTickets[id];
      var reply = null, lastScan = 0;
      for (;;) {
        try {
          reply = null;
          if (prov.stream) {
            g.armIdle();
            try {
              /* the partial text is only counted for the skeleton, never rendered */
              reply = await prov.stream(req, function (text) {
                var now = Date.now(); if (now - lastScan < 100) return;
                lastScan = now; whirl.progress(id, lockCount(text));
              });
            } catch (se) {
              if (!(se && se.noStream) || ac.signal.aborted) throw se;
              reply = null;
            }
          }
          /* single-call fallback: no idle timer, only the 300s cap */
          if (reply === null) { clearTimeout(g.idle); whirl.pace(id); reply = await prov.complete(req); }
          clearTimeout(g.idle);
          break;
        } catch (ae) {
          clearTimeout(g.idle);
          if (g.removed || g.stopped) throw ae;
          info = classify(ae); logFail(info);
          var st = Number(info.status);
          var again = info.kind === 'network' || (info.kind === 'http' && [429, 500, 502, 503, 504, 529].indexOf(st) >= 0);
          /* final: the AI Magic Toolbox already made its second attempt on the server; another try here would be a third, paid ask */
          if (attempt > 1 || !again || ac.signal.aborted || (ae && ae.final)) throw ae;
          /* one retry of the same request; the storm keeps running */
          var ra = ae && ae.retryAfter > 0 ? Math.min(10, Math.max(2, ae.retryAfter)) : 2;
          g.retrying = true; lastScan = 0;
          await pause(ra * 1000);
          attempt++;
        }
      }
      if (ac.signal.aborted) throw new Error('aborted');
      var clean = cleanReply(reply);
      var out = clean ? sanitizeApp(clean, DOMParser) : null;
      if (!out || out.html.length > APP_MAX_CHARS) { info = classify(kindErr('invalid', 'Unusable reply')); logFail(info); outcome = 'error'; return; }
      var cur = embedById(id);
      if (!cur) return;
      if (!storeApp(cur.appId, out.html)) { outcome = 'storage'; return; }
      cur.title = out.title || firstWords(idea);
      outcome = 'ok';
      /* next moves for the new app: one cheap follow-up, shown under the ask box; its failure never touches the app */
      if (PROVIDER === 'toolbox') AIToolbox.nextMoves(key).then(showNext, function () {});
      await whirl.land(id);
    } catch (err) {
      if (g.removed) outcome = 'gone';
      else if (g.timedOut) { outcome = 'timeout'; info = classify(err); }
      else if (g.stopped) outcome = 'stopped';
      else if (err && (err.status === 401 || err.status === 403)) outcome = 'auth';
      else { outcome = 'error'; if (!info) { info = classify(err); logFail(info); } }
    } finally {
      clearTimeout(g.timer); clearTimeout(g.idle);
      if (outcome === 'gone') whirl.kill(id); else if (outcome !== 'ok') await whirl.scatter(id);
      clearInterval(g.tick); delete gens[id];
      var builtSecs = Math.max(0, Math.round((Date.now() - g.t0) / 1000));
      var f = embedById(id);
      if (f && outcome) {
        if (outcome === 'stopped' || outcome === 'auth') {
          els = els.filter(function (e) { return e.id !== id; });
          if (selId === id) selId = null;
          if (g.undoLen != null && undoStack.length === g.undoLen + 1) { undoStack.pop(); syncUndo(); }
          save(); draw();
          if (!ask.value.trim()) ask.value = idea;
          if (outcome === 'auth') openModal({ opener: magic, resume: true, real: true, replace: true, message: "That key didn't work." });
          else openPanel();
        } else if (outcome !== 'gone') {
          if ((outcome === 'error' || outcome === 'timeout') && info) f.failInfo = info; else delete f.failInfo;
          if (outcome === 'ok') f.builtSecs = builtSecs; else delete f.builtSecs;
          settle(f, outcome === 'ok' ? null : outcome);
          if (outcome === 'ok') showBuilt(id, builtSecs);
        }
      }
      whirl.finish(id);
    }
  }
  function addApp(idea) {
    var w = Math.max(200, Math.min(360, (W - 48) / view.z)), h = 420, sp = freeSpot(w, h);
    var el = cleanApp({ x: sp.x, y: sp.y, w: w, h: h, appId: newAppId(), title: firstWords(idea), prompt: idea });
    el.id = newId();
    var u = undoStack.length;
    snap(); els.push(el);
    setTool('move'); selId = el.id;
    save(); draw();
    return { el: el, undoLen: u };
  }
  function publishApp(el) {
    /* the old flow, unchanged: a prefilled GitHub issue and the Pages watcher; the local app stays as it is */
    var slug = makeSlug(el.prompt || el.title);
    el.publishedUrl = PAGES + 'ideas/' + slug + '/';
    delete el.pubLive; el.pubPending = true; el.pubSince = Date.now();
    save(); draw();
    window.open(issueUrl(el.prompt || el.title, slug), '_blank', 'noopener');
    pollTick();
  }

  function syncEmbeds() {
    selEl();
    if (interactId && interactId !== selId) interactId = null;
    var seen = {};
    els.forEach(function (el) {
      if (el.type !== 'embed') return;
      seen[el.id] = true;
      var n = embedNodes[el.id] || (embedNodes[el.id] = makeEmbedNode(el));
      updateEmbedNode(n, el);
    });
    Object.keys(embedNodes).forEach(function (id) {
      if (seen[id]) return;
      if (gens[id]) { gens[id].removed = true; gens[id].ac.abort(); }
      whirl.kill(id); dropFrame(embedNodes[id]); embedNodes[id].root.remove(); delete embedNodes[id];
    });
  }

  /* a direct image link becomes a bare picture: load it first, then size it to fit 480px without upscaling */
  function addImage(url) {
    loadImage(url, function (c) {
      if (!c) { showErr('That image could not be loaded.'); return; }
      var k = Math.min(1, 480 / Math.max(c.w, c.h)), w = Math.max(1, Math.round(c.w * k)), h = Math.max(1, Math.round(c.h * k)), sp = freeSpot(w, h);
      var el = { id: newId(), type: 'image', x: sp.x, y: sp.y, w: w, h: h, url: url };
      snap(); els.push(el);
      setTool('move'); selId = el.id;
      save(); draw();
    });
  }
  function addEmbed(o) {
    if (embedCount() >= EMB_MAX) { showErr('Six frames at most. Close one first.'); return null; }
    var w = Math.max(200, Math.min(360, (W - 48) / view.z)), h = 260, sp = freeSpot(w, h);
    var el = cleanEmbed({ x: sp.x, y: sp.y, w: w, h: h, url: o.url, title: o.title, pending: o.pending });
    if (!el) return null;
    el.id = newId();
    snap(); els.push(el);
    setTool('move'); selId = el.id;
    save(); draw();
    return el;
  }

  /* embed tool + paste */
  function openEmbedPanel(v) {
    commitEdit();
    panel.classList.remove('open'); magic.setAttribute('aria-expanded', 'false');
    xpanel.classList.add('open'); embedBtn.setAttribute('aria-expanded', 'true');
    xurl.value = v || ''; xurl.focus();
  }
  embedBtn.addEventListener('click', function () {
    if (xpanel.classList.contains('open')) closePanel(); else openEmbedPanel('');
  });
  xpanel.addEventListener('submit', function (e) {
    e.preventDefault();
    var raw = xurl.value.trim();
    if (!raw) return;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = 'https://' + raw;
    var u = cleanUrl(raw);
    if (!u) { showErr('Use an https link'); return; }
    if (isImageUrl(u)) { addImage(u); xurl.value = ''; closePanel(); return; }
    if (addEmbed({ url: u })) { xurl.value = ''; closePanel(); }
  });
  document.addEventListener('paste', function (e) {
    if (modalOpen || editing) return;
    var a = document.activeElement, tag = a && a.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    var t = ((e.clipboardData && e.clipboardData.getData('text')) || '').trim();
    if (!t || /\s/.test(t) || !/^https:\/\//i.test(t) || !cleanUrl(t)) return;
    e.preventDefault();
    if (isImageUrl(cleanUrl(t))) { addImage(cleanUrl(t)); return; }
    openEmbedPanel(cleanUrl(t));
  });

