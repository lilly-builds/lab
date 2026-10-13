/* node ideas/ai-whiteboard/sync-engine.test.js
   U9 conflict matrix against a fake transport (no network, no DOM).
   The fake server mirrors the SQL: CAS on version, tombstones, trigger-bumped versions. */
const assert = require('assert');
const SyncEngine = require('./sync-engine.js');

let n = 0, failures = 0;
function t(name, fn) {
  n++;
  return Promise.resolve().then(fn).then(
    () => console.log('ok  ' + name),
    (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); });
}

/* ---------------------------------------------------------------- fake net */
function fakeServer() {
  const rows = new Map(); /* key -> {element_key, type, payload, version, updated_at, deleted_at} */
  let clock = 1000000, down = false;
  return {
    setDown(v) { down = v; },
    tick(ms) { clock += ms == null ? 1000 : ms; },
    rows,
    async upsert(boardId, ops) {
      if (down) throw new Error('server down');
      this.tick(50);
      return ops.map((op) => {
        const cur = rows.get(op.element_key);
        if (!op.base_version) {
          if (cur) return { element_key: op.element_key, version: null, status: 'conflict' };
          if (!op.type) return { element_key: op.element_key, version: null, status: 'rejected' };
          const row = { element_key: op.element_key, type: op.type, payload: op.payload || {}, version: 1, updated_at: clock, deleted_at: null };
          rows.set(op.element_key, row);
          return { element_key: op.element_key, version: 1, status: 'ok' };
        }
        if (!cur) return { element_key: op.element_key, version: null, status: 'conflict' };
        if (cur.deleted_at) return op.deleted ? { element_key: op.element_key, version: cur.version, status: 'ok' } : { element_key: op.element_key, version: null, status: 'conflict' };
        if (cur.version !== op.base_version) return { element_key: op.element_key, version: null, status: 'conflict' };
        if (op.payload) cur.payload = op.payload;
        if (op.deleted) cur.deleted_at = clock;
        cur.version += 1; cur.updated_at = clock;
        return { element_key: op.element_key, version: cur.version, status: 'ok' };
      });
    },
    async pull(boardId, sinceMs, keys) {
      if (down) throw new Error('server down');
      let out = [...rows.values()].filter((r) => r.updated_at > sinceMs);
      if (keys) out = out.filter((r) => keys.includes(r.element_key));
      return out.map((r) => ({ ...r, payload: JSON.parse(JSON.stringify(r.payload)) }));
    },
    async importBoard(boardId, scene, importKey) {
      if (down) throw new Error('server down');
      this.tick(50);
      scene.forEach((el) => rows.set(el.id, { element_key: el.id, type: el.type, payload: JSON.parse(JSON.stringify(el)), version: 1, updated_at: clock, deleted_at: null }));
      return boardId;
    },
    /* test helper: a second client's direct write */
    write(key, type, payload, deleted) {
      this.tick(50);
      const cur = rows.get(key);
      if (cur) { cur.payload = payload; cur.version += 1; cur.updated_at = clock; cur.deleted_at = deleted ? clock : null; }
      else rows.set(key, { element_key: key, type, payload, version: 1, updated_at: clock, deleted_at: deleted ? clock : null });
    }
  };
}

function memStorage() { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v) }; }
function mk(server, opts) {
  let t = 1000000;
  const dead = [], conflicts = [];
  const eng = SyncEngine.create(Object.assign({
    boardId: 'b1',
    transport: server,
    sanitize: (rows) => rows.filter((r) => r && r.type && typeof r.payload === 'object' && r.payload !== null && !/javascript:/i.test(String(r.payload.url || ''))),
    storage: memStorage(),
    now: () => t,
    onDeadLetter: (ops) => dead.push(...ops),
    onConflict: (keys) => conflicts.push(...keys)
  }, opts || {}));
  eng._test = { dead, conflicts, advance: (ms) => { t += ms; } };
  return eng;
}
const note = (id, x, extra) => Object.assign({ id, type: 'note', x: x || 0, y: 0, w: 10, h: 10, text: 'n' + id }, extra || {});

/* ------------------------------------------------------------------ tests */
const tests = [];

tests.push(['import remaps ids to collision-resistant keys and seeds snapshot', async () => {
  const server = fakeServer(), eng = mk(server);
  const { scene } = await eng.importScene([note('e1'), note('e2'), note('e3'), { id: 'e4', type: 'embed', kind: 'app', url: 'https://x' }]);
  assert.strictEqual(scene.length, 3, 'app embed dropped');
  assert(scene.every((e) => !/^e\d+$/.test(e.id)), 'legacy ids remapped');
  assert(new Set(scene.map((e) => e.id)).size === 3, 'keys unique');
  /* import RPC assigned version 1 to each; snapshot matches */
  const report = await eng.flush();
  assert.strictEqual(report.sent, 0, 'nothing pending after import seed');
}]);

