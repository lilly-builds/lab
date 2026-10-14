/* node ideas/ai-whiteboard/sync.test.js
   U4: flag resolution, lazy boot, circuit-breaker fail-open, first-sync flow.
   Fake app surface + fake supabase module; no DOM, no network. */
const assert = require('assert');
const sync = require('./sync.js');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
function fakeApp(scene) {
  return {
    _els: scene || [],
    getEls() { return this._els; },
    setEls(v) { this._els = v; },
    draw() {}, save() {}, clearUndo() { this.undoCleared = (this.undoCleared || 0) + 1; },
    loadEls(arr) { return arr.filter((e) => e && e.type); },
    afterSave: null, newId: null, adoptBoard: null
  };
}
function savingApp(scene, storage) {
  const app = fakeApp(scene);
  app.save = function () {
    try { storage.setItem('aiwb.scene', JSON.stringify(this._els)); } catch (e) {}
    if (this.afterSave) this.afterSave();
  };
  return app;
}
function fakeSupabaseModule(server) {
  /* mirrors the RPC + table API surface sync.js uses, over an in-memory store */
  const rows = server.rows;
  server.clock = server.clock || 1000000; /* shared across sessions: two devices, one timeline */
  const client = {
    auth: {
      getSession: async () => { if (server.down) throw new Error('down'); return { data: { session: server.signedIn ? { user: { id: 'u1' } } : null } }; },
      signInAnonymously: async () => { if (server.down) throw new Error('down'); server.signedIn = true; return { data: {}, error: null }; }
    },
    rpc: async (fn, args) => {
      if (server.down) throw new Error('down');
      server.clock += 50;
      if (fn === 'import_board') {
        if (server.imports.has(args.p_import_key)) return { data: server.imports.get(args.p_import_key), error: null };
        const id = 'board-' + (server.imports.size + 1);
        server.imports.set(args.p_import_key, id);
        /* SQL preserves the client's remapped key; it remaps only legacy ids. */
        args.p_scene.forEach((el) => {
          const key = el.id;
          rows.set(key, { element_key: key, board_id: id, type: el.type, payload: JSON.parse(JSON.stringify(el)), version: 1, updated_at: new Date(server.clock).toISOString(), deleted_at: null });
        });
        if (args.p_juice_balance > 0) { server.juiceImport = args.p_juice_balance; server.juiceBalance = args.p_juice_balance; }
        if (server.dropImportReplyOnce) { server.dropImportReplyOnce = false; throw new Error('reply lost after commit'); }
        return { data: id, error: null };
      }
      if (fn === 'earn_juice') {
        if (server.idem.has(args.p_idempotency_key)) return { data: [{ event_id: server.idem.get(args.p_idempotency_key), amount: 1, already_earned: true }], error: null };
        const note = rows.get(args.p_note_key);
        if (!note || note.deleted_at) return { data: null, error: { message: 'note not found' } };
        if (note.payload.l1Done !== true) return { data: null, error: { message: 'note is not completed' } };
        server.earnSeq += 1; server.idem.set(args.p_idempotency_key, server.earnSeq); server.juiceBalance += 1;
        return { data: [{ event_id: server.earnSeq, amount: 1, already_earned: false }], error: null };
      }
      if (fn === 'upsert_elements') {
        if (server.beforeUpsert) await server.beforeUpsert(args);
        const out = args.p_elements.map((op) => {
          const cur = rows.get(op.element_key);
          if (!op.base_version) {
            if (cur) return { element_key: op.element_key, version: null, status: 'conflict' };
            rows.set(op.element_key, { element_key: op.element_key, board_id: args.p_board_id, type: op.type, payload: op.payload, version: 1, updated_at: new Date(++server.clock).toISOString(), deleted_at: null });
            return { element_key: op.element_key, version: 1, status: 'ok' };
          }
          if (!cur || cur.version !== op.base_version || cur.deleted_at) return { element_key: op.element_key, version: null, status: cur && cur.deleted_at && op.deleted ? 'ok' : 'conflict' };
          if (op.payload) cur.payload = op.payload;
          if (op.deleted) cur.deleted_at = new Date(++server.clock).toISOString();
          cur.version += 1; cur.updated_at = new Date(++server.clock).toISOString();
          return { element_key: op.element_key, version: cur.version, status: 'ok' };
        });
        return { data: out, error: null };
      }
      throw new Error('unknown rpc ' + fn);
    },
    from: (table) => table === 'juice_balances' ? ({
      select: () => ({ eq: () => ({ eq: () => ({ then: (res) => Promise.resolve({ data: [{ balance: server.juiceBalance }], error: null }).then(res) }) }) })
    }) : ({ select: () => {
      const q = { boardId: null, sinceIso: null, afterKey: null, afterTs: null, keys: null, max: null, sort: [] };
      const builder = {
        eq(k, v) { if (k === 'board_id') q.boardId = v; return this; },
        gt(k, v) { if (k === 'updated_at') q.sinceIso = v; if (k === 'element_key') q.afterKey = v; return this; },
        in(k, v) { q.keys = v; return this; },
        order(k) { q.sort.push(k); return this; },
        or(filter) {
          const m = /^updated_at\.gt\.([^,]+),and\(updated_at\.eq\.([^,]+),element_key\.gt\.([A-Za-z0-9_-]+)\)$/.exec(filter);
          if (!m || m[1] !== m[2]) throw new Error('bad composite cursor: ' + filter);
          q.afterTs = m[1]; q.afterKey = m[3]; return this;
        },
        limit(n) { q.max = n; return this; },
        then(resolve, reject) { return exec(q).then(resolve, reject); }
      };
      return builder;
    } }),
    channel: () => { throw new Error('no realtime in fake'); }
  };
  async function exec(q) {
    if (server.down) throw new Error('down');
    if (server.failPullBoardOnce === q.boardId) {
      server.failPullBoardOnce = null;
      throw new Error('pull failed');
    }
    const since = Date.parse(q.sinceIso);
    let out = [...rows.values()].filter((r) => (!r.board_id || r.board_id === q.boardId) && Date.parse(r.updated_at) > since);
    if (q.keys) out = out.filter((r) => q.keys.includes(r.element_key));
    if (q.afterTs) out = out.filter((r) => r.updated_at > q.afterTs || (r.updated_at === q.afterTs && r.element_key > q.afterKey));
    else if (q.afterKey) out = out.filter((r) => r.element_key > q.afterKey);
    out.sort((a, b) => q.sort[0] === 'updated_at'
      ? a.updated_at.localeCompare(b.updated_at) || a.element_key.localeCompare(b.element_key)
      : a.element_key.localeCompare(b.element_key));
    out = out.slice(0, Math.min(q.max || 1000, server.maxRows || 1000)).map((r) => JSON.parse(JSON.stringify(r)));
    if (server.afterPull) server.afterPull(q, out);
    return { data: out, error: null };
  }
  return { createClient: () => client };
}
const mkServer = () => ({ rows: new Map(), imports: new Map(), down: false, idem: new Map(), earnSeq: 0, juiceBalance: 0 });

