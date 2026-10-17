/* node ideas/ai-whiteboard/ai-route.test.js
   /route and /run on a scripted model and an in-memory ledger: refusals, holds that settle to real cost, tickets, two attempts. */
const assert = require('assert');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

(async () => {
  const D = './supabase/functions/_shared/';
  const { route, parseRoute } = await import(D + 'route.mjs');
  const { run, modelsForAttempt } = await import(D + 'run.mjs');
  const { newPass } = await import(D + 'auth.mjs');
  const { fakeLedger } = await import(D + 'testing/fake-ledger.mjs');
  const { pick } = await import(D + 'rulebook.mjs');

  const env = { AI_ALLOW_PLACEHOLDERS: '1' };
  const pass = newPass();
  const headers = { authorization: 'Bearer ' + pass.pass };

  // A scripted model: gate and router replies by system prompt; anything else is the job call.
  function world(over = {}) {
    const led = fakeLedger(over.balance == null ? 1 : over.balance);
    const calls = [];
    const tickets = new Map();
    const hits = new Map();
    const blocks = [];
    const paused = [];
    const script = Object.assign({ gate: '{"ok":true}', router: '{"route":"edit","confidence":0.9,"difficulty":"hard"}', job: [{ outcome: 'ok', text: '{"ops":[]}', cost: 0.002 }] }, over.script);
    const jobQueue = script.job.slice();
    const call = async (p, messages) => {
      const sys = messages[0].content;
      calls.push({ p, sys });
      if (/safety check/.test(sys)) return { outcome: 'ok', text: script.gate, cost: 0.0001 };
      if (/route requests/.test(sys)) return { outcome: 'ok', text: script.router, cost: 0.0001 };
      return jobQueue.shift() || { outcome: 'ok', text: 'x', cost: 0.002 };
    };
    const deps = {
      rpc: led.rpc, call, gateCall: call, env, gatePick: pick('gate', {}, {}, 'u1', env),
      findByHash: async (h) => (h === pass.hash ? { id: 'u1', pass_hash: pass.hash } : null),
      hit: async (k) => { hits.set(k, (hits.get(k) || 0) + 1); return hits.get(k) + (over.preHits || 0); },
      isFirstAsk: async () => true,
      storeTicket: async (x) => { tickets.set(x.id, x); },
      getTicket: async (id) => tickets.get(id) || null,
      recordBlock: async (p, now) => { blocks.push(now); return over.blockTimes ? over.blockTimes.concat(blocks) : blocks; },
      pause: async (p) => { paused.push(p); },
      ticketSecret: 's3cret', now: () => 1000
    };
    return { led, deps, calls, tickets, blocks, paused };
  }
  const ask = { headers, ip: '1.1.1.1', ask: 'move the notes left', board: '[]', requestId: 'r1' };

  const tests = [
    ['parseRoute: junk or unknown route falls back to draw', () => {
      assert.strictEqual(parseRoute('no json').job, 'draw');
      assert.strictEqual(parseRoute('{"route":"hack"}').job, 'draw');
      assert.strictEqual(parseRoute('{"route":"build","difficulty":"hard","stage":"x","tone":"y"}').difficulty, 'hard');
    }],
    ['route: happy path returns a ticket and job, never a model name, and settles to real cost', async () => {
      const w = world();
      const r = await route(w.deps, ask);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.job, 'edit');
      assert.strictEqual(r.body.firstAsk, true);
      assert.ok(!/model|sk-|"models"/i.test(JSON.stringify(r.body)));
      assert.strictEqual(w.led.s.holds.size, 0);
      assert.ok(Math.abs(w.led.s.settled[0][1] - 0.0002) < 1e-9);
    }],
    ['route: unauthorized is refused before any hold or call', async () => {
      const w = world();
      const r = await route(w.deps, { ...ask, headers: {} });
      assert.strictEqual(r.status, 401);
      assert.strictEqual(w.calls.length, 0);
    }],
    ['route: oversized payload is refused before a hold', async () => {
      const w = world();
      const r = await route(w.deps, { ...ask, board: 'x'.repeat(20001) });
      assert.strictEqual(r.status, 413);
      assert.strictEqual(w.led.s.settled.length + w.led.s.holds.size, 0);
    }],
    ['route: over the rate limit is refused', async () => {
      const r = await route(world({ preHits: 30 }).deps, ask);
      assert.deepStrictEqual([r.status, r.body.reason], [429, 'rate']);
    }],
    ['route: a named job skips the router but not the gate', async () => {
      const w = world();
      const r = await route(w.deps, { ...ask, job: 'build' });
      assert.strictEqual(r.body.job, 'build');
      assert.strictEqual(w.calls.filter((c) => /route requests/.test(c.sys)).length, 0);
      assert.strictEqual(w.calls.filter((c) => /safety check/.test(c.sys)).length, 1);
    }],
    ['route: router junk falls back to draw', async () => {
      const r = await route(world({ script: { router: 'banana' } }).deps, ask);
      assert.strictEqual(r.body.job, 'draw');
    }],
    ['route: a block is refused, recorded, and five in a day pause the person', async () => {
      const w = world({ script: { gate: '{"ok":false}' }, blockTimes: [999, 998, 997, 996] });
      const r = await route(w.deps, ask);
      assert.deepStrictEqual([r.status, r.body.reason], [422, 'blocked']);
      assert.deepStrictEqual(w.paused, ['u1']);
    }],
    ['route: a broken gate is a server problem and records no block', async () => {
      const w = world({ script: { gate: 'garbage' } });
      const r = await route(w.deps, ask);
      assert.deepStrictEqual([r.status, r.body.reason], [503, 'server']);
      assert.strictEqual(w.blocks.length, 0);
    }],
    ['route: not enough balance is refused at the hold, nothing is called', async () => {
      const w = world({ balance: 0 });
      const r = await route(w.deps, ask);
      assert.deepStrictEqual([r.status, r.body.reason], [402, 'insufficient']);
      assert.strictEqual(w.calls.length, 0);
    }],
    ['route: a low-confidence reply asks one short question and issues no ticket', async () => {
      const w = world({ script: { router: '{"route":"edit","confidence":0.3,"ask":"Change it or add to it?"}' } });
      const r = await route(w.deps, ask);
      assert.strictEqual(r.body.clarify, 'Change it or add to it?');
      assert.strictEqual(w.tickets.size, 0);
    }],
    ['run: ticket then call settles gate plus call to real cost; the reply text comes back', async () => {
      const w = world();
      const { body } = await route(w.deps, ask);
      const r = await run(w.deps, { headers, ticket: body.ticket, ask: ask.ask, board: '[]' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.text, '{"ops":[]}');
      assert.strictEqual(w.led.s.holds.size, 0);
      const runSettle = w.led.s.settled.find((x) => x[0].startsWith('run:'));
      assert.ok(Math.abs(runSettle[1] - 0.0021) < 1e-9);
    }],
    ['run: no ticket, a different ask, and another person are refused', async () => {
      const w = world();
      const { body } = await route(w.deps, ask);
      assert.strictEqual((await run(w.deps, { headers, ticket: '', ask: ask.ask })).status, 403);
      assert.strictEqual((await run(w.deps, { headers, ticket: body.ticket, ask: 'something else' })).body.reason, 'ticket_wrong_ask');
      const other = world(); other.deps.getTicket = async () => ({ person: 'u2', job: 'edit', pick: {} });
      assert.strictEqual((await run(other.deps, { headers, ticket: body.ticket, ask: ask.ask })).status, 403);
    }],
    ['run: an expired ticket is refused', async () => {
      const w = world();
      const { body } = await route(w.deps, ask);
      w.deps.now = () => 1000 + 6 * 60 * 1000;
      assert.strictEqual((await run(w.deps, { headers, ticket: body.ticket, ask: ask.ask })).body.reason, 'ticket_expired');
    }],
    ['run: cut-off on attempt 1, attempt 2 succeeds, both settle with their own cost, attempt 3 is refused', async () => {
      const w = world({ script: { job: [{ outcome: 'cut_off', text: 'par', cost: 0.001, generationId: 'g' }, { outcome: 'ok', text: 'done', cost: 0.002 }] } });
      const { body } = await route(w.deps, ask);
      const a = { headers, ticket: body.ticket, ask: ask.ask, board: '[]' };
      const r1 = await run(w.deps, a);
      assert.deepStrictEqual([r1.status, r1.body.canRetry, r1.body.attempt], [502, true, 1]);
      const r2 = await run(w.deps, a);
      assert.deepStrictEqual([r2.status, r2.body.text, r2.body.attempt], [200, 'done', 2]);
      assert.strictEqual(w.led.s.settled.filter((x) => x[0].startsWith('run:')).length, 2);
      const r3 = await run(w.deps, a);
      assert.deepStrictEqual([r3.status, r3.body.reason], [403, 'no_attempts_left']);
    }],
    ['run: an error before the call started costs nothing and the hold is released', async () => {
      const w = world({ script: { job: [{ outcome: 'error_before_start', text: '', cost: 0 }] } });
      const { body } = await route(w.deps, ask);
      await run(w.deps, { headers, ticket: body.ticket, ask: ask.ask });
      // the gate cost something, so the settle is the gate's; the job call added nothing
      const s = w.led.s.settled.find((x) => x[0].startsWith('run:'));
      assert.ok(Math.abs(s[1] - 0.0001) < 1e-9);
    }],
    ['run: an unknown outcome (dropped connection) keeps the hold for cleanup', async () => {
      const w = world({ script: { job: [{ outcome: 'unknown', text: '', cost: null, generationId: null }] } });
      const { body } = await route(w.deps, ask);
      const r = await run(w.deps, { headers, ticket: body.ticket, ask: ask.ask });
      assert.strictEqual(r.status, 502);
      assert.strictEqual([...w.led.s.holds.keys()].filter((k) => k.startsWith('run:')).length, 1);
    }],
    ['run: a blocked payload never reaches the job model', async () => {
      const w = world();
      const { body } = await route(w.deps, ask);
      w.calls.length = 0;
      w.deps.gateCall = async () => ({ outcome: 'ok', text: '{"ok":false}', cost: 0 });
      const r = await run(w.deps, { headers, ticket: body.ticket, ask: ask.ask });
      assert.strictEqual(r.body.reason, 'blocked');
      assert.strictEqual(w.calls.length, 0);
    }],
    ['route: six parallel asks never overdraw (the true 20-parallel test runs on the local stack)', async () => {
      const w = world({ balance: 0.005 });
      const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(async (i) => {
        const x = await route(w.deps, { ...ask, requestId: 'r' + i });
        return x;
      }));
      // every route hold settles; none leaves a negative balance
      assert.ok(w.led.s.balance >= 0);
      assert.ok(rs.every((x) => x.status === 200 || x.status === 402));
    }],
    ['modelsForAttempt: attempt 2 moves to the next model, and never runs out', () => {
      assert.deepStrictEqual(modelsForAttempt(['a', 'b', 'c'], 1), ['a', 'b', 'c']);
      assert.deepStrictEqual(modelsForAttempt(['a', 'b', 'c'], 2), ['b', 'c']);
      assert.deepStrictEqual(modelsForAttempt(['a'], 2), ['a']);
    }]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