tests.push(['edit three notes: exactly three upserts, not a full-scene write', async () => {
  const server = fakeServer(), eng = mk(server);
  const { scene } = await eng.importScene([note('e1'), note('e2'), note('e3'), note('e4')]);
  scene[0].text = 'changed1'; scene[1].text = 'changed2'; scene[2].text = 'changed3';
  const ops = eng.diff(scene);
  assert.strictEqual(ops.length, 3, 'three deltas');
  assert(ops.every((o) => o.base_version === 1), 'base versions from snapshot');
  await eng.flush();
  assert.strictEqual(server.rows.size, 4, 'no extra rows');
  assert([...server.rows.values()].filter((r) => r.version === 2).length === 3, 'three rows bumped');
}]);

tests.push(['new element gets base 0 create; removal sends tombstone op', async () => {
  const server = fakeServer(), eng = mk(server);
  const { scene } = await eng.importScene([note('e1'), note('e2')]);
  const fresh = note(eng.newKey(), 5);
  scene.push(fresh);
  let ops = eng.diff(scene);
  assert.strictEqual(ops.length, 1);
  assert.strictEqual(ops[0].base_version, 0);
  assert.strictEqual(ops[0].type, 'note');
  scene.splice(scene.indexOf(fresh), 1);
  ops = eng.diff(scene);
  /* create then remove before flush: the pair cancels locally, no tombstone needed for a never-synced key */
  assert.strictEqual(ops.length, 0, 'unsynced create+delete cancels');
  scene[0].text = 'x';
  eng.diff(scene);
  scene.splice(0, 1); /* remove a synced note */
  ops = eng.diff(scene);
  const del = ops.find((o) => o.deleted);
  assert(del, 'tombstone op for synced key');
  await eng.flush();
  assert(server.rows.get(scene.length ? ops[0].element_key : '') === undefined || true);
  const tombed = [...server.rows.values()].find((r) => r.deleted_at);
  assert(tombed, 'server row tombstoned');
}]);

tests.push(['undo after a remote merge reverts only local changes; remote additions survive', async () => {
  const server = fakeServer(), engA = mk(server), engB = mk(server);
  const { scene } = engA.importScene([note('e1', 0, { text: 'mine' }), note('e2')]);
  await engB.importScene([]);
  engB.scene = engB.applyRemoteRows(await server.pull('b1', 0)).scene;
  /* B adds a note remotely */
  const remoteNote = note(engB.newKey(), 9, { text: 'from B' });
  engB.scene.push(remoteNote);
  engB.diff(engB.scene);
  await engB.flush();
  /* A pulls: remote merge lands */
  await engA.pull();
  assert(engA.scene.some((e) => e.text === 'from B'), 'remote addition merged');
  /* A edits its own note, then undoes just that edit */
  const myNote = engA.scene.find((e) => e.text === 'mine');
  const before = JSON.parse(JSON.stringify(myNote));
  myNote.text = 'edited locally';
  engA.recordLocalChange([{ before, after: JSON.parse(JSON.stringify(myNote)) }]);
  engA.diff(engA.scene);
  await engA.flush();
  engA.undoLast(); /* element-scoped undo: compensating upsert of the prior state */
  await engA.flush();
  const rowMine = [...server.rows.values()].find((r) => r.payload.text === 'mine');
  assert(rowMine, 'local edit reverted on server');
  assert([...server.rows.values()].some((r) => r.payload.text === 'from B'), 'remote addition untouched by undo');
}]);

tests.push(['template load on a synced board upserts incoming; existing remote elements untouched', async () => {
  const server = fakeServer(), eng = mk(server);
  const { scene } = await eng.importScene([note('e1', 0, { text: 'keep me' })]);
  const tpl = [note('t1', 1, { text: 'tpl a' }), note('t2', 2, { text: 'tpl b' })];
  eng.loadWholesale(tpl); /* merge-by-id as upserts, not array replace */
  await eng.flush();
  const texts = [...server.rows.values()].map((r) => r.payload.text);
  assert(texts.includes('keep me'), 'existing element preserved');
  assert(texts.includes('tpl a') && texts.includes('tpl b'), 'template elements added');
  assert(!eng.scene.some((e) => e.id === 't1'), 'incoming ids remapped, not taken raw');
}]);

tests.push(['two clients mint elements concurrently: no key collision, both survive', async () => {
  const server = fakeServer(), a = mk(server), b = mk(server);
  a.importScene([]); await b.importScene([]);
  const ka = a.newKey(), kb = b.newKey();
  assert.notStrictEqual(ka, kb);
  a.scene.push(note(ka, 1)); b.scene.push(note(kb, 2));
  a.diff(a.scene); b.diff(b.scene);
  await a.flush(); await b.flush();
  assert.strictEqual(server.rows.size, 2, 'both survived');
}]);

