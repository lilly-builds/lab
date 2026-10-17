/* node ideas/ai-whiteboard/ai-route.test.js
   /route and /run on a scripted model and an in-memory ledger: refusals, holds that settle to real cost, tickets, two attempts,
   the first ask as an idea map, the board picture, usage rows, next moves. The same flows on a real database: ai-db.test.js. */
const assert = require('assert');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

(async () => {
  const D = './supabase/functions/_shared/';
  const { route, parseRoute, DEFAULT_ASK } = await import(D + 'route.mjs');
  const { run, modelsForAttempt } = await import(D + 'run.mjs');
  const { newPass } = await import(D + 'auth.mjs');
  const { fakeLedger } = await import(D + 'testing/fake-ledger.mjs');
  const { pick } = await import(D + 'rulebook.mjs');
  const P = await import(D + 'prompts.mjs');

  const env = { AI_ALLOW_PLACEHOLDERS: '1' };
  const pass = newPass();
  const headers = { authorization: 'Bearer ' + pass.pass };
  const PNG = 'iVBORw0KGgo=';

  // A scripted model: gate and router replies by system prompt; anything else is the job call.
  function world(over = {}) {
    const led = fakeLedger(over.balance == null ? 1 : over.balance);
    const calls = [], tickets = new Map(), hits = new Map(), blocks = [], paused = [], usage = new Map();
    const script = Object.assign({ gate: '{"ok":true}', router: '{"route":"edit","confidence":0.9,"difficulty":"hard"}', job: [{ outcome: 'ok', text: '{"ops":[]}', cost: 0.002, generationId: 'g-job', model: 'm/job' }] }, over.script);
    const jobQueue = script.job.slice();
    const call = async (p, messages, person, signal, hooks) => {
      const sys = messages[0].content;
      calls.push({ p, sys, messages });
      if (/safety check/.test(sys)) return { outcome: 'ok', text: script.gate, cost: 0.0001, generationId: 'g-gate', model: 'm/gate' };
      if (/route requests/.test(sys)) return { outcome: 'ok', text: script.router, cost: 0.0001, generationId: 'g-router', model: 'm/router' };
      const r = jobQueue.shift() || { outcome: 'ok', text: 'x', cost: 0.002, generationId: 'g-x', model: 'm/x' };
      if (hooks && r.generationId) hooks.onStart(r.generationId);
      if (hooks && hooks.onDelta && r.text) hooks.onDelta(r.text);
      return r;
    };
    const deps = {
      rpc: led.rpc, call, env, imageMode: 'native',
      gatePick: (hasImage) => pick('gate', {}, { hasImage }, 'u1', env),
      nextMovesPick: () => pick('nextmoves', {}, {}, 'u1', env),
      findByHash: async (h) => (h === pass.hash ? { id: 'u1', pass_hash: pass.hash } : null),
      hit: async (k) => { hits.set(k, (hits.get(k) || 0) + 1); return hits.get(k) + (over.preHits || 0); },
      isFirstAsk: async () => !!over.firstAsk,
      avoidModels: async () => over.avoid || [],
      storeTicket: async (x) => { tickets.set(x.id, x); },
      getTicket: async (id) => tickets.get(id) || null,
      recordBlock: async () => { blocks.push(1000); return (over.blockTimes || []).concat(blocks); },
      pause: async (p) => { paused.push(p); },
      usage: {
        start: async (u) => { usage.set(u.id, { ...u }); },
        seen: async (u) => { usage.get(u.id).generationId = u.generationId; },
        finish: async (u) => { Object.assign(usage.get(u.id), u); }
      },
      ticketSecret: 's3cret', now: () => 1000
    };
    return { led, deps, calls, tickets, blocks, paused, usage };
  }
  const ask = { headers, ip: '1.1.1.1', ask: 'move the notes left', summary: { counts: { note: 2 } }, requestId: 'r1' };
  const runIn = (body, extra) => Object.assign({ headers, ticket: body.ticket, ask: ask.ask, board: '{"elements":[]}' }, extra);
  const jobCalls = (w) => w.calls.filter((c) => !/safety check|route requests/.test(c.sys));

  const tests = [
    ['parseRoute: reads like the browser\'s, junk and unknown routes are null, steps keep at most two known routes', () => {
      assert.strictEqual(parseRoute('no json'), null);
      assert.strictEqual(parseRoute('{"route":"hack"}'), null);
      assert.deepStrictEqual(parseRoute('{"route":"build","steps":["build","edit","x"],"difficulty":"hard"}').steps, ['build', 'edit']);
      assert.strictEqual(parseRoute('{"route":"draw"}').confidence, 0.8);
      assert.strictEqual(parseRoute('text {"route":"edit","difficulty":"weird"} more').difficulty, 'normal');
    }],
    ['route: happy path returns a ticket, job and steps, never a model name, and settles gate plus router to real cost', async () => {
      const w = world();
      const r = await route(w.deps, ask);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual([r.body.job, r.body.steps, r.body.firstAsk], ['edit', ['edit'], false]);
      assert.ok(!/placeholder|m\/|sk-|"models"/i.test(JSON.stringify(r.body)));
      assert.strictEqual(w.led.s.holds.size, 0);
      assert.ok(Math.abs(w.led.s.settled[0][1] - 0.0002) < 1e-9);
    }],
    ['route: the router sees the browser\'s message shape and the difficulty clue; a hard ask moves to a frontier model', async () => {
      const w = world();
      const r = await route(w.deps, ask);
      const rc = w.calls.find((c) => /route requests/.test(c.sys));
      assert.strictEqual(rc.messages[1].content, JSON.stringify({ request: ask.ask, board: ask.summary }));
      assert.ok(rc.sys.startsWith(P.buildRouteSystem(P.ROUTER_ROUTES)) && rc.sys.includes('difficulty'));
      const stored = [...w.tickets.values()][0];
      assert.strictEqual(stored.pick.models[0], 'placeholder/frontier-vision');
      assert.strictEqual(stored.askHash.length, 64);
      assert.ok(r.body.ticket);
    }],
    ['route: the first ask ever from the ask box becomes an idea map, and the router is not called', async () => {
      const w = world({ firstAsk: true });
      const r = await route(w.deps, { ...ask, hasImage: true });
      assert.deepStrictEqual([r.body.job, r.body.steps, r.body.firstAsk], ['ideamap', ['ideamap'], true]);
      assert.strictEqual(w.calls.filter((c) => /route requests/.test(c.sys)).length, 0);
      const stored = [...w.tickets.values()][0];
      assert.ok(stored.pick.models.every((m) => /vision/.test(m)), 'an idea map with a board picture uses image-capable models');
    }],
    ['route: a named job is never turned into an idea map, skips the router, keeps the gate', async () => {
      const w = world({ firstAsk: true });
      const r = await route(w.deps, { ...ask, job: 'build' });
      assert.strictEqual(r.body.job, 'build');
      assert.strictEqual(w.calls.filter((c) => /route requests/.test(c.sys)).length, 0);
      assert.strictEqual(w.calls.filter((c) => /safety check/.test(c.sys)).length, 1);
    }],
    ['route: an unknown named job, an empty ask and a missing request id are refused before any call', async () => {
      const w = world();
      assert.strictEqual((await route(w.deps, { ...ask, job: 'ideamap' })).body.reason, 'unknown_job');
      assert.strictEqual((await route(w.deps, { ...ask, ask: '  ' })).body.reason, 'empty');
      assert.strictEqual((await route(w.deps, { ...ask, requestId: '' })).status, 500);
      assert.strictEqual(w.calls.length, 0);
    }],
    ['route: unauthorized is refused before any hold or call', async () => {
      const w = world();
      const r = await route(w.deps, { ...ask, headers: {} });
      assert.strictEqual(r.status, 401);
      assert.strictEqual(w.calls.length, 0);
    }],
    ['route: an oversized ask or summary is refused before a hold', async () => {
      const w = world();
      assert.strictEqual((await route(w.deps, { ...ask, ask: 'x'.repeat(2001) })).status, 413);
      assert.strictEqual((await route(w.deps, { ...ask, summary: { t: 'x'.repeat(5000) } })).status, 413);
      assert.strictEqual(w.led.s.settled.length + w.led.s.holds.size, 0);
    }],
    ['route: over the rate limit is refused', async () => {
      const r = await route(world({ preHits: 30 }).deps, ask);
      assert.deepStrictEqual([r.status, r.body.reason], [429, 'rate']);
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
    ['route: a question in the reply, or low confidence, asks once; the default question fills in; no ticket', async () => {
      const w = world({ script: { router: '{"route":"edit","confidence":0.9,"ask":"Change it or add to it?"}' } });
      assert.strictEqual((await route(w.deps, ask)).body.clarify, 'Change it or add to it?');
      const w2 = world({ script: { router: '{"route":"edit","confidence":0.3}' } });
      assert.strictEqual((await route(w2.deps, ask)).body.clarify, DEFAULT_ASK);
      assert.strictEqual(w.tickets.size + w2.tickets.size, 0);
    }],
    ['route: after the person answered one question, an unsure router falls back to draw instead of asking again', async () => {
      const w = world({ script: { router: '{"route":"edit","confidence":0.3,"ask":"Again?"}' } });
      const r = await route(w.deps, { ...ask, second: true });
      assert.deepStrictEqual([r.body.clarify, r.body.job], [undefined, 'draw']);
    }],
    ['route: a two-step reply comes back as steps; the ticket is for the first', async () => {
      const w = world({ script: { router: '{"route":"build","confidence":0.9,"steps":["build","edit"]}' } });
      const r = await route(w.deps, ask);
      assert.deepStrictEqual([r.body.job, r.body.steps], ['build', ['build', 'edit']]);
    }],
    ['route: models failing too often are skipped', async () => {
      const w = world({ avoid: ['placeholder/frontier-vision'] });
      await route(w.deps, ask);
      assert.ok(![...w.tickets.values()][0].pick.models.includes('placeholder/frontier-vision'));
    }],
    ['usage rows: one per call, with job, cost, outcome and generation, and never any text', async () => {
      const w = world();
      const { body } = await route(w.deps, ask);
      await run(w.deps, runIn(body));
      const rows = [...w.usage.values()];
      assert.deepStrictEqual(rows.map((u) => u.job).sort(), ['edit', 'gate', 'gate', 'router']);
      const jobRow = rows.find((u) => u.job === 'edit');
      assert.deepStrictEqual([jobRow.cost, jobRow.outcome, jobRow.generationId, jobRow.model], [0.002, 'ok', 'g-job', 'm/job']);
      assert.ok(!JSON.stringify(rows).includes(ask.ask) && !JSON.stringify(rows).includes('{"ops":[]}'));
    }],
    ['run: ticket then call settles gate plus call to real cost; the reply text comes back and streams through onDelta', async () => {
      const w = world();
      const { body } = await route(w.deps, ask);
      const deltas = [];
      const r = await run(w.deps, runIn(body, { onDelta: (d) => deltas.push(d) }));
      assert.deepStrictEqual([r.status, r.body.text, r.body.job], [200, '{"ops":[]}', 'edit']);
      assert.deepStrictEqual(deltas, ['{"ops":[]}']);
      assert.strictEqual(w.led.s.holds.size, 0);
      const runSettle = w.led.s.settled.find((x) => x[0].startsWith('run:'));
      assert.ok(Math.abs(runSettle[1] - 0.0021) < 1e-9);
    }],
    ['run: the job model gets the server prompt and the browser-shaped message', async () => {
      const w = world();
      const { body } = await route(w.deps, ask);
      await run(w.deps, runIn(body));
      const jc = jobCalls(w)[0];
      assert.ok(jc.sys.startsWith(P.SYSTEM_EDIT));
      assert.strictEqual(jc.messages[1].content, ask.ask + '\n\nBoard JSON:\n{"elements":[]}');
    }],
    ['run: a draw with the board picture sends it to the job model and to the gate', async () => {
      const w = world({ script: { router: '{"route":"draw","confidence":0.9}', job: [{ outcome: 'ok', text: '{"add":[]}', cost: 0.003 }] } });
      const { body } = await route(w.deps, { ...ask, hasImage: true });
      await run(w.deps, runIn(body, { image: PNG, advanceEm: 0.6 }));
      const jc = jobCalls(w)[0];
      assert.deepStrictEqual(jc.messages[1].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } });
      const gc = w.calls.filter((c) => /safety check/.test(c.sys)).pop();
      assert.ok(Array.isArray(gc.messages[1].content), 'the gate saw the picture');
    }],
    ['run: the gate sees every character the job model sees, even at the board size limit', async () => {
      const { LIMITS } = await import(D + 'route.mjs');
      const w = world({ balance: 10 });
      const { body } = await route(w.deps, ask);
      const board = 'x'.repeat(LIMITS.boardChars - 20) + 'END-MARKER-ZZ';
      const r = await run(w.deps, runIn(body, { board }));
      assert.strictEqual(r.status, 200);
      const gc = w.calls.filter((c) => /safety check/.test(c.sys)).pop();
      assert.ok(gc.messages[1].content.includes('END-MARKER-ZZ'), 'the end of the board reached the gate');
      assert.ok(gc.messages[1].content.includes(jobCalls(w)[0].messages[1].content), 'the whole job message is inside the gate message');
    }],
    ['route: the gate sees the router\'s whole input, board summary included', async () => {
      const w = world();
      await route(w.deps, { ...ask, summary: { recentTexts: ['SUMMARY-MARKER'] } });
      const gc = w.calls.find((c) => /safety check/.test(c.sys));
      assert.ok(gc.messages[1].content.includes('SUMMARY-MARKER'));
    }],
    ['gate: text longer than the gate can read is refused, never cut short', async () => {
      const g = await import(D + 'gate.mjs');
      assert.throws(() => g.gateMessages('y'.repeat(g.GATE_MAX_CHARS + 1)), /too long/);
      const { LIMITS } = await import(D + 'route.mjs');
      assert.ok(LIMITS.askChars + LIMITS.boardChars + 200 <= g.GATE_MAX_CHARS, 'every allowed payload fits the gate whole');
    }],
    ['run: an edit ignores a picture the browser sent', async () => {
      const w = world();
      const { body } = await route(w.deps, ask);
      await run(w.deps, runIn(body, { image: PNG }));
      assert.strictEqual(typeof jobCalls(w)[0].messages[1].content, 'string');
    }],
    ['run: the first ask runs the idea-map prompt', async () => {
      const w = world({ firstAsk: true, script: { job: [{ outcome: 'ok', text: '{"add":[]}', cost: 0.003 }] } });
      const { body } = await route(w.deps, ask);
      const r = await run(w.deps, runIn(body, { advanceEm: 0.6 }));
      assert.strictEqual(r.body.job, 'ideamap');
      assert.ok(jobCalls(w)[0].sys.includes(P.IDEAMAP_RULE));
    }],
    ['run: no ticket, a different ask, and another person are refused', async () => {
      const w = world();
      const { body } = await route(w.deps, ask);
      assert.strictEqual((await run(w.deps, { headers, ticket: '', ask: ask.ask })).status, 403);
      assert.strictEqual((await run(w.deps, runIn(body, { ask: 'something else' }))).body.reason, 'ticket_wrong_ask');
      const other = world(); other.deps.getTicket = async () => ({ person: 'u2', job: 'edit', pick: {} });
      assert.strictEqual((await run(other.deps, runIn(body))).status, 403);
    }],
    ['run: an expired ticket is refused', async () => {
      const w = world();
      const { body } = await route(w.deps, ask);
      w.deps.now = () => 1000 + 16 * 60 * 1000;
      assert.strictEqual((await run(w.deps, runIn(body))).body.reason, 'ticket_expired');
    }],
    ['run: cut-off on attempt 1, attempt 2 uses the next model and succeeds, both settle with their own cost, attempt 3 is refused', async () => {
      const w = world({ script: { job: [{ outcome: 'cut_off', text: 'par', cost: 0.001, generationId: 'g' }, { outcome: 'ok', text: 'done', cost: 0.002 }] } });
      const { body } = await route(w.deps, ask);
      const r1 = await run(w.deps, runIn(body));
      assert.deepStrictEqual([r1.status, r1.body.canRetry, r1.body.attempt, r1.body.reason], [502, true, 1, 'cut_off']);
      const r2 = await run(w.deps, runIn(body));
      assert.deepStrictEqual([r2.status, r2.body.text, r2.body.attempt], [200, 'done', 2]);
      const [j1, j2] = jobCalls(w);
      assert.notStrictEqual(j1.p.models[0], j2.p.models[0]);
      assert.strictEqual(w.led.s.settled.filter((x) => x[0].startsWith('run:')).length, 2);
      const r3 = await run(w.deps, runIn(body));
      assert.deepStrictEqual([r3.status, r3.body.reason], [403, 'no_attempts_left']);
    }],
    ['run: an error before the call started costs nothing and the hold is released', async () => {
      const w = world({ script: { job: [{ outcome: 'error_before_start', text: '', cost: 0 }] } });
      const { body } = await route(w.deps, ask);
      await run(w.deps, runIn(body));
      // the gate cost something, so the settle is the gate's; the job call added nothing
      const s = w.led.s.settled.find((x) => x[0].startsWith('run:'));
      assert.ok(Math.abs(s[1] - 0.0001) < 1e-9);
    }],
    ['run: an unknown outcome (dropped connection) keeps the hold for cleanup, with the usage row left to look up', async () => {
      const w = world({ script: { job: [{ outcome: 'unknown', text: '', cost: null, generationId: null }] } });
      const { body } = await route(w.deps, ask);
      const r = await run(w.deps, runIn(body));
      assert.strictEqual(r.status, 502);
      const open = [...w.led.s.holds.keys()].filter((k) => k.startsWith('run:'));
      assert.strictEqual(open.length, 1);
      assert.ok([...w.usage.values()].some((u) => u.holdId === open[0] && u.outcome === 'unknown'));
    }],
    ['run: a blocked payload never reaches the job model', async () => {
      const w = world();
      const { body } = await route(w.deps, ask);
      w.calls.length = 0;
      w.deps.call = async (p, m) => { w.calls.push({ sys: m[0].content, messages: m }); return { outcome: 'ok', text: '{"ok":false}', cost: 0 }; };
      const r = await run(w.deps, runIn(body));
      assert.strictEqual(r.body.reason, 'blocked');
      assert.strictEqual(jobCalls(w).length, 0);
    }],
    ['run: a finished build hands back one next-moves ticket that runs once', async () => {
      const w = world({ script: { job: [{ outcome: 'ok', text: '<html></html>', cost: 0.01 }, { outcome: 'ok', text: '{"next":["add a dark mode"]}', cost: 0.0005 }] } });
      const { body } = await route(w.deps, { ...ask, job: 'build' });
      const b = await run(w.deps, runIn(body));
      assert.ok(b.body.next, 'a child ticket');
      const nm = await run(w.deps, { headers, ticket: b.body.next, ask: ask.ask });
      assert.deepStrictEqual([nm.body.job, nm.body.text], ['nextmoves', '{"next":["add a dark mode"]}']);
      assert.strictEqual(jobCalls(w)[1].sys, P.NEXTMOVES_SYSTEM);
      const again = await run(w.deps, runIn(body));
      assert.strictEqual(again.status, 200);
      assert.ok(!again.body.next, 'a repeated build never issues a second child');
    }],
    ['run: next moves can be switched off', async () => {
      const w = world({ script: { job: [{ outcome: 'ok', text: '<html></html>', cost: 0.01 }] } });
      w.deps.env = { ...env, AI_NEXT_MOVES: 'off' };
      const { body } = await route(w.deps, { ...ask, job: 'build' });
      const b = await run(w.deps, runIn(body));
      assert.strictEqual(b.body.next, undefined);
    }],
    ['route: six parallel asks never overdraw (the true 20-parallel test is in ai-db.test.js)', async () => {
      const w = world({ balance: 0.005 });
      const rs = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => route(w.deps, { ...ask, requestId: 'r' + i })));
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
