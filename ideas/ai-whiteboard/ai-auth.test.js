/* node ideas/ai-whiteboard/ai-auth.test.js
   Tester passes, capped keys, the limit setter and its retry queue (build plan 1.8). Uses the local mock of OpenRouter; no real accounts. */
const assert = require('assert');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

(async () => {
  const S = './supabase/functions/_shared/';
  const auth = await import(S + 'auth.mjs');
  const keys = await import(S + 'keys.mjs');
  const ls = await import(S + 'limit-setter.mjs');
  const { startMock } = await import(S + 'testing/mock-openrouter.mjs');
  const mock = await startMock();
  const cfg = { baseUrl: mock.url, masterKey: 'sk-master-SECRET' };

  const db = (row) => async (h) => (row && row.pass_hash === h ? row : null);
  const mk = () => { const p = auth.newPass(); return { p, row: { id: 'person-1', pass_hash: p.hash, disabled: false, paused: false } }; };
  const hdr = (pass) => ({ authorization: 'Bearer ' + pass });

  const tests = [
    ['a new pass hashes to plain SHA-256 hex (matches the SQL my_balance)', async () => {
      const p = auth.newPass();
      assert.match(p.hash, /^[0-9a-f]{64}$/);
      assert.strictEqual(auth.hashPass(p.pass), p.hash);
      assert.notStrictEqual(auth.newPass().pass, p.pass);
    }],
    ['a good pass is accepted and returns the person', async () => {
      const { p, row } = mk();
      assert.deepStrictEqual(await auth.authenticate(hdr(p.pass), db(row)), { ok: true, person: 'person-1' });
    }],
    ['missing, wrong, revoked and paused passes are refused with a reason', async () => {
      const { p, row } = mk();
      assert.strictEqual((await auth.authenticate({}, db(row))).reason, 'missing');
      assert.strictEqual((await auth.authenticate(hdr('tp_wrong'), db(row))).reason, 'unknown');
      assert.strictEqual((await auth.authenticate(hdr(p.pass), db({ ...row, disabled: true }))).reason, 'disabled');
      assert.strictEqual((await auth.authenticate(hdr(p.pass), db({ ...row, paused: true }))).reason, 'paused');
    }],
    ['the admin door accepts only the server secret', async () => {
      assert.strictEqual(auth.isAdmin(hdr('s3'), 's3'), true);
      assert.strictEqual(auth.isAdmin(hdr('nope'), 's3'), false);
      assert.strictEqual(auth.isAdmin(hdr('x'), ''), false);
      assert.strictEqual(auth.isAdmin({}, 's3'), false);
    }],
    ['an encrypted key round-trips, differs each time, and a wrong secret fails', async () => {
      const a = keys.encryptKey('sk-live-abc', 'secret'), b = keys.encryptKey('sk-live-abc', 'secret');
      assert.notStrictEqual(a, b);
      assert.ok(!a.includes('sk-live-abc'));
      assert.strictEqual(keys.decryptKey(a, 'secret'), 'sk-live-abc');
      assert.throws(() => keys.decryptKey(a, 'other'));
    }],
    ['create, limit, disable a key against the mock', async () => {
      const k = await keys.createKey(cfg, { name: 'tester', limit: 5 });
      assert.strictEqual(mock.state.keys.get(k.hash).limit, 5);
      await keys.setKeyLimit(cfg, k.hash, 7);
      assert.strictEqual(mock.state.keys.get(k.hash).limit, 7);
      await keys.disableKey(cfg, k.hash);
      assert.strictEqual(mock.state.keys.get(k.hash).disabled, true);
    }],
    ['key errors never carry the master key', async () => {
      const bad = { ...cfg, fetchImpl: async () => { throw new Error('boom ' + cfg.masterKey); } };
      await assert.rejects(keys.setKeyLimit(bad, 'h', 1), (e) => !e.message.includes('SECRET'));
      const down = { ...cfg, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) };
      await assert.rejects(keys.createKey(down, { name: 'x', limit: 1 }), (e) => !e.message.includes('SECRET'));
    }],
    ['the limit setter SETS the limit from the ledger and treats spend as usage', async () => {
      const set = [];
      const deps = {
        loadRows: async () => [{ id: 1, reason: 'adjustment', amount: 10 }, { id: 2, reason: 'spend', amount: 3 }, { id: 3, reason: 'refund', amount: 4 }],
        keyHashOf: async () => 'h1', setLimit: async (h, l) => set.push([h, l]), enqueue: async () => { throw new Error('should not queue'); }
      };
      assert.deepStrictEqual(await ls.setLimitOrQueue('p', deps), { ok: true, limit: 6 });
      await ls.setLimitOrQueue('p', deps); // twice: same number, never added
      assert.deepStrictEqual(set, [['h1', 6], ['h1', 6]]);
    }],
    ['usage above granted minus deducted wins (limit never drops below usage)', async () => {
      let got;
      await ls.applyLimit('p', {
        loadRows: async () => [{ id: 1, reason: 'adjustment', amount: 10 }, { id: 2, reason: 'spend', amount: 8 }, { id: 3, reason: 'refund', amount: 10 }],
        keyHashOf: async () => 'h', setLimit: async (h, l) => { got = l; }
      });
      assert.strictEqual(got, 8);
    }],
    ['a failed set is queued, not thrown', async () => {
      let queued = null;
      const r = await ls.setLimitOrQueue('p', {
        loadRows: async () => [], keyHashOf: async () => 'h', setLimit: async () => { throw new Error('down'); }, enqueue: async (p) => { queued = p; }
      });
      assert.strictEqual(r.reason, 'queued');
      assert.strictEqual(queued, 'p');
    }],
    ['the retry sets the current number, marks done, and backs off on failure', async () => {
      const log = { done: [], failed: [] }; let fail = true; const set = [];
      const deps = {
        takeDue: async () => [{ id: 7, person_id: 'p', attempts: 0 }],
        markDone: async (id) => log.done.push(id), markFailed: async (id, next, a) => log.failed.push([id, next, a]),
        loadRows: async () => [{ id: 1, reason: 'adjustment', amount: 5 }], keyHashOf: async () => 'h',
        setLimit: async (h, l) => { if (fail) throw new Error('down'); set.push(l); }
      };
      assert.deepStrictEqual(await ls.drainQueue(1000, deps), { done: 0, failed: 1 });
      assert.deepStrictEqual(log.failed[0], [7, 1000 + 120000, 1]);
      fail = false;
      assert.deepStrictEqual(await ls.drainQueue(2000, deps), { done: 1, failed: 0 });
      assert.deepStrictEqual(set, [5]);
      assert.deepStrictEqual(log.done, [7]);
    }],
    ['create, use, revoke end to end on the mock', async () => {
      const { p, row } = mk();
      const k = await keys.createKey(cfg, { name: 'e2e', limit: 1 });
      const stored = keys.encryptKey(k.key, 'enc');
      assert.strictEqual((await auth.authenticate(hdr(p.pass), db(row))).ok, true);
      const call = (key) => fetch(mock.url + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: JSON.stringify({ stream: false }) });
      assert.strictEqual((await call(keys.decryptKey(stored, 'enc'))).status, 200);
      await keys.disableKey(cfg, k.hash);
      assert.strictEqual((await call(keys.decryptKey(stored, 'enc'))).status, 402);
      assert.strictEqual((await auth.authenticate(hdr(p.pass), db({ ...row, disabled: true }))).ok, false);
    }]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  await mock.close();
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
