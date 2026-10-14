/* SYNC ENGINE (U9): the diff, undo, conflict, and outbox machinery that makes
   server sync safe against the whiteboard's wholesale-replace habits.
   Plan: plans/2026-10-12-2015-feat-dreamspace-server-database-plan.md (KTD2, KTD7, U9).

   Transport-agnostic and DOM-free so it runs under plain node tests. U4 wires
   it to supabase-js and the app; tests wire it to a fake transport.

   Contract with the server (see supabase/migrations):
   - importBoard(boardId, scene, importKey): one-shot import, rows land at version 1.
   - upsert(boardId, ops): CAS per op on base_version; per-op outcome
     {element_key, version, status: ok|conflict|rejected}; a tombstone always wins.
   - pull(boardId, sinceMs, keys?): rows changed after sinceMs (send cursor - overlap).

   Semantics:
   - localStorage stays canonical (KTD7); this mirrors deltas.
   - diff() coalesces per element: one queued op per key, latest intent wins.
   - conflicts: re-pull the key, server state wins, the local op is dropped (quiet note upstream).
   - retries: bounded; ops that keep failing transport move to dead-letters (quiet badge upstream).
   - flush() attempts everything queued; the caller schedules automatic flushes
     using nextFlushAt() (advisory backoff). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AIWBSyncEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var MAX_TRIES = 5;
  var BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
  var OVERLAP_MS = 5000;
  var KEY_ABC = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-';

  function newKey(len) {
    len = len || 16;
    var s = '', i, b;
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      b = crypto.getRandomValues(new Uint8Array(len));
      for (i = 0; i < len; i++) s += KEY_ABC[b[i] & 63];
    } else {
      for (i = 0; i < len; i++) s += KEY_ABC[(Math.random() * 64) | 0];
    }
    return s;
  }

  /* stable stringify with volatile client-only fields stripped */
  function hash(el) {
    return JSON.stringify(el, function (k, v) { return k === 'tainted' ? undefined : v; });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function deviceOnly(el) { return el && el.type === 'embed' && el.kind === 'app'; }

  function create(opts) {
    var boardId = opts.boardId;
    var transport = opts.transport;
    var sanitize = opts.sanitize || function (rows) { return rows; };
    var storage = opts.storage || { get: function () { return null; }, set: function () {} };
    var now = opts.now || function () { return Date.now(); };
    var onDeadLetter = opts.onDeadLetter || function () {};
    var onConflict = opts.onConflict || function () {};

    var P = 'aiwb.sync.' + boardId + '.';
    function rebindBoardId(newId) {  /* first sync: the server assigns the board id */
      boardId = newId;
      P = 'aiwb.sync.' + boardId + '.';
      persist();
    }
    function load(key, fallback) {
      try { var s = storage.get(P + key); return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
    }
    function persist() {
      try {
        storage.set(P + 'snapshot', JSON.stringify(snapshot));
        storage.set(P + 'outbox', JSON.stringify(outbox));
        storage.set(P + 'dead', JSON.stringify(dead));
        storage.set(P + 'cursor', JSON.stringify(cursor));
        storage.set(P + 'importKey', JSON.stringify(importKey));
        storage.set(P + 'importSource', JSON.stringify(importSource));
        storage.set(P + 'importMap', JSON.stringify(importMap));
        storage.set(P + 'importedScene', JSON.stringify(importedScene));
        storage.set(P + 'sceneKeys', JSON.stringify(sceneKeys));
        return true;
      } catch (e) { return false; }
    }
    function ensureDurable() {
      if (!persist() ||
          storage.get(P + 'snapshot') !== JSON.stringify(snapshot) ||
          storage.get(P + 'outbox') !== JSON.stringify(outbox) ||
          storage.get(P + 'cursor') !== JSON.stringify(cursor) ||
          storage.get(P + 'importKey') !== JSON.stringify(importKey) ||
          storage.get(P + 'importSource') !== JSON.stringify(importSource) ||
          storage.get(P + 'importMap') !== JSON.stringify(importMap) ||
          storage.get(P + 'importedScene') !== JSON.stringify(importedScene) ||
          storage.get(P + 'sceneKeys') !== JSON.stringify(sceneKeys)) {
        throw new Error('local sync state could not be saved');
      }
    }

    var snapshot = load('snapshot', {});       /* key -> {v: version, h: hash} */
    var outbox = load('outbox', {});           /* key -> op */
    var dead = load('dead', []);               /* ops that exhausted retries */
    var cursor = load('cursor', 0);
    var importKey = load('importKey', null);
    var importSource = load('importSource', null);
    var importMap = load('importMap', null);
    var importedScene = load('importedScene', null);
    var sceneKeys = load('sceneKeys', null); /* IDs in the last verified saved scene */
    var undoStack = [];                        /* element-scoped deltas, session-only */

    var engine = { scene: [] };

    function hashOf(op) { return op.deleted ? '"\\deleted"' : hash(op.payload); }

    /* one-time first sync: remap ids, import, seed the snapshot at version 1 */
    async function importScene(els, key) {
      importKey = key || importKey || newKey(24);
      if (!importedScene || !importMap || !importSource) {
        importSource = clone(els || []);
        importMap = Object.create(null);
        importedScene = [];
        importSource.forEach(function (el) {
          if (!el || deviceOnly(el)) return; /* built apps never travel */
          var id = newKey();
          importMap[el.id] = id;
          importedScene.push(Object.assign({}, el, { id: id }));
        });
      }
      /* Save the key and remapping before the request. A committed import can
         lose its reply; retry must send the same scene and key. */
      ensureDurable();
      var scene = importedScene;
      engine.scene = scene;
      var serverBoardId = boardId;
      if (transport.importBoard) serverBoardId = (await transport.importBoard(boardId, scene, importKey)) || boardId;
      scene.forEach(function (el) { snapshot[el.id] = { v: 1, h: hash(el) }; });
      persist();
      return { scene: scene, importKey: importKey, boardId: serverBoardId };
    }

    /* An import may commit while its reply is lost. Keep edits made to the
       original local board during that outage, using the persisted id mapping. */
    function reconcileImport(localEls) {
      if (!importSource || !importMap) return;
      var original = Object.create(null), current = Object.create(null);
      var mapped = Object.create(null);
      importSource.forEach(function (el) { if (el && el.id) original[el.id] = el; });
      (localEls || []).forEach(function (el) { if (el && el.id) current[el.id] = el; });
      var next = engine.scene.slice();
      Object.keys(importMap).forEach(function (oldId) {
        var newId = importMap[oldId];
        mapped[newId] = true;
        var i = next.findIndex(function (el) { return el.id === newId; });
        var local = current[oldId] || current[newId];
        if (!local) {
          if (i >= 0) next.splice(i, 1);
        } else if (hash(Object.assign({}, local, { id: oldId })) !== hash(original[oldId])) {
          var updated = Object.assign({}, local, { id: newId });
          if (i >= 0) next[i] = updated;
        }
      });
      Object.keys(current).forEach(function (oldId) {
        var el = current[oldId];
        if (deviceOnly(el)) { next.push(el); return; }
        if (original[oldId] || mapped[oldId]) return;
        next.push(Object.assign({}, el, { id: newKey() }));
      });
      engine.scene = next;
      diff(next);
    }
    function clearImportPending() {
      importSource = null;
      importMap = null;
      importedScene = null;
      persist();
    }

    /* attach to a board that already exists server-side (second device) */
    function attachRemote() { persist(); }

    /* a returning device already holds a scene: load it BEFORE pulling so the
       delta merges into it. Without this the scene starts empty, the delta
       replaces the whole board, and the next diff() tombstones every key the
       snapshot knows but the scene lacks - for every member. */
    function seedScene(els) { engine.scene = (els || []).slice(); }
    function markSceneSaved(els) {
      sceneKeys = {};
      (els || []).forEach(function (el) { if (el && el.id) sceneKeys[el.id] = true; });
      persist();
    }

    /* save() hook: diff the current scene against the last-synced snapshot.
       Returns the ops queued by this call. One queued op per key; latest intent wins. */
    function diff(scene) {
      engine.scene = scene;
      var ops = [], seen = {}, i, el, h, snap, op;
      for (i = 0; i < scene.length; i++) {
        el = scene[i];
        if (!el || !el.id) continue;
        if (deviceOnly(el)) continue;
        seen[el.id] = true;
        h = hash(el);
        snap = snapshot[el.id];
        if (!snap) {
          if (outbox[el.id] && !outbox[el.id].deleted && hash(outbox[el.id].payload) === h) continue;
          op = { element_key: el.id, base_version: 0, type: el.type, payload: clone(el), tries: 0, nextAt: 0 };
          outbox[el.id] = op; ops.push(op);
        } else if (snap.h !== h) {
          if (outbox[el.id] && !outbox[el.id].deleted && hash(outbox[el.id].payload) === h) continue;
          op = { element_key: el.id, base_version: snap.v, payload: clone(el), tries: 0, nextAt: 0 };
          outbox[el.id] = op; ops.push(op);
        } else if (outbox[el.id]) {
          /* Undo before a flush returned to the acknowledged state. Sending
             the stale edit or delete would contradict what is now visible. */
          delete outbox[el.id];
        }
      }
      Object.keys(snapshot).forEach(function (k) {
        if (seen[k]) return;
        if (outbox[k] && outbox[k].base_version === 0 && !outbox[k].deleted) {
          delete outbox[k]; /* created and removed before ever syncing: cancel */
          return;
        }
        if (outbox[k] && outbox[k].deleted && outbox[k].base_version === snapshot[k].v) return;
        op = { element_key: k, base_version: snapshot[k].v, deleted: true, tries: 0, nextAt: 0 };
        outbox[k] = op; ops.push(op);
      });
      persist();
      return ops;
    }

    /* explicit compensating upserts (element-scoped undo): exactly the given
       elements are queued with their prior states; nothing else is touched. */
    function queueExplicit(elements, deleted) {
      (elements || []).forEach(function (el) {
        var snap = snapshot[el.id];
        var op = deleted
          ? { element_key: el.id, base_version: snap ? snap.v : 0, deleted: true, tries: 0, nextAt: 0 }
          : { element_key: el.id, base_version: snap ? snap.v : 0, type: el.type, payload: clone(el), tries: 0, nextAt: 0 };
        outbox[el.id] = op;
      });
      persist();
    }

    /* undo stack records per-action element deltas on synced boards;
       remote merges are never recorded here, so they are never undone. */
    function recordLocalChange(deltas) { undoStack.push(deltas); if (undoStack.length > 60) undoStack.shift(); }
    function undoLast() {
      var deltas = undoStack.pop();
      if (!deltas) return false;
      deltas.forEach(function (d) {
        var idx = engine.scene.findIndex(function (e) { return e.id === (d.before || d.after).id; });
        if (d.after == null) {              /* undo a delete: re-add */
          var back = clone(d.before);
          if (idx < 0) engine.scene.push(back);
          queueExplicit([back]);
        } else if (d.before == null) {      /* undo an add: remove */
          if (idx >= 0) engine.scene.splice(idx, 1);
          if (snapshot[d.after.id]) queueExplicit([d.after], true);
          else delete outbox[d.after.id];
        } else {                            /* undo an edit: restore prior state */
          var prior = clone(d.before);
          if (idx >= 0) engine.scene[idx] = prior; else engine.scene.push(prior);
          queueExplicit([prior]);
        }
      });
      persist();
      return true;
    }

    /* wholesale loads (templates, adoptBoard): merge by id as upserts with
       fresh collision-resistant keys; existing elements are untouched. */
    function loadWholesale(elements) {
      var added = [];
      (elements || []).forEach(function (el) {
        if (!el || (el.type === 'embed' && el.kind === 'app')) return;
        var copy = Object.assign({}, el, { id: newKey() });
        engine.scene.push(copy);
        added.push(copy);
      });
      queueExplicit(added);
      return added;
    }

    /* inbound rows are untrusted: sanitize first, then merge by version.
       Tombstones always win. force is for post-conflict reconciliation. */
    function applyRemoteRows(rows, opts) {
      var force = opts && opts.force;
      var applied = 0, ignored = 0;
      var clean = sanitize(rows || []) || [];
      clean.forEach(function (row) {
        var key = row.element_key;
        if (row.deleted_at) {
          var i = engine.scene.findIndex(function (e) { return e.id === key; });
          if (i >= 0) { engine.scene.splice(i, 1); applied++; }
          delete snapshot[key];
          delete outbox[key]; /* server state wins over a queued local op */
          return;
        }
        var snap = snapshot[key];
        if (!force && snap && snap.v >= row.version) {
          /* A scene write can fail while the snapshot/cursor still persist.
             A full pull must put that row back before diff can mistake the
             missing local copy for a user deletion. */
          if (!(opts && opts.restoreMissing) ||
              engine.scene.some(function (e) { return e.id === key; }) ||
              (sceneKeys && sceneKeys[key] && !(opts && opts.discardScene)) ||
              dead.some(function (op) { return op.element_key === key && op.deleted; }) ||
              (outbox[key] && outbox[key].deleted)) { ignored++; return; }
        }
        var el = Object.assign({}, row.payload, { id: key, type: row.type });
        var j = engine.scene.findIndex(function (e) { return e.id === key; });
        if (j >= 0) engine.scene[j] = el; else engine.scene.push(el);
        snapshot[key] = { v: row.version, h: hash(el) };
        applied++;
      });
      persist();
      return { scene: engine.scene, applied: applied, ignored: ignored };
    }

    /* pull deltas since the cursor (minus overlap) and merge them */
    async function pull(full, discardScene) {
      var rows = await transport.pull(boardId, full ? 0 : Math.max(0, cursor - OVERLAP_MS));
      var maxTs = cursor;
      (rows || []).forEach(function (r) { if (r.updated_at > maxTs) maxTs = r.updated_at; });
      var res = applyRemoteRows(rows, { restoreMissing: !!full, discardScene: !!discardScene });
      if (full) {
        /* Tombstones may have been hard-deleted while a device was away.
           Only keys already known to be server-backed can be absent here;
           unsynced local creations and device-only apps are left alone. */
        var present = {};
        (rows || []).forEach(function (r) { present[r.element_key] = true; });
        Object.keys(snapshot).forEach(function (key) {
          if (present[key]) return;
          engine.scene = engine.scene.filter(function (el) { return el.id !== key; });
          delete snapshot[key];
          delete outbox[key];
        });
        res.scene = engine.scene;
      }
      cursor = maxTs;
      persist();
      return res;
    }

    /* A returning device may have lost its last scene write independently of
       its snapshot. Recheck every row without throwing away pending edits. */
    function pullAll(discardScene) { return pull(true, discardScene); }

    /* opening a board this engine has no trusted local state for: forget any
       persisted snapshot/outbox/cursor and fetch everything */
    async function pullFull() {
      Object.keys(snapshot).forEach(function (k) { delete snapshot[k]; });
      Object.keys(outbox).forEach(function (k) { delete outbox[k]; });
      cursor = 0;
      return pull();
    }

    /* post-conflict: re-pull exactly those keys, server state wins */
    async function reconcile(keys) {
      var rows = await transport.pull(boardId, 0, keys);
      applyRemoteRows(rows, { force: true });
      var present = {};
      (rows || []).forEach(function (r) { present[r.element_key] = true; });
      (keys || []).forEach(function (key) {
        if (present[key]) return;
        engine.scene = engine.scene.filter(function (el) { return el.id !== key; });
        delete snapshot[key];
        delete outbox[key];
      });
      persist();
    }

    /* attempt everything queued. Explicit calls ignore advisory backoff;
       automatic flushing should honor nextFlushAt(). */
    async function flush() {
      var due = Object.keys(outbox).map(function (k) { return outbox[k]; });
      var report = { sent: 0, conflicts: 0, dead: 0 };
      if (!due.length) return report;
      var results;
      try {
        results = await transport.upsert(boardId, due.map(function (o) {
          var w = { element_key: o.element_key, base_version: o.base_version };
          if (o.type) w.type = o.type;
          if (o.payload) w.payload = o.payload;
          if (o.deleted) w.deleted = true;
          return w;
        }));
      } catch (e) {
        due.forEach(function (o) {
          o.tries++;
          if (o.tries > MAX_TRIES) {
            delete outbox[o.element_key];
            dead.push(o); report.dead++;
            onDeadLetter([o]);
          } else {
            o.nextAt = now() + (BACKOFF_MS[Math.min(o.tries, BACKOFF_MS.length) - 1] || 30000);
          }
        });
        persist();
        return report;
      }
      var conflictKeys = [], rejected = [];
      results.forEach(function (r) {
        var op = outbox[r.element_key];
        if (!op) return;
        if (r.status === 'ok') {
          delete outbox[r.element_key];
          if (op.deleted) delete snapshot[r.element_key];
          else snapshot[r.element_key] = { v: r.version, h: hashOf(op) };
          report.sent++;
        } else if (r.status === 'conflict') {
          delete outbox[r.element_key];
          conflictKeys.push(r.element_key);
          report.conflicts++;
        } else {
          delete outbox[r.element_key];
          rejected.push(op); report.dead++;
        }
      });
      if (rejected.length) { dead.push.apply(dead, rejected); onDeadLetter(rejected); }
      if (conflictKeys.length) {
        await reconcile(conflictKeys);
        onConflict(conflictKeys);
      }
      persist();
      return report;
    }

    function outboxOps() { return Object.keys(outbox).map(function (k) { return outbox[k]; }); }
    function deadLetters() { return dead.slice(); }
    function retryDeadLetters() {
      dead.forEach(function (o) { o.tries = 0; o.nextAt = 0; outbox[o.element_key] = o; });
      dead = [];
      persist();
    }
    function nextFlushAt() {
      var t = null;
      Object.keys(outbox).forEach(function (k) { var o = outbox[k]; if (t === null || o.nextAt < t) t = o.nextAt; });
      return t;
    }

    engine.importScene = importScene;
    engine.ensureDurable = ensureDurable;
    engine.reconcileImport = reconcileImport;
    engine.clearImportPending = clearImportPending;
    engine.attachRemote = attachRemote;
    engine.diff = diff;
    engine.flush = flush;
    engine.pull = pull;
    engine.pullAll = pullAll;
    engine.pullFull = pullFull;
    engine.seedScene = seedScene;
    engine.markSceneSaved = markSceneSaved;
    engine.applyRemoteRows = applyRemoteRows;
    engine.recordLocalChange = recordLocalChange;
    engine.undoLast = undoLast;
    engine.loadWholesale = loadWholesale;
    engine.queueExplicit = queueExplicit;
    engine.outboxOps = outboxOps;
    engine.deadLetters = deadLetters;
    engine.retryDeadLetters = retryDeadLetters;
    engine.nextFlushAt = nextFlushAt;
    engine.rebindBoardId = rebindBoardId;
    engine.newKey = newKey;
    engine._snapshot = snapshot;
    return engine;
  }

  return { create: create, newKey: newKey, MAX_TRIES: MAX_TRIES, OVERLAP_MS: OVERLAP_MS };
});
