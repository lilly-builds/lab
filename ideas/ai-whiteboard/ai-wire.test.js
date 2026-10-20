/* node ideas/ai-whiteboard/ai-wire.test.js
   wire.mjs, the one place that binds database functions and secrets: each model call uses the person's own key, read fresh every time,
   so a key disabled between two calls is never used for the second. Stand-in database, OpenRouter mock; no real accounts. */
const assert = require('assert');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

(async () => {
  const S = './supabase/functions/_shared/';
  const { makeDeps } = await import(S + 'wire.mjs');
  const { encryptKey } = await import(S + 'keys.mjs');
  const { pick } = await import(S + 'rulebook.mjs');
  const { startMock } = await import(S + 'testing/mock-openrouter.mjs');

  const tests = [
    ['every call reads the person\'s key again; a key disabled between calls is not used, and nothing reaches the model', async () => {
      const mock = await startMock();
      try {
        const env = { AI_KEY_ENC_SECRET: 'enc', AI_OPENROUTER_URL: mock.url, AI_ALLOW_PLACEHOLDERS: '1' };
        let disabled = false, reads = 0;
        const rpc = async (name) => {
          if (name !== 'ai_key_of') return { error: { message: 'unexpected ' + name } };
          reads++;
          return { data: [{ key_hash: 'h', key_enc: encryptKey('sk-mock-h', 'enc'), disabled }], error: null };
        };
        const deps = makeDeps({ rpc, env });
        const p = pick('draw', {}, {}, 'u1', env);
        const msgs = [{ role: 'user', content: 'hi' }];
        const first = await deps.call(p, msgs, 'u1');
        assert.strictEqual(first.outcome, 'ok');
        disabled = true;
        const second = await deps.call(p, msgs, 'u1');
        assert.deepStrictEqual([second.outcome, second.cost], ['error_before_start', 0]);
        assert.strictEqual(reads, 2, 'the key row was read for each call');
        assert.strictEqual(mock.state.calls.length, 1, 'the second call never reached the model');
      } finally { await mock.close(); }
    }],
    ['a database error names the function, never the database\'s own text', async () => {
      const deps = makeDeps({ rpc: async () => ({ error: { message: 'relation tester_passes secret detail' } }), env: {} });
      await assert.rejects(deps.findByHash('x'), (e) => e.message === 'ai_find_pass failed');
    }]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