/* ---- multi-device helpers (regression tests for the returning-device and cloud-choice bugs) ---- */
const CFG = { url: 'https://x.supabase.co', anonKey: 'k' };
const mkNote = (id, text) => ({ id, type: 'note', x: 0, y: 0, w: 1, h: 1, text });
const until = async (fn, ms = 2000) => {
  const s = Date.now();
  while (!fn()) { if (Date.now() - s > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); }
};
function openDevice(server, storage, app) {
  const sess = sync.createSession({ config: CFG, app, storage, loadSupabase: async () => fakeSupabaseModule(server), timeoutMs: 100 });
  return { sess, storage, app };
}
/* a device that has done its first sync: 3 notes imported, ids remapped */
async function firstDevice(server) {
  const storage = memStorage();
  const dev = openDevice(server, storage, savingApp([mkNote('e1', 'one'), mkNote('e2', 'two'), mkNote('e3', 'three')], storage));
  dev.app.save();
  await until(() => dev.sess.state === 'online');
  dev.boardId = dev.storage.getItem('aiwb.board');
  return dev;
}
/* a second device (same board id, e.g. via invite or sign-in) with an empty scene: full pull on start */
async function joinDevice(server, boardId) {
  const storage = memStorage(); storage.setItem('aiwb.board', boardId);
  const dev = openDevice(server, storage, fakeApp([]));
  await until(() => dev.sess.state === 'online');
  dev.boardId = boardId;
  return dev;
}
/* A returning device keeps its cursor: park it just past everything the server has now, so the
   next pull on that device is a true delta (the case a cursor-0 full pull hides). */
function parkCursor(server, dev) {
  server.clock += 100000; /* everything so far is now old news */
  dev.storage.setItem('aiwb.sync.' + dev.boardId + '.cursor', JSON.stringify(server.clock + 6000)); /* pull sends cursor - 5s overlap */
  server.clock += 20000;  /* whatever happens next is strictly newer than the parked cursor */
}
/* "close the tab, reopen it": same storage, scene read back from the saved copy */
async function reloadDevice(server, dev) {
  const saved = JSON.parse(JSON.stringify(dev.app._els));
  const next = openDevice(server, dev.storage, fakeApp(saved));
  await until(() => next.sess.state === 'online');
  next.boardId = dev.boardId;
  return next;
}
const live = (server, boardId) => [...server.rows.values()].filter((r) => r.board_id === boardId && !r.deleted_at);
const tombs = (server, boardId) => [...server.rows.values()].filter((r) => r.board_id === boardId && r.deleted_at);

