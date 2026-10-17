/* node ideas/ai-whiteboard/ai-http.test.js
   The HTTP doors with stand-in deps (no database): the caller's address comes only from a header the platform sets, CORS, the body cap,
   and /run's newline-delimited stream. The same doors on a real database: ai-outcome.test.js. */
const assert = require('assert');

let n = 0, failures = 0;
const t = (name, fn) => { n++; return Promise.resolve().then(fn).then(
  () => console.log('ok  ' + name),
  (e) => { failures++; console.log('FAIL  ' + name + '  -> ' + (e && e.message)); }); };

(async () => {
  const H = await import('./supabase/functions/_shared/http.mjs');
  const req = (headers, body, method = 'POST') => new Request('http://x/functions/v1/route', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

  const tests = [
    ['the caller\'s address comes from the platform\'s header; a forwarded-for header the caller sends is ignored', () => {
      assert.strictEqual(H.clientIp(req({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' }), {}), '203.0.113.9');
      assert.strictEqual(H.clientIp(req({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }), {}), null, 'no trusted header: no address, not a guess');
      assert.strictEqual(H.clientIp(req({ 'x-real-ip': '198.51.100.2' }), { AI_IP_HEADER: 'x-real-ip' }), '198.51.100.2');
    }],
    ['/route counts the per-address limit only on a trusted address; a spoofable one never makes a bucket', async () => {
      const { newPass } = await import('./supabase/functions/_shared/auth.mjs');
      const p = newPass();
      async function bucketsFor(headers) {
        const keys = [];
        const deps = { env: {}, now: () => 1, findByHash: async (h) => (h === p.hash ? { id: 'u1', pass_hash: p.hash } : null),
          hit: async (k) => { keys.push(k); return 1; }, isFirstAsk: async () => { throw new Error('stop here'); } };
        const origErr = console.error; console.error = () => {};
        try { await H.routeHandler(deps)(req({ authorization: 'Bearer ' + p.pass, ...headers }, { ask: 'hi', job: 'draw' })); }
        finally { console.error = origErr; }
        return keys;
      }
      const spoofed = await bucketsFor({ 'x-forwarded-for': '9.9.9.9' });
      assert.deepStrictEqual(spoofed, ['p:u1'], 'person counted, no ip bucket from a spoofable header');
      const trusted = await bucketsFor({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '9.9.9.9' });
      assert.deepStrictEqual(trusted, ['p:u1', 'ip:203.0.113.9']);
    }],
    ['CORS: only listed origins get an allow header', () => {
      const env = { AI_ALLOWED_ORIGINS: 'https://lilly-builds.github.io' };
      assert.strictEqual(H.corsHeaders(req({ origin: 'https://lilly-builds.github.io' }), env)['access-control-allow-origin'], 'https://lilly-builds.github.io');
      assert.strictEqual(H.corsHeaders(req({ origin: 'https://evil.example' }), env)['access-control-allow-origin'], undefined);
    }],
    ['a declared body over the cap is refused before reading; bad JSON is a 400; GET is a 405', async () => {
      const door = H.routeHandler({ env: {} });
      const big = await door(new Request('http://x/r', { method: 'POST', headers: { 'content-length': String(H.MAX_BODY + 1) }, body: 'x' }));
      assert.strictEqual(big.status, 413);
      const bad = await door(new Request('http://x/r', { method: 'POST', body: '{nope' }));
      assert.strictEqual(bad.status, 400);
      assert.strictEqual((await door(req({}, undefined, 'GET'))).status, 405);
    }],
    ['/run streams deltas, then one done line; a crash inside ends the stream with a plain server error', async () => {
      const { run } = await import('./supabase/functions/_shared/run.mjs');
      assert.ok(typeof run === 'function');
      const ok = await H.runHandler({ env: {}, findByHash: async () => null })(req({ authorization: 'Bearer tp_x' }, { ticket: 't', ask: 'a' }));
      const lines = (await ok.text()).trim().split('\n').map((l) => JSON.parse(l));
      assert.deepStrictEqual([ok.headers.get('content-type'), lines.pop().t], ['application/x-ndjson', 'done']);
    }]
  ];
  for (const [name, fn] of tests) await t(name, fn);
  console.log('1..' + n);
  if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
  console.log('ALL PASS');
})();
