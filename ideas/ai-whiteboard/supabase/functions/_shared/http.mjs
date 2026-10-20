// THIS FILE IS FOR: the HTTP doors of every AI function: a standard Request in, a Response out. The same handlers serve on Supabase
// (Deno.serve) and on the local dev server (node). No money or model logic lives here: only parsing, CORS, size caps and the stream.
// /run answers with newline-delimited JSON: {"t":"delta","d":"..."} as text arrives, {"t":"tick"} every 15s so idle timeouts never
// cut a long answer, then one {"t":"done","status":...} line carrying the result. Everything else answers with plain JSON.
import { route } from './route.mjs';
import { run } from './run.mjs';
import { admin } from './admin.mjs';
import { cleanup } from './cleanup.mjs';
import { reconcile } from './reconcile.mjs';
import { authenticate, isAdmin } from './auth.mjs';
import { ticketIdOf } from './ticket.mjs';

export const MAX_BODY = 2000000;           // ask + board + board picture, with room for JSON
export const TICK_MS = 15000;
const OUTCOMES = new Set(['redo', 'undo', 'edit', 'delete', 'nextmove_tap']);

// THIS SECTION IS FOR: CORS. Only the board's own origins may call; DEFAULT is the live site (AI_ALLOWED_ORIGINS adds local dev).
export function corsHeaders(req, env) {
  const allowed = String(env.AI_ALLOWED_ORIGINS || 'https://lilly-builds.github.io').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin') || '';
  const h = { 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
    'access-control-max-age': '600', vary: 'origin' };
  if (allowed.includes(origin)) h['access-control-allow-origin'] = origin;
  return h;
}
const json = (status, body, cors) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' } });

// THIS SECTION IS FOR: reading a body without ever holding more than MAX_BODY bytes.
async function readJson(req) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_BODY) throw Object.assign(new Error('too big'), { status: 413 });
  if (!req.body) return {};
  const reader = req.body.getReader(), parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) { try { await reader.cancel(); } catch (e) { /* already closed */ } throw Object.assign(new Error('too big'), { status: 413 }); }
    parts.push(value);
  }
  const buf = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { buf.set(p, at); at += p.length; }
  try { const o = JSON.parse(new TextDecoder().decode(buf) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; }
  catch (e) { throw Object.assign(new Error('bad json'), { status: 400 }); }
}

// THIS SECTION IS FOR: the log. Only where it failed and a scrubbed message: never a body, a pass, a key or prompt text (I6).
export function logError(where, e) {
  const msg = String((e && e.message) || e).replace(/(sk-|tp_)[A-Za-z0-9_-]{4,}/g, '[redacted]').slice(0, 200);
  console.error('[ai-toolbox] ' + where + ': ' + msg);
}
// THIS SECTION IS FOR: the caller's address, for the per-address rate limit. Only a header the platform sets counts. A caller can put
// anything in X-Forwarded-For, so that header is never read. DEFAULT cf-connecting-ip (set by the CDN in front of Supabase, UNVERIFIED
// until the first deploy); AI_IP_HEADER names another. No trusted header means no address: the per-person limit still applies.
export function clientIp(req, env) {
  const name = String((env && env.AI_IP_HEADER) || 'cf-connecting-ip').toLowerCase();
  if (name === 'x-forwarded-for') return null;
  const v = String(req.headers.get(name) || '').trim();
  return /^[0-9a-fA-F:.]{2,45}$/.test(v) ? v : null;
}

// One wrapper for the plain JSON doors: OPTIONS, POST only, body cap, and a 500 that says nothing.
function door(name, deps, handle) {
  return async (req) => {
    const cors = corsHeaders(req, deps.env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return json(405, { ok: false, reason: 'method' }, cors);
    let b;
    try { b = await readJson(req); } catch (e) { return json(e.status || 400, { ok: false, reason: e.status === 413 ? 'too_big' : 'bad_json' }, cors); }
    try { const r = await handle(req, b, cors); return r instanceof Response ? r : json(r.status, r.body, cors); }
    catch (e) { logError(name, e); return json(500, { ok: false, reason: 'server' }, cors); }
  };
}

// THIS SECTION IS FOR: /route. The request id is made here, never taken from the browser.
export const routeHandler = (deps) => door('route', deps, (req, b) => route(deps, {
  headers: req.headers, ip: clientIp(req, deps.env), ask: b.ask, summary: b.summary, job: b.job,
  second: b.second === true, hasImage: b.hasImage === true, requestId: crypto.randomUUID()
}));

// THIS SECTION IS FOR: /run, streamed. A browser that goes away aborts the model call (req.signal); the hold still settles or is kept.
export const runHandler = (deps) => door('run', deps, (req, b, cors) => {
  const enc = new TextEncoder();
  let ctrl, open = true;
  const stream = new ReadableStream({ start(c) { ctrl = c; }, cancel() { open = false; } });
  const send = (o) => { if (!open) return; try { ctrl.enqueue(enc.encode(JSON.stringify(o) + '\n')); } catch (e) { open = false; } };
  const tick = setInterval(() => send({ t: 'tick' }), TICK_MS);
  (async () => {
    try {
      const r = await run(deps, { headers: req.headers, ticket: b.ticket, ask: b.ask, board: b.board == null ? '' : b.board, image: b.image || null,
        advanceEm: b.advanceEm, signal: req.signal, onDelta: (d) => send({ t: 'delta', d }) });
      send({ t: 'done', status: r.status, ...r.body });
    } catch (e) { logError('run', e); send({ t: 'done', status: 500, ok: false, reason: 'server' }); }
    finally { clearInterval(tick); if (open) { open = false; try { ctrl.close(); } catch (e) { /* closed by the browser */ } } }
  })();
  return new Response(stream, { status: 200, headers: { ...cors, 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
});

// THIS SECTION IS FOR: /outcome (build plan 1.20). What the person did with an answer: a code and a ticket id, never text.
export const outcomeHandler = (deps) => door('outcome', deps, async (req, b) => {
  const who = await authenticate(req.headers, deps.findByHash);
  if (!who.ok) return { status: 401, body: { ok: false, reason: who.reason } };
  if (!OUTCOMES.has(b.code)) return { status: 400, body: { ok: false, reason: 'bad_code' } };
  const id = ticketIdOf({ secret: deps.ticketSecret, token: b.ticket, person: who.person });
  if (!id) return { status: 403, body: { ok: false, reason: 'ticket' } };
  await deps.recordOutcome(who.person, id, b.code);
  return { status: 200, body: { ok: true } };
});

// THIS SECTION IS FOR: Lilly's admin door and the scheduled jobs. Each checks its own server secret in constant time.
export const adminHandler = (deps) => door('admin', deps, (req, b) => {
  if (!isAdmin(req.headers, deps.env.AI_ADMIN_SECRET)) return { status: 401, body: { ok: false, reason: 'admin' } };
  return admin(deps.admin, b);
});
const cronDoor = (name, job) => (deps) => door(name, deps, async (req) => {
  if (!isAdmin(req.headers, deps.env.AI_CRON_SECRET)) return { status: 401, body: { ok: false, reason: 'cron' } };
  return { status: 200, body: { ok: true, report: await job(deps.jobs) } };
});
export const cleanupHandler = cronDoor('cleanup', cleanup);
export const reconcileHandler = cronDoor('reconcile', reconcile);
