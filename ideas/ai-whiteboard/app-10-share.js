'use strict';
/* THIS FILE IS FOR share-as-template, community publish, ?template= and invite links. Loaded after app-09-route.js, before app-11-embeds.js. Plain globals; no IIFE. */

  /* ---------- share: download the board as a template file ---------- */
  document.getElementById('share').addEventListener('click', function () {
    commitEdit();
    var blob = new Blob([JSON.stringify(els.filter(function (e) { return e.kind !== 'app'; }), null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'template.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  /* ---------- add to community templates: published straight to the Board Room ---------- */
  var cBtn = document.getElementById('community'), cScrim = document.getElementById('cscrim'), cDlg = document.getElementById('cdlg');
  var cForm = document.getElementById('cForm'), cMsg = document.getElementById('cMsg');
  var cFields = [['cName', 'cNameN', 60], ['cWhy', 'cWhyN', 400], ['cLove', 'cLoveN', 400], ['cAuthor', 'cAuthorN', 40], ['cX', 'cXN', 16]].map(function (a) {
    return { el: document.getElementById(a[0]), n: document.getElementById(a[1]), max: a[2] };
  });
  var EL_MAX = 120;
  function syncCommunity() { cBtn.hidden = !els.some(function (e) { return e.type !== 'embed' && !e.pending; }); }
  var drawBase = draw;
  draw = function () { drawBase(); syncCommunity(); };
  function cHint(f) {
    var left = f.max - f.el.value.length;
    f.n.textContent = left <= Math.ceil(f.max * 0.15) ? left + ' left' : '';
  }
  cFields.forEach(function (f) { f.el.addEventListener('input', function () { cHint(f); cDraft = cFields.map(function (g) { return g.el.value; }); }); });
  var cXErr = document.getElementById('cXErr'), X_RE = /^[A-Za-z0-9_]{1,15}$/;
  function normX(v) {
    v = String(v || '').trim();
    var m = /^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/(.*)$/i.exec(v);
    if (m) {
      var segs = m[1].split(/[?#]/)[0].split('/').filter(Boolean);
      v = segs.length ? segs[segs.length - 1] : '';
    }
    return v.replace(/^@/, '').trim();
  }
  cFields[4].el.addEventListener('input', function () { cXErr.hidden = true; });
  cFields[4].el.addEventListener('paste', function (e) {
    var t = e.clipboardData && e.clipboardData.getData('text');
    if (!t || !/\.com\//i.test(t)) return;
    e.preventDefault();
    cFields[4].el.value = normX(t).slice(0, 16);
    cFields[4].el.dispatchEvent(new Event('input'));
  });
  function openCommunity() {
    commitEdit(); save();
    cOpen = true;
    cFields.forEach(function (f, i) { f.el.value = cDraft ? cDraft[i] : ''; cHint(f); });
    cMsg.textContent = ''; document.getElementById('cSubmit').disabled = false;
    cScrim.hidden = false; dock.inert = true;
    cFields[0].el.focus();
  }
  function closeCommunity() {
    if (!cOpen) return;
    cOpen = false; cScrim.hidden = true; dock.inert = false; cDraft = null;
    cFields.forEach(function (f) { f.el.value = ''; f.n.textContent = ''; });
    cMsg.textContent = ''; cXErr.hidden = true;
    (cBtn.hidden ? magic : cBtn).focus();
  }
  function b64url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function encodePayload(payload) {
    var bytes = new TextEncoder().encode(JSON.stringify(payload));
    if (typeof CompressionStream === 'function') {
      try {
        var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (err) { /* keep plain JSON bytes */ }
    }
    return b64url(bytes);
  }
  function snapshot(tight) {
    var out = JSON.parse(ser(els))
      .filter(function (e) { return e && e.type !== 'embed' && e.kind !== 'app' && !e.pending && (e.type !== 'image' || isHttps(e.url)); })
      .slice(0, EL_MAX);
    if (tight) {
      var r = function (v) { return typeof v === 'number' ? Math.round(v) : v; };
      out.forEach(function (e) {
        ['x', 'y', 'w', 'h', 'x2', 'y2', 'size'].forEach(function (k) { if (k in e) e[k] = r(e[k]); });
        if (Array.isArray(e.pts)) e.pts = e.pts.map(function (p) { return Array.isArray(p) ? p.map(r) : p; });
        delete e.id;
      });
    }
    return out;
  }
  cBtn.addEventListener('click', openCommunity);
  document.getElementById('cClose').addEventListener('click', closeCommunity);
  cScrim.addEventListener('pointerdown', function (e) { if (e.target === cScrim) closeCommunity(); });
  cDlg.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCommunity(); return; }
    if (e.key !== 'Tab') return;
    var list = Array.prototype.filter.call(cDlg.querySelectorAll('button, input, textarea'), function (n) { return !n.disabled && n.offsetParent !== null; });
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || !cDlg.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !cDlg.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  });
  document.addEventListener('keydown', function (e) { if (cOpen && e.key === 'Escape') closeCommunity(); }, true);
  cForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var f = {
      title: cFields[0].el.value.trim().slice(0, 60), why: cFields[1].el.value.trim().slice(0, 400),
      love: cFields[2].el.value.trim().slice(0, 400), author: cFields[3].el.value.trim().slice(0, 40),
      x: normX(cFields[4].el.value)
    };
    if (!f.title || !f.why || !f.love) {
      cMsg.textContent = 'Please fill in the name and both questions.';
      (!f.title ? cFields[0] : !f.why ? cFields[1] : cFields[2]).el.focus();
      return;
    }
    if (f.x && !X_RE.test(f.x)) { cXErr.hidden = false; cFields[4].el.focus(); return; }
    cXErr.hidden = true;
    var btn = document.getElementById('cSubmit');
    btn.disabled = true; cMsg.textContent = '';
    var res = null;
    try {
      res = window.AIWB_TEMPLATES ? await AIWB_TEMPLATES.submit({ title: f.title, why: f.why, love: f.love, author: f.author, x: f.x, elements: snapshot(true) }) : null;
    } catch (err) { res = null; }
    if (res && res.ok) { location.href = '../templates/?published=' + encodeURIComponent(res.slug); return; }
    /* the draft stays in the form; say what happened and bring the button back */
    if (!cOpen) return;
    btn.disabled = false;
    cMsg.textContent = res && res.error === 'rejected' ? 'The gallery turned that down. Check the fields and try again.'
      : res && res.error === 'empty' ? 'Add something to the board first.'
      : res && res.error === 'busy' ? 'Lots of people are sharing right now. Your answers are still here. Try again in a minute.'
      : 'Could not reach the gallery. Your answers are still here. Try again in a moment.';
  });
  syncCommunity();

  /* ---------- ?template=<id>: start from a template ---------- */
  function loadTemplate(id) {
    (id === 'pending' ? Promise.resolve().then(function () {
      var raw = sessionStorage.getItem('aiwb.pendingTemplate');
      sessionStorage.removeItem('aiwb.pendingTemplate');
      return raw ? JSON.parse(raw) : null;
    }) : (window.AIWB_TEMPLATES ? AIWB_TEMPLATES.loadPayload(id) : Promise.resolve(null)).then(function (dbPayload) {
      return dbPayload || fetch('../templates/templates.json').then(function (r) { return r.json(); }).then(function (list) {
        var t = (Array.isArray(list) ? list : []).filter(function (x) { return x && x.id === id && typeof x.file === 'string' && /^[\w.-]+\.json$/.test(x.file); })[0];
        if (!t) return null;
        return fetch('../templates/' + t.file).then(function (r) { return r.json(); });
      });
    })).then(function (tpl) {
      if (!Array.isArray(tpl)) return;
      tpl = loadEls(tpl);
      if (!tpl.length) return;
      if (els.length) lsSet(KEY_SCENE + '.prev.' + Date.now(), JSON.stringify(els));
      adoptBoard(tpl);
    }).catch(function () {});
    if (window.history && history.replaceState) history.replaceState(null, '', location.pathname);
  }
  function adoptBoard(tpl) {
    if (window.AIWB && AIWB.adoptBoard && AIWB.adoptBoard(tpl)) return; /* synced: merge by id instead of replacing */
    {
      els = tpl; selId = null; nextId = 1; undoStack = []; syncUndo();
      els.forEach(function (e) { var n = parseInt(String(e.id).replace(/\D/g, ''), 10); if (n >= nextId) nextId = n + 1; });
      els.forEach(function (e) { if (!e.id) e.id = newId(); });
      var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      els.forEach(function (e) { var b = bbox(e); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
      /* keep the whole template in sight: 24px margins, 110px at the bottom for the toolbar; wider than the view -> left edge at 24px */
      var vz = view.z, vw = W / vz, vh = H / vz;
      var vx = (x1 - x0) > vw - 48 / vz ? x0 - 24 / vz : (x0 + x1) / 2 - vw / 2;
      var vy = (y0 + y1) / 2 - (24 / vz + (vh - 134 / vz) / 2);
      view = { x: Math.round(vx), y: Math.round(vy), z: vz };
      save(); saveView(); draw();
    }
  }

  /* ---------- invite a friend: the board travels in the URL hash, nothing is sent anywhere ---------- */
  var invBtn = document.getElementById('invite'), iPop = document.getElementById('ipop'), iMsg = document.getElementById('iMsg');
  var iLink = document.getElementById('iLink'), iShare = document.getElementById('iShare'), iScrim = document.getElementById('iscrim');
  var LINK_MAX = 6000, HASH_MAX = 200000, inviteBusy = false, inviteUrl = '';
  function closePop() { iPop.hidden = true; iLink.hidden = true; iShare.hidden = true; }
  function showPop(msg, link, canShare) {
    iMsg.textContent = msg;
    iLink.hidden = !link; iShare.hidden = !canShare;
    if (link) iLink.value = link;
    iPop.hidden = false;
    if (link) { iLink.focus(); iLink.select(); }
  }
  async function buildInvite() {
    for (var pass = 0; pass < 2; pass++) {
      var link = location.origin + location.pathname + '#board=' + await encodePayload(snapshot(pass === 1));
      if (link.length <= LINK_MAX) return link;
    }
    return '';
  }
  invBtn.addEventListener('click', async function () {
    if (inviteBusy) return;
    commitEdit(); save();
    inviteBusy = true;
    var link = '';
    try { link = await buildInvite(); } catch (err) { link = ''; }
    inviteBusy = false;
    if (!link) { showPop('This board is too big for a link. Try fewer elements.'); return; }
    inviteUrl = link;
    if (navigator.share && window.matchMedia && matchMedia('(pointer: coarse)').matches) {
      showPop('Invite a friend. Anyone with the link opens this board.', '', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      showPop('Link copied. Anyone with it opens this board.');
    } catch (err) {
      showPop('Copy this link. Anyone with it opens this board.', link);
    }
  });
  iShare.addEventListener('click', function () {
    navigator.share({ url: inviteUrl }).then(closePop, function (err) {
      if (err && err.name === 'AbortError') return;
      showPop('Copy this link. Anyone with it opens this board.', inviteUrl);
    });
  });
  document.getElementById('iClose').addEventListener('click', function () { closePop(); invBtn.focus(); });
  iPop.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closePop(); invBtn.focus(); } });

  function b64urlBytes(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function decodeBoard(enc) {
    if (!enc || enc.length > HASH_MAX || /[^A-Za-z0-9_-]/.test(enc)) return null;
    var bytes = b64urlBytes(enc);
    if (bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream !== 'function') return null;
      var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    var list = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(list)) return null;
    list = loadEls(list.slice(0, EL_MAX));
    return list.length ? list : null;
  }
  function askOpenFriend() {
    return new Promise(function (resolve) {
      var open = document.getElementById('iOpen'), keep = document.getElementById('iKeep');
      function done(v) {
        iScrim.hidden = true; dock.inert = false;
        document.removeEventListener('keydown', onKey, true);
        resolve(v);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
        else if (e.key === 'Tab') {
          e.preventDefault();
          (document.activeElement === open ? keep : open).focus();
        }
      }
      open.onclick = function () { done(true); };
      keep.onclick = function () { done(false); };
      document.addEventListener('keydown', onKey, true);
      iScrim.hidden = false; dock.inert = true;
      open.focus();
    });
  }
  async function loadFromHash() {
    var h = location.hash;
    if (h.indexOf('#board=') !== 0) return;
    var enc = h.slice(7);
    if (window.history && history.replaceState) history.replaceState(null, '', location.pathname + location.search);
    var list = null;
    try { list = await decodeBoard(enc); } catch (err) { list = null; }
    if (!list) return;
    if (els.length) {
      if (!(await askOpenFriend())) return;
      lsSet('aiwb.backup.' + Date.now(), JSON.stringify(els));
    }
    adoptBoard(list);
  }

