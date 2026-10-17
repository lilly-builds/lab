// THIS FILE IS FOR: running the whole AI toolbox on this computer with no real accounts: the board's static files, the real function
// handlers at /functions/v1/<name>, a scratch Postgres for the database, and the fake model in dev-responder.mjs instead of OpenRouter.
// Usage: AI_TEST_DATABASE_URL=postgresql://localhost:5432/ai_toolbox_scratch node ideas/ai-whiteboard/tools/dev-server.mjs [--port 8787] [--pass 5]
//   (prepare the database first: bash ideas/ai-whiteboard/supabase/tests/scratch.sh)
//   --pass N creates a tester pass with an $N grant and prints it once. Open http://localhost:8787/?toolbox=local and paste it.
// Only for local testing: secrets here are random per run and the database must be a scratch one.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { psqlRpc } from '../supabase/functions/_shared/testing/psql-rpc.mjs';
import { startMock } from '../supabase/functions/_shared/testing/mock-openrouter.mjs';
import { makeDeps } from '../supabase/functions/_shared/wire.mjs';
import * as H from '../supabase/functions/_shared/http.mjs';
import { admin } from '../supabase/functions/_shared/admin.mjs';
import { respond, realisticCost } from './dev-responder.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

// THIS SECTION IS FOR: starting everything. Returns { url, deps, mock, close } so tests can drive the same server.
export async function startDevServer({ port = 0, dbUrl, mockOpts = {}, envOver = {} } = {}) {
  const mock = await startMock({ responder: respond, costFor: realisticCost, ...mockOpts });
  let origin = 'http://localhost:' + port;
  // Random secrets per run, or fixed ones derived from AI_DEV_SECRET so a local tester pass keeps working across restarts.
  const seed = process.env.AI_DEV_SECRET;
  const secret = (name) => (seed ? createHash('sha256').update(seed + ':' + name).digest('hex') : randomBytes(24).toString('hex'));
  const env = {
    AI_ALLOW_PLACEHOLDERS: '1', AI_OPENROUTER_URL: mock.url, AI_OPENROUTER_MASTER_KEY: 'sk-dev-master',
    AI_TICKET_SECRET: secret('ticket'), AI_KEY_ENC_SECRET: secret('enc'),
    AI_ADMIN_SECRET: secret('admin'), AI_CRON_SECRET: secret('cron'), AI_ALLOWED_ORIGINS: origin,
    ...envOver
  };
  const deps = makeDeps({ rpc: psqlRpc(dbUrl), env });
  const doors = { route: H.routeHandler(deps), run: H.runHandler(deps), outcome: H.outcomeHandler(deps), admin: H.adminHandler(deps),
    cleanup: H.cleanupHandler(deps), reconcile: H.reconcileHandler(deps) };

  const rpc = psqlRpc(dbUrl);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // the browser's one database door, as Supabase's REST API serves it: POST /rest/v1/rpc/my_balance { p_pass }
    if (req.method === 'POST' && url.pathname === '/rest/v1/rpc/my_balance') {
      let raw = '';
      for await (const c of req) { raw += c; if (raw.length > 10000) break; }
      let pass = '';
      try { pass = String(JSON.parse(raw).p_pass || ''); } catch (e) { /* empty pass: null balance */ }
      const r = await rpc('my_balance', { p_pass: pass });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(r.error ? null : r.data));
    }
    // dev only: steer the fake model to try failure paths by hand. POST /dev/mock { mode: ok|cutoff|error5xx|unreadable|slow|drop, jobOnly }
    if (req.method === 'POST' && url.pathname === '/dev/mock') {
      let raw = '';
      for await (const c of req) raw += c;
      const o = JSON.parse(raw || '{}');
      mock.state.mode = o.mode || 'ok';
      mock.state.modeFilter = o.jobOnly ? (b) => !/safety check|route requests/.test(b.messages[0].content) : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, mode: mock.state.mode }));
    }
    const m = url.pathname.match(/^\/functions\/v1\/([a-z]+)$/);
    if (m && doors[m[1]]) {
      // node request -> Fetch Request (the same object Deno.serve hands the hosted functions); a closed socket aborts it.
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); });
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
      const request = new Request(origin + req.url, { method: req.method, headers: req.headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half', signal: ac.signal });
      const response = await doors[m[1]](request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) return res.end();
      for await (const chunk of response.body) { if (!res.write(chunk)) await new Promise((r) => res.once('drain', r)); }
      return res.end();
    }
    // static board files, never outside ROOT
    const file = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  const actual = server.address().port;
  origin = 'http://localhost:' + actual;
  if (!envOver.AI_ALLOWED_ORIGINS) env.AI_ALLOWED_ORIGINS = origin + ',http://127.0.0.1:' + actual;
  return {
    url: origin, deps, mock, env,
    newPass: async (grant, label = 'dev') => (await admin(deps.admin, { action: 'create', label, grant })).body,
    close: async () => { server.closeAllConnections?.(); await new Promise((ok) => server.close(ok)); await mock.close(); }
  };
}

// THIS SECTION IS FOR: running it by hand.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const dbUrl = process.env.AI_TEST_DATABASE_URL;
  if (!dbUrl) { console.error('set AI_TEST_DATABASE_URL to a scratch database (bash ideas/ai-whiteboard/supabase/tests/scratch.sh makes one)'); process.exit(1); }
  const envOver = process.env.AI_ORPHAN_WAIT_SECS ? { AI_ORPHAN_WAIT_SECS: process.env.AI_ORPHAN_WAIT_SECS } : {};
  const s = await startDevServer({ port: Number(arg('--port', 8787)), dbUrl, envOver });
  console.log('board: ' + s.url + '/?toolbox=local');
  if (process.argv.includes('--pass')) {
    const p = await s.newPass(Number(arg('--pass', 5)));
    console.log(p.ok ? 'tester pass (shown once): ' + p.pass : 'could not create a pass: ' + p.reason);
  }
}
