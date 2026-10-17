/* node ideas/ai-whiteboard/ai-limit-rule.test.js
   Invariant I4: the key limit is always max(granted - deducted, usage). */
const assert = require('assert');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

const row = (id, reason, amount) => ({ id, reason, amount });

(async () => {
  const { computeLimit } = await import('./supabase/functions/_shared/limit-rule.mjs');
  const tests = [
    ['empty ledger gives usage', () => assert.strictEqual(computeLimit([], 3.5), 3.5)],
    ['empty ledger, no usage, gives 0', () => assert.strictEqual(computeLimit([], 0), 0)],
    ['architecture example: $10 granted, $8 used, $10 refunded gives 8', () => {
      assert.strictEqual(computeLimit([row('a', 'paid', 10), row('b', 'refund', 10)], 8), 8);
    }],
    ['a $10 renewal after that gives 10', () => {
      assert.strictEqual(computeLimit([row('a', 'paid', 10), row('b', 'refund', 10), row('c', 'paid', 10)], 8), 10);
    }],
    ['duplicate ids do not double count', () => {
      assert.strictEqual(computeLimit([row('a', 'paid', 10), row('a', 'paid', 10)], 0), 10);
    }],
    ['restores add back', () => {
      assert.strictEqual(computeLimit([row('a', 'paid', 10), row('b', 'refund', 10), row('c', 'refund_failed', 10)], 0), 10);
      assert.strictEqual(computeLimit([row('a', 'paid', 10), row('b', 'dispute', 10), row('c', 'dispute_restored', 10)], 0), 10);
    }],
    ['free, bonus, adjustment grant; expire deducts', () => {
      assert.strictEqual(computeLimit([row('a', 'free', 1), row('b', 'bonus', 2), row('c', 'adjustment', 3), row('d', 'expire', 1)], 0), 5);
    }],
    ['cents do not drift', () => {
      assert.strictEqual(computeLimit([row('a', 'paid', 0.1), row('b', 'paid', 0.2)], 0), 0.3);
    }],
    ['unknown reason throws', () => assert.throws(() => computeLimit([row('a', 'mystery', 1)], 0))],
    ['negative amount throws', () => assert.throws(() => computeLimit([row('a', 'paid', -1)], 0))]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
