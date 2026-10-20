/* node ideas/ai-whiteboard/ai-ledger.test.js
   The ledger client maps arguments to the RPCs and turns database refusals into named errors. Money rules are tested in policy_tests.sql. */
const assert = require('assert');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

(async () => {
  const m = await import('./supabase/functions/_shared/ledger.mjs');
  const fake = (result) => { const calls = []; const rpc = async (name, args) => { calls.push([name, args]); return result; }; rpc.calls = calls; return rpc; };

  const tests = [
    ['placeHold sends person, request and amount', async () => {
      const rpc = fake({ data: null, error: null });
      await m.placeHold(rpc, 'p', 'r1', 0.5);
      assert.deepStrictEqual(rpc.calls[0], ['ledger_place_hold', { p_person: 'p', p_request: 'r1', p_amount: 0.5 }]);
    }],
    ['a short balance becomes code "insufficient"', async () => {
      const rpc = fake({ data: null, error: { message: 'insufficient balance' } });
      await assert.rejects(m.placeHold(rpc, 'p', 'r', 1), (e) => e instanceof m.LedgerError && e.code === 'insufficient');
    }],
    ['a paused person becomes code "paused"', async () => {
      const rpc = fake({ data: null, error: { message: 'access paused' } });
      await assert.rejects(m.placeHold(rpc, 'p', 'r', 1), (e) => e.code === 'paused');
    }],
    ['other database errors do not leak their text', async () => {
      const rpc = fake({ data: null, error: { message: 'relation credit_ledger secret detail' } });
      await assert.rejects(m.settle(rpc, 'r', 1), (e) => e.code === 'ledger_error' && !/secret/.test(e.message));
    }],
    ['settleZero releases instead of writing a spend', async () => {
      const rpc = fake({ data: null, error: null });
      await m.settleZero(rpc, 'r9');
      assert.strictEqual(rpc.calls[0][0], 'ledger_release');
    }],
    ['adjust passes the idempotency key', async () => {
      const rpc = fake({ data: null, error: null });
      await m.adjust(rpc, 'p', 5, 'hand grant', 'k');
      assert.strictEqual(rpc.calls[0][1].p_idem, 'k');
    }],
    ['takeAttempt returns the attempt number, or null when refused', async () => {
      assert.strictEqual(await m.takeAttempt(fake({ data: 2, error: null }), 't', 'p'), 2);
      assert.strictEqual(await m.takeAttempt(fake({ data: null, error: null }), 't', 'p'), null);
    }]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
