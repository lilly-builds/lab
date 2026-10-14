/* SYNC MODULE (U4): anonymous-first sync behind the runtime flag.
   Plan: plans/2026-10-12-2015-feat-dreamspace-server-database-plan.md (KTD4, KTD5, KTD7; R2, R5, R6, R7, R18).

   Flag resolution: ?sync=off always wins, then ?sync=on, then the committed
   config's enabled (default false). Flag off: this file does nothing - no
   supabase-js fetch, no backend calls, byte-identical app (AE1).

   Flag on: nothing happens until the app signals readiness (load event), the
   Magic Moment is never blocked; supabase-js lazy-loads from the CDN on first
   use; anonymous sign-in happens on the first sync-worthy action, not page
   load (R18). A 2.5s timeout with a circuit breaker fails open to local mode
   for the session (AE6). localStorage stays canonical (KTD7). */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root && root.document) api.boot(root);
})(typeof self !== 'undefined' ? self : this, function () {
  var CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
  var TIMEOUT_MS = 2500;
  var BOARD_KEY = 'aiwb.board';
  var JUICE_Q_KEY = 'aiwb.juice.q';  /* persisted earn events awaiting the ledger (U6) */
  var FLUSH_DEBOUNCE_MS = 400;

  /* engine module: a window global in the browser (script tag), require()d in node tests */
  var Engine = (typeof AIWBSyncEngine !== 'undefined') ? AIWBSyncEngine
    : (typeof require === 'function' ? require('./sync-engine.js') : null);

  function resolveFlag(search, configEnabled) {
    var q = new URLSearchParams(search || '');
    if (q.get('sync') === 'off') return false;   /* the kill switch always wins */
    if (q.get('sync') === 'on') return true;
    return !!configEnabled;
  }

  function withTimeout(p, ms) {
    return Promise.race([
      p,
      new Promise(function (_, reject) { setTimeout(function () { reject(new Error('sync timeout')); }, ms); })
    ]);
  }

  function boot(win) {
    var cfg = win.AIWB_SUPABASE || {};
    if (!resolveFlag(win.location && win.location.search, cfg.enabled)) return;
    function start() {
      if (!win.AIWB || win.AIWB_SYNC) return;
      win.AIWB_SYNC = createSession({
        win: win,
        config: cfg,
        app: win.AIWB,
        storage: win.localStorage,
        loadSupabase: function () { return import(CDN); },
        timeoutMs: TIMEOUT_MS
      });
    }
    if (win.document.readyState === 'complete') start();
    else win.addEventListener('load', start);
  }

  function createSession(opts) {
    var win = opts.win || {};
    var cfg = opts.config;
    var app = opts.app;
    var storage = opts.storage;
    var timeoutMs = opts.timeoutMs || TIMEOUT_MS;
    var sb = null, engine = null, channel = null;
    var state = 'idle';        /* idle -> connecting -> online | offline (session) */
    var myUserId = null, flushingJuice = false, beforeImport = null;
    var started = false, flushTimer = null;

    function lsGet(k) { try { return storage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { storage.setItem(k, v); } catch (e) {} }

    function badge(text) {
      /* quiet UI note; never an interruption */
      if (!win.document) return;
      var b = win.document.getElementById('aiwb-sync-badge');
      if (!text) { if (b) b.remove(); return; }
      if (!b) {
        b = win.document.createElement('div');
        b.id = 'aiwb-sync-badge';
        b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:40;padding:3px 10px;' +
          'font:12px/1.6 "Special Elite","Courier New",monospace;color:#1e1e1e;background:#fff;' +
          'border:1.5px solid #1e1e1e;border-radius:10px;opacity:.85;pointer-events:none';
        win.document.body.appendChild(b);
      }
      b.textContent = text;
    }

    function circuitOpen() {
      state = 'offline';
      badge('offline - board is local');
    }

    /* server rows are untrusted input: everything inbound passes through the
       app's own loadEls(rows, false) sanitizer before touching the scene */
    function sanitize(rows) {
      var els = (rows || []).map(function (r) {
        return Object.assign({}, r.payload || {}, { id: r.element_key, type: r.type });
      });
      var clean = app.loadEls(els, false);
      var keep = {};
      clean.forEach(function (e) { if (e && e.id) keep[e.id] = true; });
      return (rows || []).filter(function (r) { return keep[r.element_key]; });
    }

    function transport() {
      return {
        importBoard: async function (boardId, scene, importKey) {
          var juice = parseInt(lsGet('aiwb.juice') || '0', 10) || 0;
          var r = await withTimeout(sb.rpc('import_board', {
            p_scene: scene, p_import_key: importKey, p_juice_balance: juice
          }), timeoutMs);
          if (r.error) throw new Error(r.error.message);
          return r.data;
        },
        upsert: async function (boardId, ops) {
          var r = await withTimeout(sb.rpc('upsert_elements', { p_board_id: boardId, p_elements: ops }), timeoutMs);
          if (r.error) throw new Error(r.error.message);
          return r.data;
        },
        pull: async function (boardId, sinceMs, keys) {
          var q = sb.from('board_elements')
            .select('element_key,type,payload,version,updated_at,deleted_at')
            .eq('board_id', boardId)
            .gt('updated_at', new Date(sinceMs).toISOString());
          if (keys && keys.length) q = q.in('element_key', keys);
          var r = await withTimeout(q, timeoutMs);
          if (r.error) throw new Error(r.error.message);
          return r.data.map(function (row) {
            return {
              element_key: row.element_key, type: row.type, payload: row.payload,
              version: row.version, deleted_at: row.deleted_at,
              updated_at: Date.parse(row.updated_at)
            };
          });
        }
      };
    }

    function subscribe(boardId) {
      if (!sb.channel) return; /* older or fake clients without realtime */
      try {
      channel = sb.channel('board:' + boardId)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'board_elements', filter: 'board_id=eq.' + boardId },
          function (msg) {
            if (!engine) return;
            var row = msg.eventType === 'DELETE'
              ? { element_key: msg.old && msg.old.element_key, deleted_at: new Date().toISOString(), updated_at: Date.now() }
              : Object.assign({}, msg.new, { updated_at: Date.parse(msg.new.updated_at) });
            engine.applyRemoteRows([row]);
            app.clearUndo();          /* a remote merge is never undone */
            app.save();               /* persist merged scene locally; diff finds nothing new */
            app.draw();
          })
        .subscribe();
      } catch (e) { /* realtime unavailable: pull-on-save still syncs (fail open) */ }
    }

    function makeEngine(boardId) {
      return Engine.create({
        boardId: boardId,
        transport: transport(),
        sanitize: sanitize,
        /* the engine speaks get/set; Web Storage speaks getItem/setItem. Passing
           it raw made every engine load/persist throw into its catch, so the
           snapshot, outbox and cursor never survived a reload. */
        storage: { get: lsGet, set: lsSet },
        onDeadLetter: function () { badge('some changes need a resync'); },
        onConflict: function () { badge('synced over a local change'); }
      });
    }

    async function init() {
      if (started) return;
      started = true;
      state = 'connecting';
      try {
        var mod = await withTimeout(opts.loadSupabase(), timeoutMs);
        sb = mod.createClient(cfg.url, cfg.anonKey);
        var sess = await withTimeout(sb.auth.getSession(), timeoutMs);
        if (!sess || !sess.data || !sess.data.session) {
          var anon = await withTimeout(sb.auth.signInAnonymously(), timeoutMs);
          if (anon && anon.error) throw new Error(anon.error.message);
          sess = await withTimeout(sb.auth.getSession(), timeoutMs);
        }
        myUserId = sess && sess.data && sess.data.session && sess.data.session.user && sess.data.session.user.id;
        engine = makeEngine(lsGet(BOARD_KEY) || 'local');
        /* an invite link joins the shared board BEFORE any import would
           create a personal one (U7): the hook may set BOARD_KEY, which
           turns the first sync into the returning-device pull path */
        if (!lsGet(BOARD_KEY) && beforeImport) {
          try { await beforeImport(); } catch (e) {}
          if (lsGet(BOARD_KEY)) engine.rebindBoardId(lsGet(BOARD_KEY));
        }
        if (!lsGet(BOARD_KEY)) {
          /* first sync: import the device scene, remap ids, store the board id */
          var res = await engine.importScene(app.getEls());
          engine.rebindBoardId(res.boardId);
          lsSet(BOARD_KEY, res.boardId);
          app.setEls(engine.scene);
          app.save();
          app.draw();
        } else {
          engine.attachRemote();
          engine.seedScene(app.getEls()); /* delta rows merge into the device scene, never replace it */
          await engine.pull();
          app.setEls(engine.scene);   /* remote rows won conflicts: show the merged scene */
          app.save();
          app.draw();
        }
        subscribe(engineBoardId());
        state = 'online';
        badge(null);
        scheduleFlush(0);
      } catch (e) {
        circuitOpen(); /* fail open: the app is fully local for the session (AE6) */
      }
    }

    /* switch the live session to another board (R15 cloud choice). init() is a
       no-op after first start, so this rebinds explicitly: push pending edits
       to the old board, drop its channel, new engine, empty scene, full pull. */
    async function openBoard(boardId) {
      if (!boardId) return false;
      if (!started) await init();
      if (state !== 'online' || !sb || !engine) return false;
      try {
        try { engine.diff(app.getEls()); await engine.flush(); } catch (e) {}
        if (channel && sb.removeChannel) { try { sb.removeChannel(channel); } catch (e) {} }
        channel = null;
        engine = null;               /* realtime and saves ignore the gap */
        lsSet(BOARD_KEY, boardId);
        var next = makeEngine(boardId);
        next.attachRemote();
        next.seedScene([]);
        await next.pullFull();
        engine = next;
        app.clearUndo();
        app.setEls(engine.scene);
        app.save();
        app.draw();
        subscribe(boardId);
        return true;
      } catch (e) {
        circuitOpen();
        return false;
      }
    }

    function engineBoardId() { return lsGet(BOARD_KEY) || 'local'; }

    /* U6: earn events wait in a persisted queue and flush only after the
       element flush (the note must exist server-side first). Permanent
       rejections (note gone, not completed, not an editor) drop the event;
       transient failures keep it for the next flush. Pre-first-sync earns
       use e<n> keys the import remaps away - the server drops them as
       "not found", which is correct: the imported_balance backfill already
       subsumes them. */
    function juiceQ() { try { return JSON.parse(lsGet(JUICE_Q_KEY) || '[]'); } catch (e) { return []; } }
    function setJuiceQ(q) { lsSet(JUICE_Q_KEY, JSON.stringify(q.slice(-50))); }

    async function flushJuice() {
      if (flushingJuice || state !== 'online' || !sb) return;
      flushingJuice = true;
      try {
        var q = juiceQ(), ev, r, msg;
        while (q.length) {
          ev = q[0];
          try {
            r = await withTimeout(sb.rpc('earn_juice', { p_board_id: engineBoardId(), p_note_key: ev.note_key, p_idempotency_key: ev.idem }), timeoutMs);
          } catch (e) { break; }                 /* transient: retry on the next flush */
          if (r.error) {
            msg = String(r.error.message || '');
            if (/not found|not completed|not a board editor|not authenticated/.test(msg)) { q.shift(); setJuiceQ(q); continue; }
            break;                               /* unknown error: retry later */
          }
          q.shift(); setJuiceQ(q);               /* server dedupes replays by idempotency key (AE4) */
        }
        if (state === 'online') refreshBalance();
      } finally { flushingJuice = false; }
    }

    async function refreshBalance() {
      var J = win.Juice;
      if (!J || !J.setBalance || !myUserId) return;
      try {
        var r = await sb.from('juice_balances').select('balance').eq('board_id', engineBoardId()).eq('user_id', myUserId);
        if (r.error || !r.data || !r.data.length) return;
        J.setBalance(r.data[0].balance || 0);
      } catch (e) {}
    }

    function hookJuice() {
      var J = win.Juice;
      if (!J) return;
      J.onEarn = function (note) {
        if (!note || !note.id) return;
        var q = juiceQ();
        q.push({ note_key: note.id, idem: 'earn:' + note.id + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 10) });
        setJuiceQ(q);
        if (state === 'online') scheduleFlush(); /* elements first, then the ledger */
      };
    }

    async function doFlush() {
      if (state !== 'online' || !engine) return;
      try {
        await engine.flush();
        badge(engine.deadLetters().length ? 'some changes need a resync' : null);
        await flushJuice();
      }
      catch (e) { circuitOpen(); }
    }
    function scheduleFlush(minDelay) {
      if (flushTimer) return;
      var wait = Math.max(minDelay || 0, FLUSH_DEBOUNCE_MS);
      flushTimer = setTimeout(function () { flushTimer = null; doFlush(); }, wait);
    }

    /* save() hook: diff the current scene and queue the flush. The first call
       with actual content is the first sync-worthy action (R18). */
    function onSave() {
      if (state === 'offline') return;
      if (!started) {
        var hasContent = (app.getEls() || []).length > 0 || lsGet(BOARD_KEY);
        if (hasContent) init();
        return;
      }
      if (!engine || state !== 'online') return;
      engine.diff(app.getEls());
      scheduleFlush();
    }

    hookJuice();
    app.afterSave = onSave;
    /* synced boards mint collision-resistant keys; the e<n> counter never
       resets from imported content because it is no longer used */
    app.newId = function () { return Engine.newKey(); };
    /* wholesale loads (templates, adoptBoard) merge by id as upserts */
    app.adoptBoard = function (tpl) {
      if (!engine || state !== 'online') return false; /* original path */
      engine.diff(app.getEls());
      engine.loadWholesale(tpl);
      app.setEls(engine.scene);
      app.save();
      app.draw();
      return true;
    };
    /* a returning synced device refreshes on load; a fresh device waits for
       the first sync-worthy action so page load never creates an account */
    if (lsGet(BOARD_KEY)) init();

    return {
      get state() { return state; },
      get engine() { return engine; },
      get client() { return sb; },      /* auth.js and team.js share the one connection */
      get userId() { return myUserId; },
      init: init,
      openBoard: openBoard,
      setBeforeImport: function (fn) { beforeImport = fn; },
      flush: doFlush,
      onSave: onSave
    };
  }

  return { boot: boot, resolveFlag: resolveFlag, createSession: createSession, CDN: CDN, TIMEOUT_MS: TIMEOUT_MS, BOARD_KEY: BOARD_KEY };
});
