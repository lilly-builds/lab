/* node ideas/ai-whiteboard/ai-cleanup.test.js
   The cleanup job and the reconciler (build plan 1.12, invariants I2 and I4). Every orphaned hold ends as a settle to its real cost,
   a release when nothing ran, or a flag that keeps the hold. The reconciler only flags. The same jobs on a real database: ai-db.test.js. */
const assert = require('assert');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

(async () => {
  const S = './supabase/functions/_shared/';
  const c = await import(S + 'cleanup.mjs');
  const r = await import(S + 'reconcile.mjs');

  function jobs(holds, over = {}) {
    const log = { settled: [], released: [], flags: new Map() };
    const deps = {
      staleHolds: async () => holds,
      lookupCost: async (person, g) => (over.costs || {})[g] ?? null,
      settle: async (id, cost) => { log.settled.push([id, cost]); },
      release: async (id) => { log.released.push(id); },
      flag: async (cause, sev, person, detail) => { if (log.flags.has(cause)) return false; log.flags.set(cause, { sev, person, detail }); return true; },
      drainLimits: async () => ({ done: 0, failed: 0 }),
      spendSince: async () => over.spent || 0,
      prune: async () => {},
      now: () => Date.UTC(2026, 9, 17, 12)
    };
    return { deps, log };
  }
  const hold = (id, usage) => ({ request_id: id, person_id: 'p1', amount: 0.5, usage });

  const tests = [
    ['an orphan with known costs settles to their sum', async () => {
      const { deps, log } = jobs([hold('h1', [{ request_id: 'h1:0', cost: 0.0001, outcome: 'ok' }, { request_id: 'h1:1', cost: '0.002', outcome: 'ok' }])]);
      const rep = await c.cleanup(deps);
      assert.deepStrictEqual(log.settled, [['h1', 0.0021]]);
      assert.strictEqual(rep.settled, 1);
    }],
    ['an orphan cut off mid-answer settles to the cost OpenRouter reports for its generation', async () => {
      const { deps, log } = jobs([hold('h2', [{ request_id: 'h2:0', cost: 0.0001, outcome: 'ok' }, { request_id: 'h2:1', generation_id: 'g-9', cost: null, outcome: null }])], { costs: { 'g-9': 0.04 } });
      await c.cleanup(deps);
      assert.deepStrictEqual(log.settled, [['h2', 0.0401]]);
    }],
    ['an orphan whose call never started, or that has no usage rows, is released', async () => {
      const { deps, log } = jobs([hold('h3', [{ request_id: 'h3:0', cost: null, outcome: 'error_before_start' }]), hold('h4', [])]);
      const rep = await c.cleanup(deps);
      assert.deepStrictEqual(log.released, ['h3', 'h4']);
      assert.deepStrictEqual([rep.released, log.settled.length], [2, 0]);
    }],
    ['an orphan with a call of unknown cost is flagged high and kept, never released', async () => {
      const { deps, log } = jobs([hold('h5', [{ request_id: 'h5:1', generation_id: null, cost: null, outcome: 'unknown' }]),
        hold('h6', [{ request_id: 'h6:1', generation_id: 'g-missing', cost: null, outcome: null }])]);
      const rep = await c.cleanup(deps);
      assert.deepStrictEqual([log.settled.length, log.released.length, rep.kept], [0, 0, 2]);
      assert.strictEqual(log.flags.get('hold_unresolved:h5').sev, 'high');
      assert.deepStrictEqual(log.flags.get('hold_unresolved:h6').detail.unresolved, ['h6:1']);
    }],
    ['one hold that fails mid-run is kept for the next run; the rest of the run still happens', async () => {
      let drained = false, pruned = false;
      const { deps, log } = jobs([hold('bad', [{ request_id: 'bad:1', generation_id: 'g-down', cost: null, outcome: 'cut_off' }]),
        hold('good', [{ request_id: 'good:1', cost: 0.003, outcome: 'ok' }])], { spent: 50 });
      deps.lookupCost = async () => { throw new Error('openrouter is down'); };
      deps.drainLimits = async () => { drained = true; return { done: 0, failed: 0 }; };
      deps.prune = async () => { pruned = true; };
      const rep = await c.cleanup(deps);
      assert.deepStrictEqual(log.settled, [['good', 0.003]]);
      assert.deepStrictEqual(log.released, [], 'the failed hold is never released');
      assert.deepStrictEqual([rep.errors, drained, pruned, rep.spendAlert], [1, true, true, true]);
    }],
    ['a standing problem is flagged once, not every run', async () => {
      const holds = [hold('h7', [{ request_id: 'h7:1', cost: null, outcome: 'unknown' }])];
      const { deps } = jobs(holds);
      const first = await c.cleanup(deps), second = await c.cleanup(deps);
      assert.deepStrictEqual([first.flagged, second.flagged, second.kept], [1, 0, 1]);
    }],
    ['daily spend over the threshold raises one alert for the day', async () => {
      const { deps, log } = jobs([], { spent: c.DAILY_SPEND_ALERT + 0.01 });
      assert.strictEqual((await c.cleanup(deps)).spendAlert, true);
      assert.ok(log.flags.has('daily_spend:2026-10-17'));
      const quiet = jobs([], { spent: c.DAILY_SPEND_ALERT });
      assert.strictEqual((await c.cleanup(quiet.deps)).spendAlert, false);
    }],
    ['reconcile: matching ledger and key raise nothing', () => {
      const p = { person_id: 'p', rows: [{ id: 1, reason: 'adjustment', amount: 10 }, { id: 2, reason: 'spend', amount: 2 }], open_holds: 0 };
      assert.deepStrictEqual(r.compare(p, { limit: 10, usage: 2, disabled: false }), []);
    }],
    ['reconcile: a key limit that disagrees with the limit rule is flagged, not fixed', () => {
      const p = { person_id: 'p', rows: [{ id: 1, reason: 'adjustment', amount: 10 }], open_holds: 0 };
      const f = r.compare(p, { limit: 25, usage: 0, disabled: false });
      assert.deepStrictEqual(f.map((x) => x.cause), ['limit_mismatch']);
      assert.deepStrictEqual(f[0].detail, { expected: 10, actual: 25 });
    }],
    ['reconcile: key usage past ledger spend plus open holds is flagged; within open holds it is not', () => {
      const p = { person_id: 'p', rows: [{ id: 1, reason: 'adjustment', amount: 10 }, { id: 2, reason: 'spend', amount: 1 }], open_holds: 0.5 };
      assert.deepStrictEqual(r.compare(p, { limit: 10, usage: 1.4, disabled: false }), []);
      assert.deepStrictEqual(r.compare(p, { limit: 10, usage: 1.6, disabled: false }).map((x) => x.cause), ['usage_mismatch']);
      assert.deepStrictEqual(r.compare(p, { limit: 10, usage: 0.9, disabled: false }).map((x) => x.cause), ['usage_mismatch']);
    }],
    ['reconcile: a key near its cap gets a normal flag; a revoked pass with a live key gets a high one', () => {
      const p = { person_id: 'p', rows: [{ id: 1, reason: 'adjustment', amount: 10 }, { id: 2, reason: 'spend', amount: 8.5 }], open_holds: 0 };
      assert.deepStrictEqual(r.compare(p, { limit: 10, usage: 8.5, disabled: false }).map((x) => [x.cause, x.severity]), [['key_near_cap', 'normal']]);
      assert.deepStrictEqual(r.compare({ ...p, disabled: true }, { limit: 10, usage: 8.5, disabled: false }).map((x) => x.cause), ['revoked_key_live']);
      assert.deepStrictEqual(r.compare({ ...p, disabled: true }, { limit: 10, usage: 8.5, disabled: true }), []);
    }],
    ['reconcile: an unreadable key is counted and flagged, and the run goes on', async () => {
      const flags = [];
      const rep = await r.reconcile({
        people: async () => [{ person_id: 'a', key_hash: 'x', rows: [], open_holds: 0 }, { person_id: 'b', key_hash: 'y', rows: [{ id: 1, reason: 'adjustment', amount: 1 }], open_holds: 0 }],
        readKey: async (h) => { if (h === 'x') throw new Error('down'); return { limit: 1, usage: 0, disabled: false }; },
        flag: async (cause) => { flags.push(cause); return true; }
      });
      assert.deepStrictEqual([rep.unreadable, rep.checked], [1, 1]);
      assert.deepStrictEqual(flags, ['key_unreadable:a']);
    }]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
