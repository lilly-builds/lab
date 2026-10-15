/* TEMPLATES MODULE: the Board Room reads published templates from the database
   when it can, static files otherwise, and anyone can publish one instantly -
   no sign-in, no review, no GitHub issue (#209).
   Plan: plans/2026-10-12-2015-feat-dreamspace-server-database-plan.md.

   Everything here runs through its own signed-out client and is gated on
   AIWB_SUPABASE.templatesEnabled, not on the board-sync flag, so the Board Room
   can be live while sync stays dark. ?sync=off kills it all.
   Published rows are world-readable; the anon insert policy only accepts
   published, unattributed, non-sample rows within the field caps.
   Payloads always pass through the app's loadEls sanitization on load - the
   database is a transport, not a trust boundary. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root && root.document) root.AIWB_TEMPLATES = api.create({ win: root, fetchFn: root.fetch && root.fetch.bind(root) });
})(typeof self !== 'undefined' ? self : this, function () {
  var CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
  var TIMEOUT_MS = 2500; /* fail open to the static files, like the board's circuit breaker */
  var PUBLISH_TIMEOUT_MS = 10000; /* a publish carries a whole payload, so it gets longer */
  var CAPS = { title: 60, why: 400, love: 400, author: 40, x: 15, elements: 120 };
  var X_RE = /^[A-Za-z0-9_]{1,15}$/;

  function syncOff(win) {
    try { return new URLSearchParams((win.location && win.location.search) || '').get('sync') === 'off'; }
    catch (e) { return false; }
  }
  function withTimeout(p, ms) {
    return Promise.race([
      p,
      new Promise(function (_, reject) { setTimeout(function () { reject(new Error('templates timeout')); }, ms); })
    ]);
  }
  function stamp(v) { var n = Date.parse(v); return isNaN(n) ? 0 : n; }

  /* The row a publish inserts. Same caps as the dialog and the database CHECKs;
     null when there is nothing worth publishing. */
  function shapeRow(t, slug) {
    var s = function (v, max) { return String(v == null ? '' : v).trim().slice(0, max); };
    var els = (Array.isArray(t.elements) ? t.elements : [])
      .filter(function (e) { return e && typeof e === 'object' && !Array.isArray(e); })
      .slice(0, CAPS.elements);
    var row = {
      slug: slug,
      title: s(t.title, CAPS.title),
      description: [s(t.why, CAPS.why), s(t.love, CAPS.love)].filter(Boolean).join('\n\n'),
      author_name: s(t.author, CAPS.author) || null,
      author_x: X_RE.test(String(t.x || '')) ? String(t.x) : null,
      payload: els,
      status: 'published'
    };
    return row.title && els.length ? row : null;
  }

  /* Gallery plan from the database result (null = unreachable) and the GitHub
     issue items: sample rows for the built-in grid (null = use the static files),
     community newest first with the just-published one pinned to the top. */
  function plan(db, github, publishedId) {
    var rows = Array.isArray(db) ? db : null;
    var samples = rows ? rows.filter(function (r) { return r.sample; }) : [];
    var community = (rows || []).filter(function (r) { return !r.sample; }).map(function (r) {
      return { id: r.id, title: r.title, why: r.desc, author: r.author, x: r.x, elements: r.payload, created: r.created || '' };
    }).concat(Array.isArray(github) ? github : []);
    community.sort(function (a, b) { return stamp(b.created) - stamp(a.created); });
    var at = publishedId ? community.findIndex(function (c) { return c.id === publishedId; }) : -1;
    if (at > 0) community.unshift(community.splice(at, 1)[0]);
    return { samples: samples.length ? samples : null, community: community, highlight: at >= 0 ? publishedId : null };
  }

  function create(opts) {
    var win = opts.win || {};
    var own = null; /* lazy signed-out client */

    function cfg() { return win.AIWB_SUPABASE || {}; }
    async function client() {
      if (syncOff(win)) return null; /* the kill switch always wins */
      var c = cfg();
      if (!c.templatesEnabled) return null; /* its own gate: independent of board sync */
      if (own) return own;
      if (!c.url || !c.anonKey || c.url.indexOf('YOUR-PROJECT-REF') >= 0) return null;
      var load = opts.loadSupabase || function () { return import(CDN); };
      try {
        /* no persisted session: a signed-in board must not turn a publish into an authenticated insert */
        own = (await withTimeout(load(), TIMEOUT_MS)).createClient(c.url, c.anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
        return own;
      } catch (e) { return null; }
    }

    /* Gallery list in the static manifest's shape, plus the payload itself.
       null (not []) on any failure so callers fall back to static files. */
    async function list() {
      var c = await client(); if (!c) return null;
      try {
        var r = await withTimeout(c.from('templates')
          .select('slug,title,description,author_name,author_x,is_sample,payload,published_at')
          .eq('status', 'published').order('published_at', { ascending: true }), TIMEOUT_MS);
        if (r.error || !r.data) return null;
        return r.data.map(function (t) {
          return {
            id: t.slug, title: t.title, desc: t.description || '',
            author: t.author_name || 'anonymous', x: t.author_x || '',
            sample: !!t.is_sample, payload: t.payload, created: t.published_at || ''
          };
        });
      } catch (e) { return null; }
    }

    /* One template's element array (?template=<id> on the board), null on miss */
    async function loadPayload(id) {
      if (!id || !/^[\w-]{1,60}$/.test(id)) return null;
      var c = await client(); if (!c) return null;
      try {
        var r = await withTimeout(c.from('templates').select('payload,status').eq('slug', id), TIMEOUT_MS);
        var row = r.data && r.data[0];
        if (r.error || !row || row.status !== 'published' || !Array.isArray(row.payload)) return null;
        return row.payload;
      } catch (e) { return null; }
    }

    /* Publish: one shared template row, live immediately. Never the author's board. */
    async function submit(t) {
      var c = await client();
      if (!c) return { ok: false, error: 'offline' };
      var row = shapeRow(t, makeSlug(t.title));
      if (!row) return { ok: false, error: 'empty' };
      for (var attempt = 0; attempt < 2; attempt++) {
        try {
          /* no .select(): an anon insert is not allowed to read the row back, the slug is ours */
          var r = await withTimeout(c.from('templates').insert(row), PUBLISH_TIMEOUT_MS);
          if (!r.error) return { ok: true, mode: 'db', slug: row.slug };
          var msg = String(r.error.message || '');
          if (/duplicate key/.test(msg) && attempt === 0) { row = retryRow(t, row.slug); continue; }
          return { ok: false, error: 'rejected' };
        } catch (e) { return { ok: false, error: 'offline' }; }
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

    return { list: list, loadPayload: loadPayload, submit: submit, makeSlug: makeSlug, shapeRow: shapeRow, plan: plan };
  }

  return { create: create, shapeRow: shapeRow, plan: plan, CAPS: CAPS };
});
