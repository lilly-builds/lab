/* node ideas/ai-whiteboard/ai-mock-openrouter.test.js
   The test double itself: streams, reports cost, failure modes, key limits. */
const assert = require('assert');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

(async () => {
  const { startMock } = await import('./supabase/functions/_shared/testing/mock-openrouter.mjs');
  const post = (m, path, body, key) => fetch(m.url + path, { method: 'POST', headers: { authorization: 'Bearer ' + (key || 'x'), 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const tests = [
    ['non-streaming returns text and cost', async () => {
      const m = await startMock({ cost: 0.05 });
      try { const j = await (await post(m, '/chat/completions', { stream: false })).json(); assert.strictEqual(j.usage.cost, 0.05); assert.strictEqual(j.choices[0].message.content, 'Hello world'); }
      finally { await m.close(); }
    }],
    ['streaming ends with usage and [DONE]', async () => {
      const m = await startMock();
      try { const txt = await (await post(m, '/chat/completions', { stream: true })).text(); assert.ok(txt.includes('"cost":0.0123')); assert.ok(txt.trim().endsWith('[DONE]')); }
      finally { await m.close(); }
    }],
    ['error5xx answers 503 before any chunk', async () => {
      const m = await startMock({ mode: 'error5xx' });
      try { assert.strictEqual((await post(m, '/chat/completions', { stream: true })).status, 503); } finally { await m.close(); }
    }],
    ['request bodies are recorded', async () => {
      const m = await startMock();
      try { await post(m, '/chat/completions', { stream: false, marker: 7 }); assert.strictEqual(m.state.calls[0].marker, 7); } finally { await m.close(); }
    }],
    ['key create, limit enforced, update raises it, disable blocks', async () => {
      const m = await startMock({ cost: 0.6 });
      try {
        const k = await (await post(m, '/keys', { limit: 1 })).json();
        const use = async () => (await post(m, '/chat/completions', { stream: false }, k.key)).status;
        assert.strictEqual(await use(), 200); assert.strictEqual(await use(), 200); // usage 1.2 now passes the limit
        assert.strictEqual(await use(), 402);
        await fetch(m.url + '/keys/' + k.data.hash, { method: 'PATCH', body: JSON.stringify({ limit: 5 }) });
        assert.strictEqual(await use(), 200);
        await fetch(m.url + '/keys/' + k.data.hash, { method: 'PATCH', body: JSON.stringify({ disabled: true }) });
        assert.strictEqual(await use(), 402);
      } finally { await m.close(); }
    }],
    ['generation lookup returns the charged cost', async () => {
      const m = await startMock({ cost: 0.02 });
      try {
        const j = await (await post(m, '/chat/completions', { stream: false })).json();
        const g = await (await fetch(m.url + '/generation?id=' + j.id)).json();
        assert.strictEqual(g.data.total_cost, 0.02);
        assert.strictEqual((await fetch(m.url + '/generation?id=nope')).status, 404);
      } finally { await m.close(); }
    }]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
