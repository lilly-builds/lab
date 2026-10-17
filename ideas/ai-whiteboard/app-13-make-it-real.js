'use strict';
/* THIS FILE IS FOR the prefilled issue, waiting for the page, and polling. Loaded after app-12-built-apps.js, before app-14-loops.js. Plain globals; no IIFE. */

  /* ---------- make it real: prefilled issue in the lab repo, then wait for the page ---------- */
  var ISSUE = 'https://github.com/lilly-builds/lab/issues/new';
  function makeSlug(idea) {
    var words = idea.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 5);
    var base = words.join('-').slice(0, 34).replace(/-+$/, '') || 'idea', suf = '';
    while (suf.length < 4) suf += Math.random().toString(36).slice(2);
    suf = suf.slice(0, 4);
    var slug = base + '-' + suf;
    return /^[a-z0-9-]{3,40}$/.test(slug) ? slug : 'idea-' + suf;
  }
  function issueUrl(idea, slug) {
    var flat = idea.replace(/\s+/g, ' ');
    var title = 'Make it real: ' + (flat.length > 60 ? flat.slice(0, 59).trim() + '…' : flat);
    function build(p) {
      var body = [
        '@claude Build this idea as a live web app.',
        '',
        'Idea:',
        p,
        '',
        'Target folder: ideas/' + slug + '/',
        '',
        'Rules:',
        '- One self-contained index.html in ideas/' + slug + '/, no build step.',
        '- Take the visual design from the idea: follow any named style, mood, brand or reference closely; otherwise use a clean, modern, well-spaced default. Any Google Fonts family is fine.',
        '- Do not change anything under .github/.'
      ].join('\n');
      return ISSUE + '?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body);
    }
    var p = idea.slice(0, 2000), u = build(p);
    while (u.length > 6000 && p.length > 20) {
      p = p.slice(0, Math.max(10, p.length - Math.ceil((u.length - 6000) / 3) - 1)).trim();
      u = build(p + '…');
    }
    return u;
  }
  function makeItReal() {
    var idea = ask.value.trim();
    if (!idea) { ask.focus(); showErr('Type the idea first'); return; }
    if (busy) return;
    if (embedCount() >= EMB_MAX) { showErr('Six frames at most. Close one first.'); return; }
    if (!getKey(PROVIDER)) { openModal({ opener: magic, resume: true, real: true }); return; }
    clearNote();
    runBuild({ text: idea });
  }
  makeRealBtn.addEventListener('click', makeItReal);

  /* watcher: Pages answers CORS reads, so a plain fetch of index.html says whether the page exists */
  var probing = {};
  function probeUrl(u) {
    u = u.split('#')[0].split('?')[0];
    return /\.html?$/.test(u) ? u : u.replace(/\/?$/, '/') + 'index.html';
  }
  function checkLive(el) {
    var id = el.id, app = el.kind === 'app';
    if (probing[id]) return;
    probing[id] = true;
    fetch(probeUrl(app ? el.publishedUrl : el.url) + '?v=' + Date.now(), { cache: 'no-store' }).then(function (res) {
      if (!res.ok) return;
      var cur = embedById(id);
      if (app) {
        if (!cur || !cur.pubPending) return;
        cur.pubLive = true; delete cur.pubPending; delete cur.pubSince; save(); draw();
        return;
      }
      if (!cur || !cur.pending) return;
      cur.pending = false; delete cur.since; save(); draw();
    }).catch(function () {}).then(function () { delete probing[id]; });
  }
  function pollTick() {
    if (document.hidden) return;
    var any = false;
    els.forEach(function (el) {
      if (el.type === 'embed' && el.kind === 'app') {
        if (!el.pubPending || !el.publishedUrl) return;
        if (Date.now() - (el.pubSince || 0) > STALL) { delete el.pubPending; save(); return; }
        checkLive(el);
        return;
      }
      if (el.type !== 'embed' || !el.pending) return;
      any = true;
      if (!isStalled(el)) checkLive(el);
    });
    if (any) syncEmbeds();
  }
  setInterval(pollTick, 15000);
  document.addEventListener('visibilitychange', pollTick);

