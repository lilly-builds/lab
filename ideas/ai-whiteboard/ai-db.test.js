/* node ideas/ai-whiteboard/ai-db.test.js
   The money rules under real concurrency, on a real Postgres (invariants I1 and I5 in the verification contract).
   Needs a database prepared by supabase/tests/scratch.sh and its URL in AI_TEST_DATABASE_URL, for example
   AI_TEST_DATABASE_URL=postgresql://localhost:5432/ai_toolbox_scratch. Without it this file skips (CI has no database
   in the client job). Each call is its own psql session, so parallel calls really race. Only scratch databases are touched. */
const assert = require('assert');
const crypto = require('crypto');

const URL_ = process.env.AI_TEST_DATABASE_URL;
if (!URL_) { console.log('skip: set AI_TEST_DATABASE_URL to a scratch database prepared by supabase/tests/scratch.sh'); process.exit(0); }

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

(async () => {
  const S = './supabase/functions/_shared/';
  const { psqlRpc } = await import(S + 'testing/psql-rpc.mjs');
  const ledger = await import(S + 'ledger.mjs');
  const rpc = psqlRpc(URL_);
  const one = async (name, args) => { const r = await rpc(name, args); if (r.error) throw new Error(name + ': ' + r.error.message); return r.data; };

  // A fresh person with a grant, so the file can run again on the same database.
  async function person(grant) {
    const id = await one('ai_create_pass', { p_hash: crypto.randomBytes(16).toString('hex'), p_label: 'db test' });
    if (grant) await ledger.adjust(rpc, id, grant, 'test grant', 'grant-' + id);
    return id;
  }
  const balance = async (id) => Number(await one('ai_balance', { p_person: id, p_include_holds: true }));

  const tests = [
    ['the adapter mirrors supabase-js shapes: a value, a list of rows, and null for void', async () => {
      const id = await person(1);
      assert.strictEqual(await balance(id), 1);
      const rows = await one('ai_ledger_rows', { p_person: id });
      assert.ok(Array.isArray(rows) && rows.length === 1 && rows[0].reason === 'adjustment');
      assert.strictEqual(await one('ai_limit_enqueue', { p_person: id }), null);
      const bad = await rpc('ledger_place_hold', { p_person: id, p_request: 'x' + id, p_amount: 5 });
      assert.match(bad.error.message, /insufficient balance/);
    }],
    ['I1: 20 parallel holds of $0.10 against $1.00: exactly 10 succeed and the open total never passes the balance', async () => {
      const id = await person(1);
      const rs = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        rpc('ledger_place_hold', { p_person: id, p_request: 'par-' + id + '-' + i, p_amount: 0.1 })));
      const ok = rs.filter((r) => !r.error).length;
      assert.strictEqual(ok, 10, 'successful holds: ' + ok);
      assert.ok(rs.filter((r) => r.error).every((r) => /insufficient balance/.test(r.error.message)));
      assert.strictEqual(await balance(id), 0);
    }],
    ['I1: parallel settles of the same request write one spend row', async () => {
      const id = await person(1);
      await ledger.placeHold(rpc, id, 'once-' + id, 0.5);
      await Promise.all(Array.from({ length: 10 }, () => rpc('ledger_settle', { p_request: 'once-' + id, p_cost: 0.2 })));
      const spends = (await one('ai_ledger_rows', { p_person: id })).filter((r) => r.reason === 'spend');
      assert.strictEqual(spends.length, 1);
      assert.strictEqual(await balance(id), 0.8);
    }],
    ['I5: 20 parallel attempts on one ticket: exactly attempts 1 and 2 are handed out', async () => {
      const id = await person(1);
      const tid = 'tk-' + id;
      await one('ai_store_ticket', { p_id: tid, p_person: id, p_ask_hash: 'h', p_job: 'draw', p_pick: { models: ['m'] }, p_expires_ms: Date.now() + 600000 });
      const rs = await Promise.all(Array.from({ length: 20 }, () => ledger.takeAttempt(rpc, tid, id)));
      assert.deepStrictEqual(rs.filter((x) => x !== null).sort(), [1, 2]);
    }],
    ['a stored ticket comes back with its pick; another person cannot take its attempts', async () => {
      const a = await person(1), b = await person(1);
      const tid = 'tk2-' + a;
      await one('ai_store_ticket', { p_id: tid, p_person: a, p_ask_hash: 'h2', p_job: 'edit', p_pick: { models: ['x', 'y'], maxPrice: { prompt: 1, completion: 3 } }, p_expires_ms: Date.now() + 600000 });
      const [row] = await one('ai_get_ticket', { p_id: tid });
      assert.deepStrictEqual([row.person_id, row.job, row.pick.models], [a, 'edit', ['x', 'y']]);
      assert.strictEqual(await ledger.takeAttempt(rpc, tid, b), null);
    }],
    ['reusing a settled request id is refused at the hold', async () => {
      const id = await person(1);
      await ledger.placeHold(rpc, id, 'reuse-' + id, 0.1);
      await ledger.settle(rpc, 'reuse-' + id, 0.05);
      await assert.rejects(ledger.placeHold(rpc, id, 'reuse-' + id, 0.1), (e) => e instanceof ledger.LedgerError);
    }]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
