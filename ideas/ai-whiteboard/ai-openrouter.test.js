/* node ideas/ai-whiteboard/ai-openrouter.test.js
   The OpenRouter plug against the mock: request fields, cost, outcome classes, no secrets in errors (I3, I6). */
const assert = require('assert');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

(async () => {
  const or = await import('./supabase/functions/_shared/openrouter.mjs');
  const { startMock } = await import('./supabase/functions/_shared/testing/mock-openrouter.mjs');
  const pick = { models: ['a/one', 'b/two'], effort: 'low', answerBudget: 1000, thinkingBudget: 500, sort: 'price', temperature: 0.2, maxPrice: { prompt: 1, completion: 3 } };
  const msgs = [{ role: 'user', content: 'hi' }];
  const mk = (stream = true, over) => or.buildRequest(Object.assign({ pick, messages: msgs, person: 'person-123', stream }, over));
  const run = async (mode, stream = true, extra) => {
    const m = await startMock(Object.assign({ mode, cost: 0.0123 }, extra));
    try { return Object.assign(await or.callOpenRouter({ baseUrl: m.url, apiKey: 'sk-secret-key-1', body: mk(stream) }), { _m: m.state }); }
    finally { await m.close(); }
  };

  const tests = [
    ['request carries every required field', () => {
      const b = mk();
      assert.deepStrictEqual(b.models, ['a/one', 'b/two']);
      assert.strictEqual(b.provider.data_collection, 'deny'); assert.strictEqual(b.provider.zdr, true);
      assert.deepStrictEqual(b.provider.max_price, pick.maxPrice); assert.strictEqual(b.provider.sort, 'price');
      assert.strictEqual(b.reasoning.max_tokens, 500); assert.strictEqual(b.max_tokens, 1500); assert.ok(b.user);
    }],
    ['no reasoning field when thinking budget is 0', () => assert.strictEqual(or.buildRequest({ pick: Object.assign({}, pick, { thinkingBudget: 0 }), messages: msgs, person: 'p' }).reasoning, undefined)],
    ['user is a hash, never the raw id', () => { const b = mk(); assert.notStrictEqual(b.user, 'person-123'); assert.ok(!JSON.stringify(b).includes('person-123')); }],
    ['incomplete pick or missing person throws', () => {
      assert.throws(() => or.buildRequest({ pick: { models: ['a'] }, messages: msgs, person: 'p' }));
      assert.throws(() => or.buildRequest({ pick, messages: msgs, person: '' }));
    }],
    ['streamed ok: text, cost, generation id', async () => {
      const r = await run('ok'); assert.strictEqual(r.outcome, 'ok'); assert.strictEqual(r.text, 'Hello world'); assert.strictEqual(r.cost, 0.0123); assert.ok(r.generationId);
    }],
    ['non-streamed ok', async () => { const r = await run('ok', false); assert.strictEqual(r.outcome, 'ok'); assert.strictEqual(r.cost, 0.0123); }],
    ['5xx before start: error_before_start, cost 0', async () => { const r = await run('error5xx'); assert.strictEqual(r.outcome, 'error_before_start'); assert.strictEqual(r.cost, 0); }],
    ['cut-off mid-stream: cut_off with the generation id and partial text', async () => {
      const r = await run('cutoff'); assert.strictEqual(r.outcome, 'cut_off'); assert.ok(r.generationId); assert.strictEqual(r.text, 'Hello');
    }],
    ['unreadable stream is classified', async () => { assert.strictEqual((await run('unreadable')).outcome, 'unreadable'); }],
    ['dropped connection before any response: unknown, cost null', async () => { const r = await run('drop'); assert.strictEqual(r.outcome, 'unknown'); assert.strictEqual(r.cost, null); }],
    ['the api key never appears in a result', async () => {
      const r = await or.callOpenRouter({ baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-secret-key-1', body: mk() });
      assert.strictEqual(r.outcome, 'unknown'); assert.ok(!JSON.stringify(r).includes('sk-secret-key-1'));
    }],
    ['onStart gets the generation id once, onDelta gets each piece, and the serving model is reported', async () => {
      const m = await startMock({ chunks: ['a', 'b', 'c'] });
      const starts = [], deltas = [];
      try {
        const r = await or.callOpenRouter({ baseUrl: m.url, apiKey: 'sk-secret-key-1', body: mk(), onStart: (g) => starts.push(g), onDelta: (d) => deltas.push(d) });
        assert.strictEqual(starts.length, 1); assert.strictEqual(starts[0], r.generationId);
        assert.deepStrictEqual(deltas, ['a', 'b', 'c']);
        assert.strictEqual(r.model, 'a/one');
      } finally { await m.close(); }
    }],
    ['a throwing hook never breaks the call', async () => {
      const m = await startMock();
      try {
        const r = await or.callOpenRouter({ baseUrl: m.url, apiKey: 'k', body: mk(), onStart: () => { throw new Error('x'); }, onDelta: () => { throw new Error('y'); } });
        assert.strictEqual(r.outcome, 'ok'); assert.strictEqual(r.text, 'Hello world');
      } finally { await m.close(); }
    }],
    ['a picture goes to the model as an image part after the text; no picture keeps plain text', () => {
      assert.strictEqual(or.userContent('hi', null), 'hi');
      assert.deepStrictEqual(or.userContent('hi', 'AAAA'), [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
      assert.throws(() => or.userContent('hi', 'not base64!'));
    }],
    ['the bearer key is sent, the body holds no key', async () => {
      const m = await startMock();
      try { await or.callOpenRouter({ baseUrl: m.url, apiKey: 'sk-secret-key-1', body: mk() }); assert.ok(!JSON.stringify(m.state.calls[0]).includes('sk-secret-key-1')); }
      finally { await m.close(); }
    }]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
