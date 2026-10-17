// THIS FILE IS FOR: a tiny local stand-in for OpenRouter (build plan step 0.2). Test use only; never imported by product code.
// It speaks the subset the plug uses: POST /chat/completions (stream or not), POST /keys, PATCH /keys/:hash, GET /generation.
// Failure modes are set per server: ok | error5xx | cutoff | unreadable | slow | drop. It cannot prove OpenRouter's real field names (step 0.7).
import http from 'node:http';

const chunkText = (s) => (s.match(/[\s\S]{1,40}/g) || ['']);

export async function startMock(opts = {}) {
  const state = {
    mode: opts.mode || 'ok',
    cost: opts.cost == null ? 0.0123 : opts.cost,
    chunks: opts.chunks || ['Hello', ' ', 'world'],
    calls: [],       // every chat request body, for assertions
    keys: new Map(), // hash -> { limit, usage, disabled }
    gens: new Map(), // generation id -> cost
    seq: 0
  };
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const read = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => ok(b)); });
  const sse = (res, o) => res.write('data: ' + JSON.stringify(o) + '\n\n');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const raw = await read(req);
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch (e) { return json(res, 400, { error: 'bad json' }); }
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');

    if (req.method === 'POST' && url.pathname === '/keys') {
      const hash = 'key' + (++state.seq);
      state.keys.set(hash, { limit: body.limit, usage: 0, disabled: false });
      return json(res, 200, { key: 'sk-mock-' + hash, data: { hash, limit: body.limit } });
    }
    const km = url.pathname.match(/^\/keys\/(.+)$/);
    if (req.method === 'GET' && km) {
      const k = state.keys.get(km[1]);
      return k ? json(res, 200, { data: { hash: km[1], limit: k.limit, usage: k.usage, disabled: k.disabled } }) : json(res, 404, { error: 'no key' });
    }
    if (req.method === 'PATCH' && km) {
      const k = state.keys.get(km[1]);
      if (!k) return json(res, 404, { error: 'no key' });
      if (body.limit !== undefined) k.limit = body.limit;
      if (body.disabled !== undefined) k.disabled = body.disabled;
      return json(res, 200, { data: { hash: km[1], limit: k.limit, disabled: k.disabled } });
    }
    if (req.method === 'GET' && url.pathname === '/generation') {
      const id = url.searchParams.get('id');
      return state.gens.has(id) ? json(res, 200, { data: { id, total_cost: state.gens.get(id) } }) : json(res, 404, { error: 'unknown generation' });
    }
    if (req.method === 'POST' && url.pathname === '/chat/completions') {
      state.calls.push(body);
      const key = state.keys.get(bearer.replace('sk-mock-', ''));
      if (key && (key.disabled || (key.limit != null && key.usage >= key.limit))) return json(res, 402, { error: 'key limit reached' });
      // state.modeFilter(body) -> boolean aims a failure mode at some calls only (for example the job call, not the gate).
      const mode = !state.modeFilter || state.modeFilter(body) ? state.mode : 'ok';
      if (mode === 'error5xx') return json(res, 503, { error: 'upstream down' });
      if (mode === 'drop') return req.socket.destroy();
      const id = 'gen-' + (++state.seq);
      const model = (body.models && body.models[0]) || body.model || 'mock/model'; // the first model serves, as OpenRouter reports it
      // opts.responder(body) -> string replaces the fixed chunks (the dev server answers each job with a fitting reply);
      // opts.costFor(body) -> dollars replaces the fixed cost (a test can charge the most a call could ever cost).
      const chunks = opts.responder ? chunkText(String(opts.responder(body))) : state.chunks;
      const cost = opts.costFor ? opts.costFor(body) : state.cost;
      const charge = () => { state.gens.set(id, cost); if (key) key.usage += cost; };
      if (!body.stream) {
        charge();
        return json(res, 200, { id, model, choices: [{ message: { content: chunks.join('') } }], usage: { cost } });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (mode === 'unreadable') { res.write('data: {not json\n\n'); return res.end(); }
      const parts = mode === 'cutoff' ? chunks.slice(0, 1) : chunks;
      for (const c of parts) { sse(res, { id, model, choices: [{ delta: { content: c } }] }); if (mode === 'slow') await new Promise((r) => setTimeout(r, 30)); }
      if (mode === 'cutoff') { charge(); await new Promise((r) => setTimeout(r, 40)); return res.socket.destroy(); } // cut-off answers are charged
      charge();
      sse(res, { id, model, choices: [{ delta: {} }], usage: { cost } });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    json(res, 404, { error: 'not found' });
  });

  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { state, url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }) };
}
