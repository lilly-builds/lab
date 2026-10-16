/* TEMPLATES MODULE: the Board Room reads published templates from the database
   when it can, static files otherwise, and anyone can publish one instantly -
   no sign-in, no review, no GitHub issue (#209).
   Plan: plans/2026-10-12-2015-feat-dreamspace-server-database-plan.md.

   Everything here runs through its own signed-out client and is gated on
   AIWB_SUPABASE.templatesEnabled, not on the board-sync flag, so the Board Room
   can be live while sync stays dark. ?sync=off kills it all.
   Published rows are world-readable; the anon insert policy only accepts
   published, unattributed, non-sample rows within the field caps, under a
   global rate cap. The dashboard is the moderation path.
   Payloads always pass through the app's loadEls sanitization on load - the
   database is a transport, not a trust boundary. Gallery lists are paged on the
   server and never carry payloads; a payload is fetched per card. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root && root.document) root.AIWB_TEMPLATES = api.create({ win: root, fetchFn: root.fetch && root.fetch.bind(root) });
})(typeof self !== 'undefined' ? self : this, function () {
  var CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
  var TIMEOUT_MS = 2500; /* fail open to the static files, like the board's circuit breaker */
  var PUBLISH_TIMEOUT_MS = 10000; /* a publish carries a whole payload, so it gets longer */
  var CAPS = { title: 60, why: 400, love: 400, author: 40, x: 15, elements: 120 };
  var PAGE = 24; /* community cards per gallery page */
  var X_RE = /^[A-Za-z0-9_]{1,15}$/;
  /* at least one visible character: not whitespace, zero-width, bidi or invisible fillers (same set as the DB CHECK) */
  var VISIBLE_RE = /[^\s­͏ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ﻿ﾠ]/;
  var COLS = 'slug,title,description,author_name,author_x,is_sample,published_at'; /* never the payload: it can be 600KB a row */

  function syncOff(win) {
    try { return new URLSearchParams((win.location && win.location.search) || '').get('sync') === 'off'; }
    catch (e) { return false; }
  }
  function stamp(v) { var n = Date.parse(v); return isNaN(n) ? 0 : n; }

  /* The row a publish inserts. Same caps as the dialog and the database CHECKs;
     null when there is nothing worth publishing. */
  function shapeRow(t, slug) {
    var s = function (v, max) { return String(v == null ? '' : v).trim().slice(0, max); };
    var els = (Array.isArray(t.elements) ? t.elements : [])
      .filter(function (e) { return e && typeof e === 'object' && !Array.isArray(e); })
      .slice(0, CAPS.elements);
    var author = s(t.author, CAPS.author);
    var row = {
      slug: slug,
      title: s(t.title, CAPS.title),
      description: [s(t.why, CAPS.why), s(t.love, CAPS.love)].filter(Boolean).join('\n\n'),
      author_name: VISIBLE_RE.test(author) ? author : null,
      author_x: X_RE.test(String(t.x || '')) ? String(t.x) : null,
      payload: els,
      status: 'published'
    };
    return VISIBLE_RE.test(row.title) && els.length ? row : null;
  }

  /* One gallery page of community cards, newest first. dbRows is the page just read
     (server-ordered), dbMore says another page exists, pool is the GitHub-issue items
     not shown yet (newest first). Pool items newer than the oldest row on this page
     are released with it, so the merged list stays strictly newest first across pages. */
  function mergePage(dbRows, dbMore, pool, lastCreated) {
    var rows = dbRows || [];
    var last = lastCreated || (rows.length ? rows[rows.length - 1].created : '');
    var cutoff = dbMore && last ? stamp(last) : -Infinity;
    var take = [], rest = [];
    (pool || []).forEach(function (g) { (stamp(g.created) >= cutoff ? take : rest).push(g); });
    var items = rows.concat(take);
    items.sort(function (a, b) { return stamp(b.created) - stamp(a.created); });
    return { items: items, rest: rest };
  }

  /* a database row in the gallery's shape; payload only when the query asked for it */
  function toRow(t) {
    return {
      id: t.slug, title: t.title, desc: t.description || '',
      author: t.author_name || 'anonymous', x: t.author_x || '',
      sample: !!t.is_sample, created: t.published_at || '',
      payload: Array.isArray(t.payload) ? t.payload : null, lazy: !Array.isArray(t.payload)
    };
  }

  function create(opts) {
    var win = opts.win || {};
    var ownP = null; /* lazy signed-out client (one load shared by concurrent callers) */
    var readMs = opts.timeoutMs || TIMEOUT_MS;
    var publishMs = opts.publishTimeoutMs || PUBLISH_TIMEOUT_MS;
    var ambiguous = null; /* a publish that timed out: {title, slug}, reused so a landed first request is a duplicate, not a twin */

    function withTimeout(p, ms) {
      var timer;
      return Promise.race([
        p,
        new Promise(function (_, reject) { timer = setTimeout(function () { reject(new Error('templates timeout')); }, ms); })
      ]).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
    }
    function cfg() { return win.AIWB_SUPABASE || {}; }
    async function client() {
      if (syncOff(win)) return null; /* the kill switch always wins */
      var c = cfg();
      if (!c.templatesEnabled) return null; /* its own gate: independent of board sync */
      if (!c.url || !c.anonKey || c.url.indexOf('YOUR-PROJECT-REF') >= 0) return null;
      if (!ownP) {
        var load = opts.loadSupabase || function () { return import(CDN); };
        /* no persisted session: a signed-in board must not turn a publish into an authenticated insert */
        ownP = withTimeout(load(), readMs).then(function (m) {
          return m.createClient(c.url, c.anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
        }).catch(function () { ownP = null; return null; });
      }
      return ownP;
    }

    /* Built-in (sample) rows for the top grid, no payloads. null (not []) on any
       failure so callers fall back to the static files. */
    async function samples() {
      var c = await client(); if (!c) return null;
      try {
        var r = await withTimeout(c.from('templates').select(COLS)
          .eq('status', 'published').eq('is_sample', true)
          .order('published_at', { ascending: true }).order('slug', { ascending: true }).range(0, 99), readMs);
        if (r.error || !Array.isArray(r.data)) return null;
        return r.data.map(toRow);
      } catch (e) { return null; }
    }

    /* One page (0-based) of community templates, newest first, ordered and paged by the
       server, no payloads. {rows, more} or null on any failure. Reads PAGE + 1 to know
       whether another page exists. */
    async function page(n) {
      var c = await client(); if (!c) return null;
      var from = Math.max(0, n | 0) * PAGE;
      try {
        var r = await withTimeout(c.from('templates').select(COLS)
          .eq('status', 'published').eq('is_sample', false)
          .order('published_at', { ascending: false }).order('slug', { ascending: true }).range(from, from + PAGE), readMs);
        if (r.error || !Array.isArray(r.data)) return null;
        return { rows: r.data.slice(0, PAGE).map(toRow), more: r.data.length > PAGE };
      } catch (e) { return null; }
    }

    /* one published community row by slug (the just-published card), no payload; null on miss */
    async function one(id) {
      if (!id || !/^[\w-]{1,60}$/.test(id)) return null;
      var c = await client(); if (!c) return null;
      try {
        var r = await withTimeout(c.from('templates').select(COLS).eq('status', 'published').eq('slug', id), readMs);
        var row = !r.error && Array.isArray(r.data) && r.data[0];
        return row ? toRow(row) : null;
      } catch (e) { return null; }
    }

    /* One template's element array (?template=<id> on the board, and each card's preview), null on miss */
    async function loadPayload(id) {
      if (!id || !/^[\w-]{1,60}$/.test(id)) return null;
      var c = await client(); if (!c) return null;
      try {
        var r = await withTimeout(c.from('templates').select('payload,status').eq('slug', id), readMs);
        var row = r.data && r.data[0];
        if (r.error || !row || row.status !== 'published' || !Array.isArray(row.payload)) return null;
        return row.payload;
      } catch (e) { return null; }
    }

    function isDup(err) { return err && (err.code === '23505' || /duplicate key/.test(String(err.message || ''))); }

    /* Publish: one shared template row, live immediately. Never the author's board.
       - slug collision: retry once with a fresh row and a different slug.
       - timeout: the first request may still have landed, so retry with the SAME slug;
         a duplicate-key answer then means it did land, and that is a success, not a twin.
         A second timeout is remembered, so tapping Share again reuses the slug too. */
    async function submit(t) {
      var c = await client();
      if (!c) return { ok: false, error: 'offline' };
      var title = String(t.title || '');
      var slug = ambiguous && ambiguous.title === title ? ambiguous.slug : makeSlug(t.title);
      var row = shapeRow(t, slug);
      if (!row) return { ok: false, error: 'empty' };
      var collided = false, timedOut = false;
      for (var attempt = 0; attempt < 3; attempt++) {
        try {
          /* no .select(): an anon insert is not allowed to read the row back, the slug is ours */
          var r = await withTimeout(c.from('templates').insert(row), publishMs);
          if (!r.error || (timedOut && isDup(r.error))) { ambiguous = null; return { ok: true, mode: 'db', slug: row.slug }; }
          if (isDup(r.error) && !collided) { collided = true; timedOut = false; row = retryRow(t, row.slug); continue; }
          ambiguous = null;
          return { ok: false, error: /rate limit/.test(String(r.error.message || '')) ? 'busy' : 'rejected' };
        } catch (e) {
          if (timedOut) { ambiguous = { title: title, slug: row.slug }; return { ok: false, error: 'offline' }; }
          timedOut = true; /* same row, same slug */
        }
      }
      return { ok: false, error: 'rejected' };
    }

    /* a fresh row object (never mutate the one already sent) with a slug that differs from the collided one */
    function retryRow(t, taken) {
      var slug = makeSlug(t.title);
      for (var i = 0; i < 5 && slug === taken; i++) slug = makeSlug(t.title);
      return shapeRow(t, slug);
    }

    function makeSlug(title) {
      var base = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 5).join('-').slice(0, 30) || 'board';
      var suf = '';
      while (suf.length < 4) suf += Math.random().toString(36).slice(2);
      return base + '-' + suf.slice(0, 4);
    }

    return { samples: samples, page: page, one: one, loadPayload: loadPayload, submit: submit, makeSlug: makeSlug, shapeRow: shapeRow, mergePage: mergePage };
  }

  return { create: create, shapeRow: shapeRow, mergePage: mergePage, CAPS: CAPS, PAGE: PAGE };
});
