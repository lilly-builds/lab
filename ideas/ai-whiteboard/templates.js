/* TEMPLATES MODULE (U8): Board Room reads published templates from the
   database when it can, static files otherwise; shares land pending and
   capped instead of opening a GitHub issue (R12, R13).
   Plan: plans/2026-10-12-2015-feat-dreamspace-server-database-plan.md.

   Published rows are world-readable (anon role included), so the gallery can
   read them signed-out through its own lightweight client; submitting needs
   the sync session (the insert policy pins author_user_id to the caller).
   Payloads always pass through the app's loadEls sanitization on load - the
   database is a transport, not a trust boundary (AE5-adjacent). */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root && root.document) root.AIWB_TEMPLATES = api.create({ win: root, session: root.AIWB_SYNC || null, fetchFn: root.fetch && root.fetch.bind(root) });
})(typeof self !== 'undefined' ? self : this, function () {
  var CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

  function create(opts) {
    var win = opts.win || {}, session = opts.session || null, fetchFn = opts.fetchFn;
    var own = null; /* lazy gallery client (signed-out reads of published rows) */

    function cfg() { return win.AIWB_SUPABASE || {}; }
    async function client() {
      var s = session || win.AIWB_SYNC; /* the board creates its session after this file loads */
      if (s && s.client) return s.client;
      if (own) return own;
      var c = cfg();
      if (!c.enabled) return null; /* gallery DB reads follow the same flag as the board */
      if (!c.url || !c.anonKey || c.url.indexOf('YOUR-PROJECT-REF') >= 0) return null;
      var load = opts.loadSupabase || function () { return import(CDN); };
      try { own = (await load()).createClient(c.url, c.anonKey); return own; }
      catch (e) { return null; }
    }

    /* Gallery list in the static manifest's shape, plus the payload itself.
       null (not []) on any failure so callers fall back to static files. */
    async function list() {
      var c = await client(); if (!c) return null;
      try {
        var r = await c.from('templates')
          .select('slug,title,description,author_name,author_x,is_sample,payload')
          .eq('status', 'published').order('published_at', { ascending: true });
        if (r.error || !r.data) return null;
        return r.data.map(function (t) {
          return {
            id: t.slug, title: t.title, desc: t.description || '',
            author: t.author_name || 'anonymous', x: t.author_x || '',
            sample: !!t.is_sample, payload: t.payload
          };
        });
      } catch (e) { return null; }
    }

    /* One template's element array (?template=<id> on the board), null on miss */
    async function loadPayload(id) {
      if (!id || !/^[\w-]{1,60}$/.test(id)) return null;
      var c = await client(); if (!c) return null;
      try {
        var r = await c.from('templates').select('payload,status').eq('slug', id);
        var row = r.data && r.data[0];
        if (r.error || !row || row.status !== 'published' || !Array.isArray(row.payload)) return null;
        return row.payload;
      } catch (e) { return null; }
    }

    /* Share-as-template when synced: a pending row with attribution instead of
       the GitHub issue (R13). The per-author pending cap and policy rejections
       come back as mapped errors; offline callers fall back to the issue flow. */
    async function submit(t) {
      var s = session || win.AIWB_SYNC;
      if (!s || s.state !== 'online' || !s.client) return { ok: false, error: 'offline' };
      var c = s.client;
      var row = {
        slug: makeSlug(t.title), title: String(t.title || '').slice(0, 120),
        description: [t.why, t.love].filter(Boolean).join('\n\n').slice(0, 1000),
        author_name: String(t.author || '').slice(0, 60) || null,
        author_x: String(t.x || '').slice(0, 30) || null,
        payload: Array.isArray(t.elements) ? t.elements : [],
        status: 'pending'
      };
      if (!row.title || !row.payload.length) return { ok: false, error: 'empty' };
      for (var attempt = 0; attempt < 2; attempt++) {
        try {
          var r = await c.from('templates').insert(row).select('slug');
          if (!r.error && r.data && r.data[0]) return { ok: true, mode: 'db', slug: r.data[0].slug };
          var msg = String((r.error && r.error.message) || '');
          if (/duplicate key/.test(msg) && attempt === 0) { row.slug = makeSlug(t.title); continue; }
          if (/cap/.test(msg)) return { ok: false, error: 'cap' };
          return { ok: false, error: 'rejected' };
        } catch (e) { return { ok: false, error: 'offline' }; }
      }
      return { ok: false, error: 'rejected' };
    }

    function makeSlug(title) {
      var base = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 5).join('-').slice(0, 30) || 'board';
      var suf = '';
      while (suf.length < 4) suf += Math.random().toString(36).slice(2);
      return base + '-' + suf.slice(0, 4);
    }

    return { list: list, loadPayload: loadPayload, submit: submit, makeSlug: makeSlug };
  }

  return { create: create };
});
