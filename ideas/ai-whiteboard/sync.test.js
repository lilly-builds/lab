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
function fakeSupabaseModule(server) {
  /* mirrors the RPC + table API surface sync.js uses, over an in-memory store */
  const rows = server.rows;
  let clock = 1000000;
  const client = {
    auth: {
      getSession: async () => { if (server.down) throw new Error('down'); return { data: { session: server.signedIn ? { user: { id: 'u1' } } : null } }; },
      signInAnonymously: async () => { if (server.down) throw new Error('down'); server.signedIn = true; return { data: {}, error: null }; }
    },
    rpc: async (fn, args) => {
      if (server.down) throw new Error('down');
      clock += 50;
      if (fn === 'import_board') {
        if (server.imports.has(args.p_import_key)) return { data: server.imports.get(args.p_import_key), error: null };
        const id = 'board-' + (server.imports.size + 1);
        server.imports.set(args.p_import_key, id);
        args.p_scene.forEach((el) => rows.set(el.id, { element_key: el.id, type: el.type, payload: JSON.parse(JSON.stringify(el)), version: 1, updated_at: new Date(clock).toISOString(), deleted_at: null }));
        if (args.p_juice_balance > 0) { server.juiceImport = args.p_juice_balance; server.juiceBalance = args.p_juice_balance; }
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
        const out = args.p_elements.map((op) => {
          const cur = rows.get(op.element_key);
          if (!op.base_version) {
            if (cur) return { element_key: op.element_key, version: null, status: 'conflict' };
            rows.set(op.element_key, { element_key: op.element_key, type: op.type, payload: op.payload, version: 1, updated_at: new Date(++clock).toISOString(), deleted_at: null });
            return { element_key: op.element_key, version: 1, status: 'ok' };
          }
          if (!cur || cur.version !== op.base_version || cur.deleted_at) return { element_key: op.element_key, version: null, status: cur && cur.deleted_at && op.deleted ? 'ok' : 'conflict' };
          if (op.payload) cur.payload = op.payload;
          if (op.deleted) cur.deleted_at = new Date(++clock).toISOString();
          cur.version += 1; cur.updated_at = new Date(++clock).toISOString();
          return { element_key: op.element_key, version: cur.version, status: 'ok' };
        });
        return { data: out, error: null };
      }
      throw new Error('unknown rpc ' + fn);
    },
    from: (table) => table === 'juice_balances' ? ({
      select: () => ({ eq: () => ({ eq: () => ({ then: (res) => Promise.resolve({ data: [{ balance: server.juiceBalance }], error: null }).then(res) }) }) })
    }) : ({
      select: () => ({
        eq: (k, v) => ({
          gt: (k2, v2) => ({
            in: (k3, keys) => exec(v, v2, keys),
            then: (res, rej) => exec(v, v2, null).then(res, rej)
          })
        })
      })
    }),
    channel: () => { throw new Error('no realtime in fake'); }
  };
  async function exec(boardId, sinceIso, keys) {
    if (server.down) throw new Error('down');
    const since = Date.parse(sinceIso);
    let out = [...rows.values()].filter((r) => Date.parse(r.updated_at) > since);
    if (keys) out = out.filter((r) => keys.includes(r.element_key));
    return { data: out, error: null };
  }
  return { createClient: () => client };
}
const mkServer = () => ({ rows: new Map(), imports: new Map(), down: false, idem: new Map(), earnSeq: 0, juiceBalance: 0 });

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
  ['first sync: scene imports, ids remap, board id stored; raced import dedupes', async () => {
    const server = mkServer();
    const app = fakeApp([
      { id: 'e1', type: 'note', x: 0, y: 0, w: 1, h: 1, text: 'a' },
      { id: 'e2', type: 'note', x: 5, y: 5, w: 1, h: 1, text: 'b' }
    ]);
    const storage = memStorage();
    storage.setItem('aiwb.juice', '3');
    const sess = sync.createSession({
      config: { url: 'https://x.supabase.co', anonKey: 'k' }, app, storage,
      loadSupabase: async () => fakeSupabaseModule(server), timeoutMs: 100
    });
    sess.onSave();
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(sess.state, 'online');
    const boardId = storage.getItem('aiwb.board');
    assert(boardId, 'board id stored');
    assert.strictEqual(server.rows.size, 2, 'scene fanned out to rows');
    assert([...server.rows.keys()].every((k) => !/^e\d+$/.test(k)), 'ids remapped');
    assert.strictEqual(server.juiceImport, 3, 'juice balance backfilled at import');
    assert(app._els.every((e) => !/^e\d+$/.test(e.id)), 'local scene rebound to new ids');
    /* retry with the same import key dedupes server-side */
    const again = await fakeSupabaseModule(server).createClient().rpc('import_board', { p_scene: [], p_import_key: [...server.imports.keys()][0], p_juice_balance: 0 });
    assert.strictEqual(again.data, boardId, 'same board returned');
  }],
  ['juice: online earn writes the ledger once; retry cannot double-count (AE4)', async () => {
    const server = mkServer();
    const app = fakeApp([{ id: 'e1', type: 'note', x: 0, y: 0, w: 1, h: 1, text: 'a' }]);
    const juice = { onEarn: null, bal: null, setBalance(n) { this.bal = n; } };
    const storage = memStorage();
    storage.setItem('aiwb.juice', '3');
    const sess = sync.createSession({
      win: { Juice: juice },
      config: { url: 'https://x.supabase.co', anonKey: 'k' }, app, storage,
      loadSupabase: async () => fakeSupabaseModule(server), timeoutMs: 100
    });
    sess.onSave(); /* first sync: import */
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
    const app = fakeApp([{ id: 'e1', type: 'note', x: 0, y: 0, w: 1, h: 1, text: 'a', l1Done: true }]);
    const juice = { onEarn: null, bal: null, setBalance(n) { this.bal = n; } };
    const storage = memStorage();
    storage.setItem('aiwb.juice', '3');
    const sess = sync.createSession({
      win: { Juice: juice },
      config: { url: 'https://x.supabase.co', anonKey: 'k' }, app, storage,
      loadSupabase: async () => fakeSupabaseModule(server), timeoutMs: 100
    });
    juice.onEarn(app._els[0]); /* earn while still unsynced: queued with the e<n> key */
    sess.onSave(); /* first sync imports and remaps ids */
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
  }]
];

(async () => {
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