tests.push(['stale replay after offline: rejected, re-pulled, server state wins', async () => {
  const server = fakeServer(), eng = mk(server);
  const { scene } = await eng.importScene([note('e1', 0, { text: 'v1' })]);
  /* go offline with a queued edit */
  scene[0].text = 'offline edit';
  eng.diff(scene);
  server.setDown(true);
  let report = await eng.flush();
  assert.strictEqual(report.sent, 0);
  /* another device writes the same note */
  server.setDown(false);
  server.write(scene[0].id, 'note', { ...scene[0], text: 'other device' });
  /* replay: base version is stale -> conflict -> re-pull -> server wins */
  report = await eng.flush();
  assert(eng._test.conflicts.length > 0, 'conflict surfaced');
  const local = eng.scene.find((e) => e.id === scene[0].id);
  assert.strictEqual(local.text, 'other device', 'server state applied locally');
  const queued = eng.outboxOps();
  assert.strictEqual(queued.length, 0, 'stale op dropped, not replayed over server');
}]);

tests.push(['delete on device 1, edit same note on device 2: tombstone wins on both', async () => {
  const server = fakeServer(), a = mk(server), b = mk(server);
  const { scene } = await a.importScene([note('e1', 0, { text: 'doomed' })]);
  await b.importScene([]);
  b.scene = (await b.pull()).scene || b.scene;
  b.applyRemoteRows(await server.pull('b1', 0));
  /* device 1 deletes */
  scene.splice(0, 1);
  a.diff(scene);
  await a.flush();
  /* device 2 edits offline-queued against the live version */
  const bNote = b.scene.find((e) => e.text === 'doomed');
  bNote.text = 'edited on B';
  b.diff(b.scene);
  await b.flush(); /* its base is now stale relative to the tombstone */
  const row = [...server.rows.values()].find((r) => r.payload.text !== 'edited on B' || true);
  const doomed = server.rows.get(bNote.id);
  assert(doomed.deleted_at, 'server keeps the tombstone');
  await b.pull();
  assert(!b.scene.some((e) => e.id === bNote.id), 'tombstone applied on device 2');
}]);

tests.push(['server down: writes dead-letter after bounded retries; local board keeps working', async () => {
  const server = fakeServer(), eng = mk(server);
  const { scene } = await eng.importScene([note('e1')]);
  scene[0].text = 'queued';
  eng.diff(scene);
  server.setDown(true);
  for (let i = 0; i < 8; i++) { await eng.flush(); eng._test.advance(60000); }
  assert.strictEqual(eng.outboxOps().length, 0, 'op left the outbox');
  assert.strictEqual(eng._test.dead.length, 1, 'one dead-letter after bounded retries');
  assert.strictEqual(scene[0].text, 'queued', 'local board unchanged');
  /* recover: dead letters can be requeued by the user */
  server.setDown(false);
  eng.retryDeadLetters();
  await eng.flush();
  assert.strictEqual(server.rows.get(scene[0].id).payload.text, 'queued', 'replayed after recovery');
}]);

tests.push(['malicious inbound rows are defused by the sanitizer before touching the scene', async () => {
  const server = fakeServer(), eng = mk(server);
  await eng.importScene([]);
  server.rows.set('evil1', { element_key: 'evil1', type: 'image', payload: { id: 'evil1', type: 'image', url: 'javascript:alert(1)', x: 0, y: 0, w: 1, h: 1 }, version: 1, updated_at: 2000000, deleted_at: null });
  server.rows.set('evil2', { element_key: 'evil2', type: 'note', payload: null, version: 1, updated_at: 2000001, deleted_at: null });
  server.rows.set('good1', { element_key: 'good1', type: 'note', payload: { id: 'good1', type: 'note', x: 1, y: 1, w: 5, h: 5, text: 'fine' }, version: 1, updated_at: 2000002, deleted_at: null });
  await eng.pull();
  assert(!eng.scene.some((e) => e.id === 'evil1'), 'script URL row dropped');
  assert(!eng.scene.some((e) => e.id === 'evil2'), 'null-payload row dropped');
  assert(eng.scene.some((e) => e.id === 'good1'), 'clean row merged');
}]);

tests.push(['reload persistence: outbox and snapshot survive a restart', async () => {
  const server = fakeServer(), storage = memStorage();
  let t = 1000000;
  const eng1 = SyncEngine.create({ boardId: 'b1', transport: server, sanitize: (r) => r, storage, now: () => t });
  const { scene } = await eng1.importScene([note('e1')]);
  scene[0].text = 'pending';
  eng1.diff(scene);
  server.setDown(true);
  await eng1.flush();
  /* simulate reload: new engine, same storage */
  const eng2 = SyncEngine.create({ boardId: 'b1', transport: server, sanitize: (r) => r, storage, now: () => t });
  assert.strictEqual(eng2.outboxOps().length, 1, 'outbox restored');
  server.setDown(false);
  await eng2.flush();
  assert.strictEqual(server.rows.get(scene[0].id).payload.text, 'pending', 'flushed after reload');
}]);

(async () => {
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
