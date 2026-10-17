'use strict';
/* THIS FILE IS FOR link-to-embed translation and embed frames. Loaded after app-10-share.js, before app-12-built-apps.js. Plain globals; no IIFE. */

  /* ---------- embedFor: translate known links to their embeddable form (render time only; elements keep the original url) ---------- */
  /* embedFor:start */
  var NO_EMBED = {
    'pinterest.com': 'Pinterest', 'pin.it': 'Pinterest', 'instagram.com': 'Instagram', 'facebook.com': 'Facebook', 'fb.com': 'Facebook',
    'linkedin.com': 'LinkedIn', 'x.com': 'X', 'twitter.com': 'X', 'reddit.com': 'Reddit', 'tiktok.com': 'TikTok', 'amazon.com': 'Amazon',
    'netflix.com': 'Netflix', 'github.com': 'GitHub', 'notion.so': 'Notion', 'docs.google.com': 'Google Docs', 'drive.google.com': 'Google Docs'
  };
  function noEmbedName(host) {
    for (var h = host; h; ) {
      if (Object.prototype.hasOwnProperty.call(NO_EMBED, h)) return NO_EMBED[h];
      var i = h.indexOf('.'); if (i < 0) break; h = h.slice(i + 1);
    }
    return '';
  }
  function embedFor(raw) {
    var out = { src: raw, provider: '', name: '', framable: true }, u;
    try { u = new URL(String(raw)); } catch (e) { return out; }
    if (u.protocol !== 'https:') return out;
    var host = u.hostname.toLowerCase(), bare = host.replace(/^www\./, ''), path = u.pathname, m, q = u.searchParams;
    function hit(provider, name, src) { out.src = src; out.provider = provider; out.name = name; return out; }
    if (bare === 'youtube.com' || host === 'm.youtube.com' || bare === 'youtu.be') {
      var id = '', list = '', ID = /^[A-Za-z0-9_-]{6,15}$/;
      if (bare === 'youtu.be') { m = /^\/([^/]+)\/?$/.exec(path); if (m) id = m[1]; }
      else if (path === '/watch') { id = q.get('v') || ''; list = q.get('list') || ''; }
      else if ((m = /^\/(?:shorts|live)\/([^/]+)\/?$/.exec(path))) id = m[1];
      else if (path === '/playlist') list = q.get('list') || '';
      if (id && ID.test(id)) {
        var t = q.get('t') || q.get('start') || '', secs = 0, tm;
        if (/^\d{1,6}s?$/.test(t)) secs = parseInt(t, 10);
        else if (t && (tm = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/.exec(t))) secs = (+tm[1] || 0) * 3600 + (+tm[2] || 0) * 60 + (+tm[3] || 0);
        return hit('youtube', 'YouTube', 'https://www.youtube-nocookie.com/embed/' + id + (secs > 0 ? '?start=' + secs : ''));
      }
      if (!id && /^[A-Za-z0-9_-]{10,60}$/.test(list)) return hit('youtube', 'YouTube', 'https://www.youtube-nocookie.com/embed/videoseries?list=' + list);
    } else if (bare === 'vimeo.com') {
      m = /^\/(?:channels\/[^/]+\/)?(\d{1,12})\/?$/.exec(path);
      if (m) return hit('vimeo', 'Vimeo', 'https://player.vimeo.com/video/' + m[1]);
    } else if (host === 'open.spotify.com') {
      m = /^\/(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{10,30})\/?$/.exec(path);
      if (m) return hit('spotify', 'Spotify', 'https://open.spotify.com/embed/' + m[1] + '/' + m[2]);
    } else if (bare === 'google.com' && (path === '/maps' || path.indexOf('/maps/') === 0)) {
      var mq = '', dec = function (x) { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch (e) { return ''; } };
      if (path === '/maps' || path === '/maps/') mq = q.get('q') || '';
      else if ((m = /^\/maps\/(?:place|search)\/([^/]+)/.exec(path))) mq = dec(m[1]);
      else if ((m = /^\/maps\/@(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/.exec(path))) mq = m[1] + ',' + m[2];
      mq = mq.replace(/\s+/g, ' ').trim().slice(0, 200);
      if (mq) return hit('maps', 'Google Maps', 'https://www.google.com/maps?q=' + encodeURIComponent(mq) + '&output=embed');
    } else if (host === 'maps.app.goo.gl' || (bare === 'goo.gl' && path.indexOf('/maps') === 0)) {
      out.name = 'Google Maps'; out.framable = false; return out;
    } else if (bare === 'loom.com') {
      m = /^\/share\/([A-Za-z0-9]{10,40})\/?$/.exec(path);
      if (m) return hit('loom', 'Loom', 'https://www.loom.com/embed/' + m[1]);
    } else if (bare === 'soundcloud.com') {
      m = /^\/([A-Za-z0-9_-]+)\/((?:sets\/)?[A-Za-z0-9_-]+)\/?$/.exec(path);
      if (m && !/^(discover|search|you|stream|upload|pages|settings|charts|messages|notifications)$/.test(m[1]))
        return hit('soundcloud', 'SoundCloud', 'https://w.soundcloud.com/player/?url=' + encodeURIComponent('https://soundcloud.com' + path));
    } else if (host === 'codepen.io') {
      m = /^\/([A-Za-z0-9_-]{1,40})\/pen\/([A-Za-z0-9]{4,20})\/?$/.exec(path);
      if (m) return hit('codepen', 'CodePen', 'https://codepen.io/' + m[1] + '/embed/' + m[2] + '?default-tab=result');
    }
    var blocked = noEmbedName(host);
    if (blocked) { out.name = blocked; out.framable = false; }
    return out;
  }
  /* embedFor:end */

  /* isImageUrl:start */
  var IMAGE_HOSTS = ['i.pinimg.com', 'assets.pinterest.com', 'images.unsplash.com', 'i.imgur.com', 'upload.wikimedia.org', 'pbs.twimg.com'];
  function isImageUrl(url) {
    var u;
    try { u = new URL(String(url)); } catch (e) { return false; }
    if (u.protocol !== 'https:') return false;
    if (/\.(jpe?g|png|gif|webp|avif|svg)$/i.test(u.pathname)) return true;
    var host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (IMAGE_HOSTS.some(function (h) { return host === h || host.slice(-(h.length + 1)) === '.' + h; })) return true;
    return u.searchParams.getAll('format').some(function (f) { return /^(jpg|jpeg|png|webp)$/i.test(f); });
  }
  /* isImageUrl:end */

  /* ---------- embed frames (DOM, synced from els on every draw) ---------- */
  var embedLayer = document.getElementById('embeds'), embedNodes = {};
  var ICON_X = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var ICON_OPEN = '<svg viewBox="0 0 24 24"><path d="M7 17L17 7M9 7h8v8"/></svg>';
  var ICON_TOUCH = '<svg viewBox="0 0 24 24"><path d="M8 4l10 8-4.5 1 2.5 5-2 1-2.5-5L8 19z"/></svg>';
  var ICON_STOP = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12"/></svg>';
  var ICON_RETRY = '<svg viewBox="0 0 24 24"><path d="M19 12a7 7 0 1 1-2.2-5.1M19 4v4h-4"/></svg>';
  function mk(tag, cls, parent) { var n = document.createElement(tag); if (cls) n.className = cls; if (parent) parent.appendChild(n); return n; }
  function embedById(id) { for (var i = 0; i < els.length; i++) if (els[i].id === id && els[i].type === 'embed') return els[i]; return null; }
  function isStalled(el) { return !!el.pending && Date.now() - (el.since || 0) > STALL; }

  function makeEmbedNode(el) {
    var id = el.id, n = { id: id, src: null, iframe: null, loaded: false, timer: 0, sawPending: false };
    n.root = mk('div', 'emb', embedLayer);
    ['a', 'b', 'c', 'd'].forEach(function (k) { mk('i', 'eh ' + k, n.root); });
    var bar = mk('div', 'ebar', n.root);
    n.title = mk('span', 'etitle', bar);
    n.retry = mk('button', 'eretry', bar); n.retry.type = 'button'; n.retry.innerHTML = ICON_RETRY; n.retry.appendChild(document.createTextNode('Retry')); n.retry.setAttribute('aria-label', 'Retry');
    n.stop = mk('button', 'eretry', bar); n.stop.type = 'button'; n.stop.innerHTML = ICON_STOP; n.stop.appendChild(document.createTextNode('Stop')); n.stop.setAttribute('aria-label', 'Stop'); n.stop.hidden = true;
    n.int = mk('button', 'eint', bar); n.int.type = 'button'; n.int.innerHTML = ICON_TOUCH; n.int.setAttribute('aria-label', 'Interact'); n.int.setAttribute('aria-pressed', 'false');
    n.open = mk('a', 'eopen', bar); n.open.innerHTML = ICON_OPEN; n.open.target = '_blank'; n.open.rel = 'noopener noreferrer'; n.open.setAttribute('aria-label', 'Open in a new tab');
    n.pubOpen = mk('a', 'eopen', bar); n.pubOpen.innerHTML = ICON_OPEN; n.pubOpen.target = '_blank'; n.pubOpen.rel = 'noopener noreferrer'; n.pubOpen.setAttribute('aria-label', 'Open hosted link'); n.pubOpen.hidden = true;
    n.more = mk('button', 'emore', bar); n.more.type = 'button'; n.more.textContent = '···'; n.more.setAttribute('aria-label', 'More'); n.more.setAttribute('aria-haspopup', 'true'); n.more.setAttribute('aria-expanded', 'false'); n.more.hidden = true;
    n.close = mk('button', 'eclose', bar); n.close.type = 'button'; n.close.innerHTML = ICON_X; n.close.setAttribute('aria-label', 'Close frame');
    n.body = mk('div', 'ebody', n.root);
    var ns = 'http://www.w3.org/2000/svg', rc = document.createElementNS(ns, 'rect');
    n.pend = document.createElementNS(ns, 'svg');
    n.pend.setAttribute('class', 'epend'); n.pend.setAttribute('aria-hidden', 'true');
    rc.setAttribute('width', '100%'); rc.setAttribute('height', '100%');
    n.pend.appendChild(rc); n.body.appendChild(n.pend);
    n.hint = mk('div', 'ehint', n.body); n.hint.hidden = true;
    n.hint.appendChild(document.createTextNode('scroll'));
    n.hint.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M1 2.5 L4 5.5 L7 2.5"/></svg>');
    n.card = mk('div', 'ecard', n.body); n.card.hidden = true;
    n.cName = mk('div', 'cname', n.card);
    var mid = mk('div', 'cmid', n.card);
    n.cMsg = mk('div', 'cmsg', mid); n.cHint = mk('div', 'chint', mid); n.cWhy = mk('div', 'cwhy', mid); n.cWhy.hidden = true;
    n.cOpen = mk('a', 'copen', n.card); n.cOpen.textContent = 'Open'; n.cOpen.target = '_blank'; n.cOpen.rel = 'noopener noreferrer';
    n.cActs = mk('div', 'cacts', n.card); n.cActs.hidden = true;
    n.cRetry = mk('button', 'copen', n.cActs); n.cRetry.type = 'button'; n.cRetry.textContent = 'Retry';
    n.cRemove = mk('button', 'copen', n.cActs); n.cRemove.type = 'button'; n.cRemove.textContent = 'Remove';
    n.status = mk('div', 'estat', n.body); n.status.hidden = true; n.status.setAttribute('aria-live', 'polite');
    n.built = mk('div', 'ebuilt', n.body); n.built.hidden = true;
    n.pop = mk('div', 'epop', n.root); n.pop.hidden = true;
    n.popBuilt = mk('button', '', n.pop); n.popBuilt.type = 'button'; n.popBuilt.disabled = true; n.popBuilt.hidden = true;
    n.popBtn = mk('button', '', n.pop); n.popBtn.type = 'button'; n.popBtn.textContent = 'Publish to a link (needs GitHub)';
    mk('p', '', n.pop).textContent = 'Hosts a public copy. Opens GitHub.';

    function removeFrame() {
      var g = gens[id]; if (g) { g.removed = true; g.ac.abort(); }
      snap(); els = els.filter(function (e) { return e.id !== id; });
      if (selId === id) selId = null;
      save(); draw();
    }
    n.cRemove.addEventListener('click', removeFrame);
    n.cRetry.addEventListener('click', function () { startApp(id); });    n.stop.addEventListener('click', function () { var g = gens[id]; if (g) { g.stopped = true; g.ac.abort(); } });
    n.more.addEventListener('click', function () { var open = n.pop.hidden; closePops(); n.pop.hidden = !open; n.more.setAttribute('aria-expanded', String(open)); if (open) n.popBtn.focus(); });
    n.popBtn.addEventListener('click', function () { var e = embedById(id); closePops(); if (e) publishApp(e); });
    n.close.addEventListener('click', function () {
      var g = gens[id]; if (g) { g.removed = true; g.ac.abort(); }
      snap(); els = els.filter(function (e) { return e.id !== id; });
      if (selId === id) selId = null;
      save(); draw();
    });
    n.retry.addEventListener('click', function () {
      var e = embedById(id); if (!e || e.kind === 'app') return;
      e.since = Date.now(); save(); draw(); pollTick();
    });
    n.int.addEventListener('click', function () { interactId = interactId === id ? null : id; draw(); });
    return n;
  }
  function flashHint(n) {
    n.hint.classList.add('on'); clearTimeout(n.hintT);
    n.hintT = setTimeout(function () { n.hint.classList.remove('on'); }, 6000);
  }
  function nodeOfBody(b) {
    var ids = Object.keys(embedNodes);
    for (var i = 0; i < ids.length; i++) if (embedNodes[ids[i]].body === b) return embedNodes[ids[i]];
    return null;
  }
  /* plain wheel over a ready app frame scrolls the app; ctrl/meta wheel (pinch) stays a canvas gesture */
  document.addEventListener('wheel', function (e) {
    if (e.ctrlKey || e.metaKey || !e.target.closest) return;
    var b = e.target.closest('.ebody'), n = b && nodeOfBody(b);
    if (!n || !n.iframe || !n.appId || n.root.classList.contains('act')) return;
    var r = n.iframe.getBoundingClientRect(), k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
    try { n.iframe.contentWindow.postMessage({ eWheel: 1, x: e.clientX - r.left, y: e.clientY - r.top, dx: e.deltaX * k, dy: e.deltaY * k }, '*'); } catch (err) { return; }
    e.preventDefault();
  }, { passive: false });
  document.addEventListener('pointerover', function (e) {
    var b = e.target.closest && e.target.closest('.ebody'), n = b && nodeOfBody(b);
    if (n && n.iframe && n.appId) flashHint(n);
  });
  function dropFrame(n) {
    clearTimeout(n.timer); n.timer = 0;
    if (n.iframe) { n.iframe.remove(); n.iframe = null; }
    n.src = null; n.loaded = false; n.card.hidden = true;
  }
  var HINT_NAMES = { Pinterest: 1, Instagram: 1, X: 1, TikTok: 1 };
  function showCard(n, known) {
    var name = known ? n.info.name : n.host;
    n.cName.textContent = name;
    n.cMsg.textContent = known ? name + " doesn't allow embedding." : 'This page might not allow embedding.';
    n.cHint.textContent = known && HINT_NAMES[name] === 1 ? "Paste the post's own embed link if it has one." : '';
    n.cHint.hidden = !n.cHint.textContent;
    n.card.hidden = false;
  }
  /* a blocked page gives no signal, so no load event after 4s means show the card (only while the frame is on screen) */
  function armNote(n) {
    clearTimeout(n.timer);
    n.timer = setTimeout(function () {
      if (n.loaded || !n.iframe) return;
      var r = n.root.getBoundingClientRect();
      if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth || document.hidden) { armNote(n); return; }
      showCard(n, false);
    }, 4000);
  }
  function updateEmbedNode(n, el) {
    var st = n.root.style;
    var ep = toScreen(el.x, el.y);
    st.left = Math.round(ep.x) + 'px'; st.top = Math.round(ep.y) + 'px'; st.transform = 'scale(' + view.z + ')';
    st.width = Math.round(el.w) + 'px'; st.height = Math.round(el.h) + 'px';
    if (el.kind === 'app') { updateAppNode(n, el); return; }
    var stalled = isStalled(el), sel = selId === el.id;
    n.root.classList.toggle('sel', sel);
    n.root.classList.toggle('erasing', !!eraseIds[el.id]);
    n.root.classList.toggle('act', interactId === el.id && !el.pending);
    n.root.classList.toggle('stall', stalled);
    var t = stalled ? 'Not live yet.' : (el.title || '');
    if (n.title.textContent !== t) n.title.textContent = t;
    n.retry.hidden = !stalled;
    n.int.hidden = !(sel && !el.pending);
    n.int.setAttribute('aria-pressed', String(interactId === el.id));
    if (n.open.getAttribute('href') !== el.url) { n.open.setAttribute('href', el.url); n.cOpen.setAttribute('href', el.url); }
    n.pend.style.display = el.pending ? '' : 'none';
    if (el.pending) { n.sawPending = true; if (n.iframe) dropFrame(n); return; }
    if (n.src !== el.url) {
      dropFrame(n);
      n.src = el.url; n.info = embedFor(el.url);
      n.host = ''; try { n.host = new URL(el.url).hostname.replace(/^www\./, ''); } catch (e) {}
    }
    var info = n.info;
    if (!info.framable) { if (n.iframe) { n.iframe.remove(); n.iframe = null; } showCard(n, true); return; }
    if (!n.iframe) {
      var f = document.createElement('iframe'), prov = !!info.provider;
      /* translated provider urls are cross-origin to the board, so allow-same-origin there means the provider's own origin */
      f.setAttribute('sandbox', prov ? 'allow-scripts allow-same-origin allow-popups allow-forms allow-presentation' : 'allow-scripts allow-forms allow-popups');
      if (prov) { f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen'); f.setAttribute('allowfullscreen', ''); }
      f.setAttribute('loading', 'lazy'); f.setAttribute('referrerpolicy', prov ? 'strict-origin-when-cross-origin' : 'no-referrer');
      f.setAttribute('title', el.title || 'Embedded page');
      f.addEventListener('load', function () { n.loaded = true; clearTimeout(n.timer); n.card.hidden = true; });
      n.iframe = f; n.body.insertBefore(f, n.pend);
      if (n.sawPending) {
        f.className = 'fade'; n.sawPending = false;
        requestAnimationFrame(function () { requestAnimationFrame(function () { f.classList.remove('fade'); }); });
      }
      f.src = info.src; armNote(n);
    }
  }
