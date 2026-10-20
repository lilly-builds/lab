/* node ideas/ai-whiteboard/ai-client.test.js
   The browser's AI Magic Toolbox client (ai-client.js, build plan 1.13): the on/off switch, the streamed /run reader, plain-words errors,
   the second attempt, and that nothing reaches the AI without a named job or a ticket (I8). Runs the real file in a sandbox with a fake
   fetch; no browser, no network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

const SRC = fs.readFileSync(path.join(__dirname, 'ai-client.js'), 'utf8');
const pure = (() => {
  const a = SRC.indexOf('/* AICLIENT-PURE-BEGIN'), b = SRC.indexOf('/* AICLIENT-PURE-END */');
  return new Function(SRC.slice(a, b) + '\nreturn { mode: mode, endpoints: endpoints, takeLines: takeLines, errorFor: errorFor };')();
})();

// The whole file in a sandbox: window, location and fetch are stand-ins. script(url, body) answers each request.
function load({ search = '', hostname = 'lilly-builds.github.io', cfg = { url: 'https://abc.supabase.co', anonKey: 'pk', toolboxEnabled: true }, script }) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body, headers: init.headers });
    const r = await script(url, body, calls.length);
    if (r.ndjson) return new Response(r.ndjson.map((l) => JSON.stringify(l)).join('\n') + '\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    // broken: these lines arrive, then the connection drops while the body is still being read
    if (r.broken) {
      let sent = false;
      return new Response(new ReadableStream({ pull(c) {
        if (sent) { c.error(new TypeError('network connection was lost')); return; }
        sent = true; c.enqueue(new TextEncoder().encode(r.broken.map((l) => JSON.stringify(l)).join('\n') + '\n'));
      } }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }
    return new Response(JSON.stringify(r.json), { status: r.status || 200, headers: { 'content-type': 'application/json' } });
  };
  const window = { AIWB_SUPABASE: cfg };
  const ctx = { window, location: { search, hostname, origin: 'https://' + hostname }, fetch, Response, TextDecoder, Error, JSON, Number, String, Promise, Array };
  vm.runInNewContext(SRC, ctx);
  return { T: window.AIToolbox, calls };
}
const done = (o) => ({ t: 'done', status: 200, ok: true, ...o });

(async () => {
  const tests = [
    ['switch: off unless turned on; ?toolbox=off always wins; local works only on this computer', () => {
      const cfg = { url: 'https://abc.supabase.co' };
      assert.strictEqual(pure.mode(cfg, '', 'lilly-builds.github.io'), 'off');
      assert.strictEqual(pure.mode({ ...cfg, toolboxEnabled: true }, '', 'x'), 'on');
      assert.strictEqual(pure.mode(cfg, '?toolbox=on', 'x'), 'on');
      assert.strictEqual(pure.mode({ ...cfg, toolboxEnabled: true }, '?a=1&toolbox=off', 'x'), 'off');
      assert.strictEqual(pure.mode(cfg, '?toolbox=local', 'localhost'), 'local');
      assert.strictEqual(pure.mode(cfg, '?toolbox=local', 'lilly-builds.github.io'), 'off');
      assert.strictEqual(pure.mode({}, '?toolbox=on', 'x'), 'off', 'no project url, nothing to call');
    }],
    ['endpoints: the hosted project, or this computer\'s dev server', () => {
      assert.deepStrictEqual(pure.endpoints('on', { url: 'https://abc.supabase.co/', anonKey: 'pk' }, 'https://o'), { fn: 'https://abc.supabase.co/functions/v1', rest: 'https://abc.supabase.co/rest/v1', apikey: 'pk' });
      assert.strictEqual(pure.endpoints('local', {}, 'http://localhost:8787').fn, 'http://localhost:8787/functions/v1');
    }],
    ['stream reader keeps a partial line for the next chunk and skips a broken one', () => {
      const a = pure.takeLines('{"t":"delta","d":"a"}\n{"t":"de');
      assert.deepStrictEqual([a.lines, a.rest], [[{ t: 'delta', d: 'a' }], '{"t":"de']);
      assert.deepStrictEqual(pure.takeLines('not json\n{"t":"tick"}\n').lines, [{ t: 'tick' }]);
    }],
    ['errors are plain words; a paused pass is not treated as a bad pass; every error is final', () => {
      const paused = pure.errorFor({ reason: 'paused' }, 403);
      assert.strictEqual(paused.status, 423);
      assert.ok(/paused/.test(paused.message) && paused.final);
      assert.strictEqual(pure.errorFor({ reason: 'unknown' }, 401).status, 401);
      assert.ok(/credit/.test(pure.errorFor({ reason: 'insufficient' }, 402).message));
      const cut = pure.errorFor({ reason: 'cut_off', status: 502 });
      assert.deepStrictEqual([cut.kind, cut.final], ['cut', true]);
      assert.ok(/twice/.test(pure.errorFor({ reason: 'unknown', status: 502 }).message));
      assert.ok(/snag/.test(pure.errorFor(null, 500).message));
    }],
    ['the toolbox joins the providers only when switched on, with no model fields', () => {
      assert.strictEqual(load({ cfg: { url: 'https://abc.supabase.co' }, script: () => ({}) }).T.enabled(), false);
      const { T } = load({ script: () => ({}) });
      assert.deepStrictEqual([T.enabled(), T.provider.id, T.provider.noModels], [true, 'toolbox', true]);
    }],
    ['I8: an ask with neither a ticket nor a named job never leaves the browser', async () => {
      const { T, calls } = load({ script: () => ({ json: { ok: true } }) });
      await assert.rejects(T.provider.complete({ key: 'tp_x', text: 'hi' }), /No job/);
      assert.strictEqual(calls.length, 0);
    }],
    ['a named job: /route with the job, then /run streams; ticks are not answer text', async () => {
      const chunks = [];
      const { T, calls } = load({ script: (url) => url.endsWith('/route') ? { json: { ok: true, ticket: 'TK', job: 'plan' } }
        : { ndjson: [{ t: 'delta', d: '{"goal":' }, { t: 'tick' }, { t: 'delta', d: '"x"}' }, done({ text: '{"goal":"x"}', job: 'plan' })] } });
      const text = await T.provider.complete({ key: 'tp_x', job: 'plan', ask: 'bake', onChunk: () => chunks.push(1) });
      assert.strictEqual(text, '{"goal":"x"}');
      assert.strictEqual(chunks.length, 2);
      assert.deepStrictEqual(calls.map((c) => c.url), ['https://abc.supabase.co/functions/v1/route', 'https://abc.supabase.co/functions/v1/run']);
      assert.deepStrictEqual([calls[0].body.job, calls[1].body.ticket, calls[1].body.ask, calls[0].headers.authorization], ['plan', 'TK', 'bake', 'Bearer tp_x']);
    }],
    ['a failed first attempt runs the second on the same ticket, with no new /route', async () => {
      const seen = [];
      const { T, calls } = load({ script: (url, b, i) => url.endsWith('/route') ? { json: { ok: true, ticket: 'TK' } }
        : i === 2 ? { ndjson: [{ t: 'delta', d: 'par' }, { t: 'done', status: 502, ok: false, reason: 'cut_off', canRetry: true }] }
          : { ndjson: [{ t: 'delta', d: 'full' }, done({ text: 'full', job: 'todo' })] } });
      const text = await T.provider.stream({ key: 'tp_x', job: 'todo', ask: 'call mom' }, (s) => seen.push(s));
      assert.strictEqual(text, 'full');
      assert.deepStrictEqual(calls.map((c) => c.url.split('/').pop()), ['route', 'run', 'run']);
      assert.deepStrictEqual(seen, ['par', '', 'full'], 'the partial text is cleared before attempt 2');
    }],
    ['both attempts failing ends with plain words and no third try', async () => {
      const { T, calls } = load({ script: (url, b, i) => url.endsWith('/route') ? { json: { ok: true, ticket: 'TK' } }
        : { ndjson: [{ t: 'done', status: 502, ok: false, reason: 'cut_off', attempt: i - 1, canRetry: i === 2 }] } });
      await assert.rejects(T.provider.complete({ key: 'tp_x', job: 'draw', ask: 'x' }), (e) => /twice/.test(e.message) && e.final === true);
      assert.strictEqual(calls.filter((c) => c.url.endsWith('/run')).length, 2);
    }],
    ['a stream that stops before its done line counts as a cut-off and is retried', async () => {
      const { T, calls } = load({ script: (url, b, i) => url.endsWith('/route') ? { json: { ok: true, ticket: 'TK' } }
        : i === 2 ? { ndjson: [{ t: 'delta', d: 'half' }] } : { ndjson: [done({ text: 'whole', job: 'draw' })] } });
      assert.strictEqual(await T.provider.complete({ key: 'tp_x', job: 'draw', ask: 'x' }), 'whole');
      assert.strictEqual(calls.length, 3);
    }],
    ['two streams that stop before their done line end as a cut-off, never as a bad pass', async () => {
      const { T, calls } = load({ script: (url) => url.endsWith('/route') ? { json: { ok: true, ticket: 'TK' } } : { ndjson: [{ t: 'delta', d: 'half' }] } });
      await assert.rejects(T.provider.complete({ key: 'tp_x', job: 'build', ask: 'x' }),
        (e) => e.reason === 'cut_off' && e.status === 502 && e.final === true && /twice/.test(e.message));
      assert.strictEqual(calls.filter((c) => c.url.endsWith('/run')).length, 2);
    }],
    ['a 403 refusal that is not a paused pass (spent or expired ticket) never reads as a bad pass', () => {
      for (const reason of ['ticket_expired', 'ticket_unknown', 'ticket_wrong_ask', 'no_attempts_left']) {
        const e = pure.errorFor({ reason }, 403);
        assert.ok(e.status !== 401 && e.status !== 403, reason + ' kept status ' + e.status);
      }
    }],
    ['a connection that drops mid-stream counts as a cut-off and is retried', async () => {
      const { T, calls } = load({ script: (url, b, i) => url.endsWith('/route') ? { json: { ok: true, ticket: 'TK' } }
        : i === 2 ? { broken: [{ t: 'delta', d: 'half' }] } : { ndjson: [done({ text: 'whole', job: 'draw' })] } });
      assert.strictEqual(await T.provider.complete({ key: 'tp_x', job: 'draw', ask: 'x' }), 'whole');
      assert.deepStrictEqual(calls.map((c) => c.url.split('/').pop()), ['route', 'run', 'run']);
    }],
    ['a Stop while the stream is being read stays a Stop: no second attempt', async () => {
      const ac = new AbortController();
      const { T, calls } = load({ script: (url) => { if (url.endsWith('/route')) return { json: { ok: true, ticket: 'TK' } }; ac.abort(); return { broken: [{ t: 'delta', d: 'half' }] }; } });
      await assert.rejects(T.provider.complete({ key: 'tp_x', job: 'draw', ask: 'x', signal: ac.signal }), /connection was lost/);
      assert.strictEqual(calls.filter((c) => c.url.endsWith('/run')).length, 1);
    }],
    ['a refusal at /route (out of credit) is plain words with its status', async () => {
      const { T } = load({ script: () => ({ status: 402, json: { ok: false, reason: 'insufficient' } }) });
      await assert.rejects(T.provider.complete({ key: 'tp_x', job: 'build', ask: 'x' }), (e) => e.status === 402 && /credit/.test(e.message));
    }],
    ['the ask box passes its own ticket, so /route is not called twice', async () => {
      const { T, calls } = load({ script: () => ({ ndjson: [done({ text: '{}', job: 'draw' })] }) });
      await T.provider.complete({ key: 'tp_x', ticket: 'FROM-ROUTE', ask: 'x', board: '{"a":1}', imagePng: 'AAAA', advanceEm: 0.6 });
      assert.deepStrictEqual(calls.map((c) => c.url.split('/').pop()), ['run']);
      assert.deepStrictEqual([calls[0].body.board, calls[0].body.image, calls[0].body.advanceEm], ['{"a":1}', 'AAAA', 0.6]);
    }],
    ['verify asks the balance door: a number is a live pass, null is not', async () => {
      const live = load({ script: (url) => ({ json: url.endsWith('/rpc/my_balance') ? 4.2 : null }) });
      assert.strictEqual(await live.T.provider.verify('tp_x'), true);
      assert.deepStrictEqual(live.calls[0].body, { p_pass: 'tp_x' });
      const dead = load({ script: () => ({ json: null }) });
      assert.strictEqual(await dead.T.provider.verify('tp_x'), false);
    }],
    ['next moves after a build use its child ticket once; outcome posts a code for the newest answer', async () => {
      const { T, calls } = load({ script: (url, b) => url.endsWith('/route') ? { json: { ok: true, ticket: 'TK' } }
        : url.endsWith('/outcome') ? { json: { ok: true } }
        : b.ticket === 'CHILD' ? { ndjson: [done({ text: '{"next":["add a dark mode"]}', job: 'nextmoves' })] }
        : { ndjson: [done({ text: '<html></html>', job: 'build', next: 'CHILD' })] } });
      await T.provider.complete({ key: 'tp_x', job: 'build', ask: 'tip calculator' });
      assert.deepStrictEqual(await T.nextMoves('tp_x'), ['add a dark mode']);
      assert.strictEqual(calls.pop().body.ask, 'tip calculator', 'the child ticket runs on the same idea');
      T.outcome('tp_x', 'undo');
      await new Promise((r) => setTimeout(r, 0));
      assert.deepStrictEqual(calls.pop().body, { ticket: 'CHILD', code: 'undo' });
    }],
    ['next moves that finish after a newer ask started are dropped, and never replace the newer answer', async () => {
      let release; const held = new Promise((r) => { release = r; });
      const { T } = load({ script: async (url, b) => url.endsWith('/route') ? { json: { ok: true, ticket: 'TK2' } }
        : b.ticket === 'CHILD' ? (await held, { ndjson: [done({ text: '{"next":["stale idea"]}', job: 'nextmoves' })] })
        : b.ticket === 'TK2' ? { ndjson: [done({ text: '{}', job: 'draw' })] }
        : { ndjson: [done({ text: '<html></html>', job: 'build', next: 'CHILD' })] } });
      await T.provider.complete({ key: 'tp_x', ticket: 'TK1', ask: 'tip calculator' });
      const late = T.nextMoves('tp_x');
      await new Promise((r) => setTimeout(r, 0));
      await T.provider.complete({ key: 'tp_x', job: 'draw', ask: 'a newer ask' });
      release();
      assert.strictEqual(JSON.stringify(await late), '[]'); // an array from the sandbox's realm, so compared as text
      assert.strictEqual(T.last().ticket, 'TK2', 'the newer answer stays the one outcomes are logged against');
    }],
    ['next moves asked for twice at once run the child ticket once', async () => {
      const { T, calls } = load({ script: (url, b) => b.ticket === 'CHILD' ? { ndjson: [done({ text: '{"next":["x"]}', job: 'nextmoves' })] }
        : { ndjson: [done({ text: '<html></html>', job: 'build', next: 'CHILD' })] } });
      await T.provider.complete({ key: 'tp_x', ticket: 'TB', ask: 'app' });
      const both = await Promise.all([T.nextMoves('tp_x'), T.nextMoves('tp_x')]);
      assert.strictEqual(JSON.stringify(both), '[["x"],[]]');
      assert.strictEqual(calls.filter((c) => c.body && c.body.ticket === 'CHILD').length, 1);
    }],
    ['two builds that overlap: each answer that lands is the newest, and each build\'s next moves use its own child ticket, once', async () => {
      let releaseA, releaseCB;
      const heldA = new Promise((r) => { releaseA = r; }), heldCB = new Promise((r) => { releaseCB = r; });
      const { T, calls } = load({ script: async (url, b) => {
        if (b.ticket === 'TA') { await heldA; return { ndjson: [done({ text: '<html>A</html>', job: 'build', next: 'CA' })] }; }
        if (b.ticket === 'TB') return { ndjson: [done({ text: '<html>B</html>', job: 'build', next: 'CB' })] };
        if (b.ticket === 'CB') { await heldCB; return { ndjson: [done({ text: '{"next":["idea for B"]}', job: 'nextmoves' })] }; }
        return { ndjson: [done({ text: '{"next":["idea for A"]}', job: 'nextmoves' })] };
      } });
      const a = T.provider.complete({ key: 'tp_x', ticket: 'TA', ask: 'app A' });
      await T.provider.complete({ key: 'tp_x', ticket: 'TB', ask: 'app B' });
      const lateB = T.nextMoves('tp_x');           // B's follow-up, held
      await new Promise((r) => setTimeout(r, 0));
      releaseA(); await a;                          // A lands after B: A is now the newest answer
      assert.strictEqual(T.last().ticket, 'TA', 'a build that lands last is the newest answer, so an undo is logged against it');
      const forA = await T.nextMoves('tp_x');
      releaseCB();
      assert.strictEqual(JSON.stringify(forA), '["idea for A"]');
      assert.strictEqual(JSON.stringify(await lateB), '[]', 'B\'s follow-up landed after a newer answer');
      const runs = calls.filter((c) => c.url.endsWith('/run')).map((c) => c.body.ticket);
      assert.strictEqual(runs.filter((x) => x === 'CB').length, 1, 'a child ticket is used once: ' + runs.join(' '));
      assert.ok(runs.includes('CA'), 'A\'s own child ticket ran');
    }]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