const tests = [
  ['flag: ?sync=off always wins, then ?sync=on, then config default', async () => {
    assert.strictEqual(sync.resolveFlag('?sync=off', true), false);
    assert.strictEqual(sync.resolveFlag('?sync=off&sync=on', true), false);
    assert.strictEqual(sync.resolveFlag('?sync=on', false), true);
    assert.strictEqual(sync.resolveFlag('', true), true);
    assert.strictEqual(sync.resolveFlag('', false), false);
    assert.strictEqual(sync.resolveFlag('', undefined), false);
  }],
  ['flag off: boot does nothing - no supabase fetch, no app touch (AE1)', async () => {
    let loaded = 0;
    const win = {
      location: { search: '' }, AIWB_SUPABASE: { enabled: false }, document: { readyState: 'complete' },
      addEventListener() {}, AIWB: fakeApp([{ id: 'e1', type: 'note' }]), localStorage: memStorage()
    };
    const orig = sync.createSession;
    sync.createSession = () => { loaded++; return orig.apply(null, arguments); };
    sync.boot(win);
    sync.createSession = orig;
    assert.strictEqual(loaded, 0, 'no session created');
    assert.strictEqual(win.AIWB_SYNC, undefined);
    assert.strictEqual(win.AIWB.afterSave, null, 'app surface untouched');
  }],
  ['flag on, backend down: circuit opens within the timeout, app keeps working (AE6)', async () => {
    const server = mkServer(); server.down = true;
    const app = fakeApp([{ id: 'e1', type: 'note', x: 0, y: 0, w: 1, h: 1, text: 'hi' }]);
    const storage = memStorage();
    const s0 = Date.now();
    const sess = sync.createSession({
      config: { url: 'https://x.supabase.co', anonKey: 'k' }, app, storage,
      loadSupabase: async () => fakeSupabaseModule(server), timeoutMs: 40
    });
    sess.onSave();
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(sess.state, 'offline', 'failed open');
    assert(Date.now() - s0 < 3000, 'within the 2-3s budget');
    app._els[0].text = 'still local';
    sess.onSave(); /* no throw, stays local */
    assert.strictEqual(app._els[0].text, 'still local');
  }],
  ['first import stays local if its recovery key cannot be saved', async () => {
    const server = mkServer();
    const storage = { getItem() { return null; }, setItem() { throw new Error('quota'); } };
    const app = fakeApp([mkNote('e1', 'safe locally')]);
    const sess = openDevice(server, storage, app).sess;
    sess.onSave();
    await until(() => sess.state === 'offline');
    assert.strictEqual(server.imports.size, 0, 'no irreversible write without a durable key');
    assert.strictEqual(app._els[0].text, 'safe locally');
  }],
  ['first sync: scene imports, ids remap, board id stored; raced import dedupes', async () => {
    const server = mkServer();
    const storage = memStorage();
    const app = savingApp([
      { id: 'e1', type: 'note', x: 0, y: 0, w: 1, h: 1, text: 'a' },
      { id: 'e2', type: 'note', x: 5, y: 5, w: 1, h: 1, text: 'b' }
    ], storage);
    storage.setItem('aiwb.juice', '3');
    const sess = sync.createSession({
      config: { url: 'https://x.supabase.co', anonKey: 'k' }, app, storage,
      loadSupabase: async () => fakeSupabaseModule(server), timeoutMs: 100
    });
    app.save();
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(sess.state, 'online');
    const boardId = storage.getItem('aiwb.board');
    assert(boardId, 'board id stored');
    assert.strictEqual(server.rows.size, 2, 'scene fanned out to rows');
    assert([...server.rows.keys()].every((k) => !/^e\d+$/.test(k)), 'ids remapped');
    assert.strictEqual(server.juiceImport, 3, 'juice balance backfilled at import');
    assert(app._els.every((e) => !/^e\d+$/.test(e.id)), 'local scene rebound to new ids');
    assert(app._els.every((e) => server.rows.has(e.id)), 'local ids match persisted keys');
    /* retry with the same import key dedupes server-side */
    const again = await fakeSupabaseModule(server).createClient().rpc('import_board', { p_scene: [], p_import_key: [...server.imports.keys()][0], p_juice_balance: 0 });
    assert.strictEqual(again.data, boardId, 'same board returned');
  }],
  ['committed import with lost reply reuses the same key and board after reload', async () => {
    const server = mkServer(); server.dropImportReplyOnce = true;
    const storage = memStorage();
    const app = savingApp([mkNote('e1', 'once'), mkNote('e9', 'remove while offline')], storage);
    const first = openDevice(server, storage, app);
    app.save();
    await until(() => first.sess.state === 'offline');
    assert.strictEqual(server.imports.size, 1, 'server committed once');
    assert.strictEqual(storage.getItem('aiwb.board'), null, 'no board id before a reply');
    const storedKey = JSON.parse(storage.getItem('aiwb.sync.local.importKey'));
    assert(server.imports.has(storedKey), 'key survived the lost response');
    app._els[0].text = 'edited while offline';
    app._els.splice(1, 1);
    app._els.push(mkNote('e2', 'added while offline'));
    app.save();
    const retried = openDevice(server, storage, app);
    retried.sess.onSave();
    await until(() => retried.sess.state === 'online');
    assert.strictEqual(server.imports.size, 1, 'retry did not create a second board');
    assert.strictEqual(app._els.length, 2, 'offline edits survive the retry');
    assert(app._els.some((e) => e.text === 'edited while offline'));
    assert(app._els.some((e) => e.text === 'added while offline'));
    assert(app._els.every((e) => server.rows.has(e.id)), 'retried elements match persisted keys');
    assert.strictEqual([...server.rows.values()].filter((r) => !r.deleted_at).length, 2);
    assert.strictEqual([...server.rows.values()].filter((r) => r.deleted_at).length, 1, 'offline deletion is retained');
    assert.strictEqual(storage.getItem('aiwb.sync.local.importSource'), null, 'temporary import copy released');
  }],
  ['failed remapped-scene save does not duplicate imported notes on retry', async () => {
    const server = mkServer(); const base = memStorage(); let failScene = false;
    const storage = { ...base, setItem(k, v) { if (failScene && k === 'aiwb.scene') throw new Error('quota'); base.setItem(k, v); } };
    const app = savingApp([mkNote('e1', 'one'), mkNote('e2', 'two')], storage);
    app.save(); failScene = true;
    const first = openDevice(server, storage, app);
    first.sess.onSave(); await until(() => first.sess.state === 'offline');
    assert.strictEqual(storage.getItem('aiwb.board'), null, 'not bound before scene is durable');
    assert.strictEqual(server.imports.size, 1, 'server import did commit');
    failScene = false;
    const returned = openDevice(server, storage, savingApp(JSON.parse(storage.getItem('aiwb.scene')), storage));
    returned.sess.onSave(); await until(() => returned.sess.state === 'online');
    assert.strictEqual(server.imports.size, 1, 'same server board reused');
    assert.strictEqual(live(server, storage.getItem('aiwb.board')).length, 2);
    assert(returned.app._els.every((e) => server.rows.has(e.id)), 'legacy IDs were not uploaded');
  }],
  ['failed board-id save after remapping retries without reimporting or duplicating', async () => {
    const server = mkServer(); const base = memStorage(); let failBoard = true;
    const storage = { ...base, setItem(k, v) { if (failBoard && k === 'aiwb.board') throw new Error('quota'); base.setItem(k, v); } };
    const app = savingApp([mkNote('e1', 'one'), mkNote('e2', 'two')], storage);
    const first = openDevice(server, storage, app);
    app.save(); await until(() => first.sess.state === 'offline');
    assert.strictEqual(storage.getItem('aiwb.board'), null);
    assert(app._els.every((e) => server.rows.has(e.id)), 'remapped scene was saved first');
    failBoard = false;
    const returned = openDevice(server, storage, savingApp(JSON.parse(storage.getItem('aiwb.scene')), storage));
    returned.sess.onSave(); await until(() => returned.sess.state === 'online');
    assert.strictEqual(server.imports.size, 1);
    assert.strictEqual(live(server, storage.getItem('aiwb.board')).length, 2);
    assert(returned.app._els.every((e) => server.rows.has(e.id)));
  }],
  ['fresh device loads every row beyond the API default limit, including tombstones', async () => {
    const server = mkServer(); server.maxRows = 1000;
    for (let i = 0; i < 2050; i++) {
      const id = 'k' + String(i).padStart(4, '0');
      server.rows.set(id, { element_key: id, board_id: 'large-board', type: 'note',
        payload: mkNote(id, id), version: 1, updated_at: new Date(1005000).toISOString(), deleted_at: i < 50 ? new Date(1005000).toISOString() : null });
    }
    const device = await joinDevice(server, 'large-board');
    assert.strictEqual(device.app._els.length, 2000, 'all live rows loaded');
    assert(!device.app._els.some((e) => e.id === 'k0000'), 'tombstone stays deleted');
    assert(device.app._els.some((e) => e.id === 'k2049'), 'last page loaded');
  }],
  ['returning device restores missing rows instead of deleting them after a failed scene save', async () => {
    const server = mkServer();
    for (let i = 0; i < 2; i++) {
      const id = 'saved' + i;
      server.rows.set(id, { element_key: id, board_id: 'board-safe', type: 'note', payload: mkNote(id, id),
        version: 1, updated_at: new Date(1005000).toISOString(), deleted_at: null });
    }
    const base = memStorage(); base.setItem('aiwb.board', 'board-safe');
    const storage = { ...base, setItem(k, v) { if (k === 'aiwb.scene') throw new Error('quota'); base.setItem(k, v); } };
    const first = openDevice(server, storage, savingApp([], storage));
    await until(() => first.sess.state === 'online');
    assert.strictEqual(storage.getItem('aiwb.scene'), null, 'the local scene write failed');
    const returned = openDevice(server, storage, savingApp([], storage));
    await until(() => returned.sess.state === 'online');
    assert.strictEqual(returned.app._els.length, 2, 'authoritative rows restored on reload');
    returned.app._els.push(mkNote('new-local', 'new'));
    returned.app.save(); await returned.sess.flush();
    assert.strictEqual(tombs(server, 'board-safe').length, 0, 'no remote rows deleted');
    assert.strictEqual(live(server, 'board-safe').length, 3);
  }],
  ['a saved offline deletion survives the returning full pull', async () => {
    const server = mkServer();
    server.rows.set('keep', { element_key: 'keep', board_id: 'offline-board', type: 'note', payload: mkNote('keep', 'keep'),
      version: 1, updated_at: new Date(1005000).toISOString(), deleted_at: null });
    server.rows.set('gone', { element_key: 'gone', board_id: 'offline-board', type: 'note', payload: mkNote('gone', 'gone'),
      version: 1, updated_at: new Date(1005000).toISOString(), deleted_at: null });
    const storage = memStorage(); storage.setItem('aiwb.board', 'offline-board');
    const first = openDevice(server, storage, savingApp([], storage));
    await until(() => first.sess.state === 'online');
    server.down = true;
    const offline = openDevice(server, storage, savingApp(JSON.parse(storage.getItem('aiwb.scene')), storage));
    await until(() => offline.sess.state === 'offline');
    offline.app._els = offline.app._els.filter((el) => el.id !== 'gone');
    offline.app.save();
    assert(offline.sess.engine.outboxOps().some((op) => op.element_key === 'gone' && op.deleted));
    server.down = false;
    const returned = openDevice(server, storage, savingApp(JSON.parse(storage.getItem('aiwb.scene')), storage));
    await until(() => returned.sess.state === 'online');
    assert(!returned.app._els.some((el) => el.id === 'gone'), 'local deletion not restored');
    await returned.sess.flush();
    assert(server.rows.get('gone').deleted_at, 'deletion reached the server');
  }],
  ['a deletion saved with the sync kill switch stays deleted when re-enabled', async () => {
    const server = mkServer(); const storage = memStorage();
    const app = savingApp([mkNote('e1', 'keep'), mkNote('e2', 'delete while off')], storage);
    const first = openDevice(server, storage, app);
    app.save(); await until(() => first.sess.state === 'online');
    const gone = app._els.find((e) => e.text === 'delete while off').id;
    const disabled = savingApp(JSON.parse(storage.getItem('aiwb.scene')), storage);
    disabled._els = disabled._els.filter((e) => e.id !== gone);
    disabled.save(); /* ?sync=off installs no afterSave hook */
    const returned = openDevice(server, storage, savingApp(JSON.parse(storage.getItem('aiwb.scene')), storage));
    await until(() => returned.sess.state === 'online');
    assert(!returned.app._els.some((e) => e.id === gone), 'kill-switch deletion not restored');
    await returned.sess.flush();
    assert(server.rows.get(gone).deleted_at, 'deletion reaches the server on return');
  }],
  ['a purged remote tombstone does not leave an old local ghost', async () => {
    const server = mkServer();
    const storage = memStorage(); storage.setItem('aiwb.board', 'purge-board');
    server.rows.set('gone', { element_key: 'gone', board_id: 'purge-board', type: 'note', payload: mkNote('gone', 'old'),
      version: 1, updated_at: new Date(1005000).toISOString(), deleted_at: null });
    const first = openDevice(server, storage, savingApp([], storage));
    await until(() => first.sess.state === 'online');
    server.rows.delete('gone'); /* 30-day purge happened while the tab was closed */
    const returned = openDevice(server, storage, savingApp(JSON.parse(storage.getItem('aiwb.scene')), storage));
    await until(() => returned.sess.state === 'online');
    assert.strictEqual(returned.app._els.length, 0, 'purged note removed locally');
    returned.app._els.push(mkNote('new-local', 'new'));
    returned.app.save(); await returned.sess.flush();
    assert(!server.rows.has('gone'), 'purged note not reuploaded');
  }],
  ['a concurrent edit to a passed page is still included by the pull cursor', async () => {
    const server = mkServer(); let pulls = 0;
    for (let i = 0; i < 1100; i++) {
      const id = 'k' + String(i).padStart(4, '0');
      server.rows.set(id, { element_key: id, board_id: 'paging-board', type: 'note', payload: mkNote(id, 'old'),
        version: 1, updated_at: new Date(1005000).toISOString(), deleted_at: null });
    }
    server.afterPull = () => {
      if (++pulls !== 1) return;
      const row = server.rows.get('k0000');
      row.payload = mkNote('k0000', 'edited during paging'); row.version = 2;
      row.updated_at = new Date(1008000).toISOString();
    };
    const device = await joinDevice(server, 'paging-board');
    assert.strictEqual(device.app._els.length, 1100);
    assert.strictEqual(device.app._els.find((e) => e.id === 'k0000').text, 'edited during paging');
  }],
  ['built apps stay on their device during first sync and never upload', async () => {
    const server = mkServer();
    const storage = memStorage();
    const app = savingApp([mkNote('e1', 'cloud'), { id: 'e2', type: 'embed', kind: 'app', html: '<p>local</p>' }], storage);
    const device = openDevice(server, storage, app);
    app.save(); await until(() => device.sess.state === 'online');
    assert(app._els.some((e) => e.kind === 'app'), 'built app remains locally visible');
    assert.strictEqual(live(server, device.storage.getItem('aiwb.board')).length, 1, 'only the note uploaded');
    device.sess.onSave(); await device.sess.flush();
    assert.strictEqual(live(server, device.storage.getItem('aiwb.board')).length, 1, 'later saves also skip it');
  }],
  ['edits made during first import flush are not replaced or lost', async () => {
    const server = mkServer(); let release;
    server.beforeUpsert = () => new Promise((resolve) => { release = resolve; });
    const storage = memStorage();
    const app = savingApp([mkNote('e1', 'original')], storage);
    server.afterPull = () => { app._els[0].text = 'intermediate'; app.save(); server.afterPull = null; };
    const device = openDevice(server, storage, app);
    device.sess.onSave();
    await until(() => typeof release === 'function');
    app._els[0].text = 'edited while uploading'; app.save();
    release(); server.beforeUpsert = null;
    await until(() => device.sess.state === 'online');
    await until(() => [...server.rows.values()].some((r) => r.payload.text === 'edited while uploading'), 3000);
    assert.strictEqual(app._els[0].text, 'edited while uploading');
  }],
  ['juice: online earn writes the ledger once; retry cannot double-count (AE4)', async () => {
    const server = mkServer();
    const storage = memStorage();
    const app = savingApp([{ id: 'e1', type: 'note', x: 0, y: 0, w: 1, h: 1, text: 'a' }], storage);
    const juice = { onEarn: null, bal: null, setBalance(n) { this.bal = n; } };
    storage.setItem('aiwb.juice', '3');
    const sess = sync.createSession({
      win: { Juice: juice },
      config: { url: 'https://x.supabase.co', anonKey: 'k' }, app, storage,
      loadSupabase: async () => fakeSupabaseModule(server), timeoutMs: 100
    });
    app.save(); /* first sync: import */
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(sess.state, 'online');
    assert(juice.onEarn, 'juice hook installed');
    /* complete the note: app saves first (element flush), then Juice.earn fires the hook */
    app._els[0].l1Done = true;
    sess.onSave();
    juice.onEarn(app._els[0]);
    await new Promise((r) => setTimeout(r, 700)); /* FLUSH_DEBOUNCE_MS is 400 */
    assert.strictEqual(server.idem.size, 1, 'one ledger event');
    assert.strictEqual(server.juiceBalance, 4, 'import backfill (3) + one earn');
    assert.strictEqual(juice.bal, 4, 'meter reads the ledger sum');
    /* a retry with the same key replays the original event, balance unmoved */
    const key = [...server.idem.keys()][0];
    const again = await fakeSupabaseModule(server).createClient().rpc('earn_juice', { p_board_id: 'b', p_note_key: app._els[0].id, p_idempotency_key: key });
    assert.strictEqual(again.data[0].already_earned, true);
    assert.strictEqual(server.juiceBalance, 4, 'no double count');
  }],
  ['juice: pre-first-sync earns are subsumed by the import backfill', async () => {
    const server = mkServer();
    const storage = memStorage();
    const app = savingApp([{ id: 'e1', type: 'note', x: 0, y: 0, w: 1, h: 1, text: 'a', l1Done: true }], storage);
    const juice = { onEarn: null, bal: null, setBalance(n) { this.bal = n; } };
    storage.setItem('aiwb.juice', '3');
    const sess = sync.createSession({
      win: { Juice: juice },
      config: { url: 'https://x.supabase.co', anonKey: 'k' }, app, storage,
      loadSupabase: async () => fakeSupabaseModule(server), timeoutMs: 100
    });
    juice.onEarn(app._els[0]); /* earn while still unsynced: queued with the e<n> key */
    app.save(); /* first sync imports and remaps ids */
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual(sess.state, 'online');
    assert.strictEqual(server.idem.size, 0, 'stale e-key earn dropped server-side, not counted');
    assert.strictEqual(server.juiceBalance, 3, 'import backfill only - the local balance already included that earn');
    assert.strictEqual(JSON.parse(storage.getItem('aiwb.juice.q') || '[]').length, 0, 'queue drained');
  }],
  ['returning synced device: pull on load merges remote rows', async () => {
    const server = mkServer();
    const storage = memStorage();
    storage.setItem('aiwb.board', 'board-1');
    server.rows.set('k1', { element_key: 'k1', type: 'note', payload: { id: 'k1', type: 'note', x: 1, y: 1, w: 2, h: 2, text: 'cloud' }, version: 4, updated_at: new Date(1005000).toISOString(), deleted_at: null });
    const app = fakeApp([]);
    const sess = sync.createSession({
      config: { url: 'https://x.supabase.co', anonKey: 'k' }, app, storage,
      loadSupabase: async () => fakeSupabaseModule(server), timeoutMs: 100
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(sess.state, 'online');
    assert(app._els.some((e) => e.id === 'k1' && e.text === 'cloud'), 'remote note merged');
  }],
  ['two members, return-reload-edit: a delta pull merges into the device scene; the next edit tombstones nothing', async () => {
    const server = mkServer();
    const A = await firstDevice(server);
    const keys = A.app._els.map((e) => e.id);
    const B = await joinDevice(server, A.boardId);
    assert.strictEqual(B.app._els.length, 3, 'second member sees the board');
    parkCursor(server, A); /* A is closed; its saved cursor sits past all current rows */
    B.app._els[0].text = 'edited by B';
    B.sess.onSave(); await B.sess.flush();
    /* A returns: the pull is a one-row delta, but A still shows all three notes */
    const A2 = await reloadDevice(server, A);
    assert.strictEqual(A2.app._els.length, 3, 'delta merged into the saved scene, not substituted for it');
    assert.strictEqual(A2.app._els.find((e) => e.id === keys[0]).text, 'edited by B', 'remote edit applied');
    A2.app._els[1].text = 'edited after return';
    A2.sess.onSave(); await A2.sess.flush();
    assert.strictEqual(tombs(server, A.boardId).length, 0, 'nothing tombstoned for any member');
    assert.strictEqual(live(server, A.boardId).length, 3);
    assert.strictEqual(server.rows.get(keys[1]).payload.text, 'edited after return');
    assert.strictEqual(server.rows.get(keys[2]).version, 1, 'untouched note never rewritten');
  }],
  ['a genuine local delete still propagates as a tombstone after a reload', async () => {
    const server = mkServer();
    const A = await firstDevice(server);
    const keys = A.app._els.map((e) => e.id);
    A.app._els.splice(2, 1);
    A.sess.onSave(); await A.sess.flush();
    assert.deepStrictEqual(tombs(server, A.boardId).map((r) => r.element_key), [keys[2]], 'only the deleted note is tombstoned');
    assert.strictEqual(live(server, A.boardId).length, 2);
    parkCursor(server, A);
    const A2 = await reloadDevice(server, A);
    A2.app._els[0].text = 'later edit';
    A2.sess.onSave(); await A2.sess.flush();
    assert.strictEqual(tombs(server, A.boardId).length, 1, 'no additional tombstones');
    assert.strictEqual(A2.app._els.length, 2);
  }],
  ['a remote tombstone removes the element locally and is not resurrected', async () => {
    const server = mkServer();
    const A = await firstDevice(server);
    const keys = A.app._els.map((e) => e.id);
    const B = await joinDevice(server, A.boardId);
    parkCursor(server, B);
    A.app._els.splice(2, 1);
    A.sess.onSave(); await A.sess.flush();
    const B2 = await reloadDevice(server, B); /* B's saved scene still has all three */
    assert.strictEqual(B2.app._els.length, 2, 'tombstone applied to the seeded scene');
    assert(!B2.app._els.some((e) => e.id === keys[2]), 'deleted note is gone');
    B2.app._els[0].text = 'B keeps working';
    B2.sess.onSave(); await B2.sess.flush();
    assert(server.rows.get(keys[2]).deleted_at, 'still deleted server-side');
    assert.strictEqual(live(server, A.boardId).length, 2, 'not resurrected by B');
  }],
  ['version conflict resolves to server state', async () => {
    const server = mkServer();
    const A = await firstDevice(server);
    const key = A.app._els[0].id;
    const B = await joinDevice(server, A.boardId);
    B.app._els.find((e) => e.id === key).text = 'B wins';
    B.sess.onSave(); await B.sess.flush();
    assert.strictEqual(server.rows.get(key).version, 2);
    A.app._els[0].text = 'A stale edit'; /* A never pulled B's change */
    A.sess.onSave(); await A.sess.flush();
    assert.strictEqual(A.app._els.find((e) => e.id === key).text, 'B wins', 'local copy replaced by server state');
    assert.strictEqual(server.rows.get(key).payload.text, 'B wins', 'server unchanged by the stale write');
    assert.strictEqual(A.sess.engine.outboxOps().length, 0);
    assert.strictEqual(A.sess.engine.deadLetters().length, 0);
  }],
  ['cloud choice after session start: openBoard loads the chosen board and syncs there', async () => {
    const server = mkServer();
    const A = await firstDevice(server); /* session already started, on its own board */
    const ownKeys = A.app._els.map((e) => e.id);
    ['c1', 'c2'].forEach((id) => server.rows.set(id, {
      element_key: id, board_id: 'cloud-1', type: 'note', payload: mkNote(id, 'cloud ' + id),
      version: 3, updated_at: new Date(1000500).toISOString(), deleted_at: null
    }));
    await A.sess.init(); /* the no-op the old code relied on */
    assert.deepStrictEqual(A.app._els.map((e) => e.id), ownKeys, 'init() alone changes nothing');
    assert.strictEqual(await A.sess.openBoard('cloud-1'), true);
    assert.deepStrictEqual(A.app._els.map((e) => e.id).sort(), ['c1', 'c2'], 'cloud board shown, own board not mixed in');
    assert.strictEqual(A.storage.getItem('aiwb.board'), 'cloud-1');
    A.app._els[0].text = 'edited on the cloud board';
    A.sess.onSave(); await A.sess.flush();
    assert.strictEqual(server.rows.get('c1').payload.text, 'edited on the cloud board', 'edits now sync to the chosen board');
    assert.strictEqual(server.rows.get('c1').version, 4);
    assert.strictEqual(live(server, A.boardId).length, 3, 'the previous board is untouched, not tombstoned');
    assert.strictEqual(tombs(server, A.boardId).length, 0);
  }],
  ['failed cloud-board pull keeps the old board association and scene', async () => {
    const server = mkServer();
    const A = await firstDevice(server);
    const oldKeys = A.app._els.map((e) => e.id);
    server.failPullBoardOnce = 'cloud-1';
    assert.strictEqual(await A.sess.openBoard('cloud-1'), false);
    assert.strictEqual(A.storage.getItem('aiwb.board'), A.boardId, 'old board id remains durable');
    assert.deepStrictEqual(A.app._els.map((e) => e.id), oldKeys, 'old scene remains visible');
    const returned = await reloadDevice(server, A);
    returned.app._els[0].text = 'still mine';
    returned.sess.onSave(); await returned.sess.flush();
    assert.strictEqual(live(server, 'cloud-1').length, 0, 'old elements never uploaded to the new board');
  }],
  ['failed scene save during board choice cannot mix the two boards', async () => {
    const server = mkServer(); const base = memStorage(); let failScene = false;
    const storage = { ...base, setItem(k, v) { if (failScene && k === 'aiwb.scene') throw new Error('quota'); base.setItem(k, v); } };
    const app = savingApp([mkNote('e1', 'old board')], storage);
    const device = openDevice(server, storage, app);
    device.sess.onSave(); await until(() => device.sess.state === 'online');
    const oldBoard = storage.getItem('aiwb.board');
    server.rows.set('c1', { element_key: 'c1', board_id: 'cloud-1', type: 'note', payload: mkNote('c1', 'cloud'),
      version: 1, updated_at: new Date(1005000).toISOString(), deleted_at: null });
    failScene = true;
    assert.strictEqual(await device.sess.openBoard('cloud-1'), false);
    assert.strictEqual(storage.getItem('aiwb.board'), oldBoard);
    assert(app._els.some((e) => e.text === 'old board'));
    failScene = false;
    const returned = openDevice(server, storage, savingApp(JSON.parse(storage.getItem('aiwb.scene')), storage));
    await until(() => returned.sess.state === 'online');
    returned.app._els[0].text = 'edited old board'; returned.app.save(); await returned.sess.flush();
    assert.strictEqual(live(server, 'cloud-1').length, 1, 'old content never uploaded to cloud');
  }],
  ['interrupted board switch restores the original board without deleting it', async () => {
    const server = mkServer(); const storage = memStorage();
    const app = savingApp([mkNote('e1', 'old one'), mkNote('e2', 'old two')], storage);
    const first = openDevice(server, storage, app);
    app.save(); await until(() => first.sess.state === 'online');
    const boardId = storage.getItem('aiwb.board');
    storage.setItem('aiwb.board.switching', 'cloud-1');
    storage.setItem('aiwb.scene', '[]'); /* crash after saving the next scene, before board ID */
    const returned = openDevice(server, storage, savingApp([], storage));
    await until(() => returned.sess.state === 'online');
    assert.strictEqual(returned.app._els.length, 2, 'all old-board rows restored');
    returned.app._els[0].text = 'safe edit'; returned.app.save(); await returned.sess.flush();
    assert.strictEqual(tombs(server, boardId).length, 0, 'no mass deletion');
    assert.strictEqual(live(server, boardId).length, 2);
  }],
  ['missing saved scene after a prior good sync never wipes the shared board', async () => {
    const server = mkServer(); const storage = memStorage();
    const app = savingApp([mkNote('e1', 'one'), mkNote('e2', 'two')], storage);
    const first = openDevice(server, storage, app);
    app.save(); await until(() => first.sess.state === 'online');
    const boardId = storage.getItem('aiwb.board');
    assert(storage.getItem('aiwb.sync.' + boardId + '.sceneKeys'), 'checkpoint already exists');
    storage.removeItem('aiwb.scene');
    const returned = openDevice(server, storage, savingApp([], storage));
    await until(() => returned.sess.state === 'online');
    assert.strictEqual(returned.app._els.length, 2, 'lost scene rebuilt from server');
    returned.app._els[0].text = 'later edit'; returned.app.save(); await returned.sess.flush();
    assert.strictEqual(tombs(server, boardId).length, 0);
    assert.strictEqual(live(server, boardId).length, 2);
  }]
];

(async () => {
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
