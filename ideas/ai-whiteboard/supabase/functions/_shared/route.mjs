// THIS FILE IS FOR: /route (build plan 1.10). Decides which job an ask is, checks it is safe, and hands back a ticket. Never a model name.
// Everything outside is injected (deps) so the same code runs on the mock, on the local stack and live.
import { authenticate } from './auth.mjs';
import { LedgerError } from './ledger.mjs';
import { pick, worstCaseCost } from './rulebook.mjs';
import { buildRouteSystem, ROUTER_ROUTES, ROUTER_CLUES, userText } from './prompts.mjs';
import { runGate, noteBlock, gateMessages } from './gate.mjs';
import { issueTicket, hashAsk } from './ticket.mjs';
import { withHold, tally, messageTokens } from './billing.mjs';

// THIS SECTION IS FOR: limits. All DEFAULTS Lilly can change (build plan 1.10). Sizes are checked before anything is held or sent.
// boardChars fits a few hundred notes (sceneForModel sends every element) and, with the ask, stays under the gate's GATE_MAX_CHARS,
// so the gate always reads the whole payload. imageChars fits the 1400px board picture as base64.
export const LIMITS = { askChars: 2000, boardChars: 100000, summaryChars: 4000, imageChars: 1500000, perPersonHour: 30, perIpHour: 120 };

// THIS SECTION IS FOR: the jobs. The router chooses among the ask box's three; the others are named by their button.
export const NAMED_JOBS = new Set(['draw', 'edit', 'build', 'plan', 'todo']);
const DIFFICULTY = ['easy', 'normal', 'hard'];
const MIN_CONFIDENCE = 0.6;
export const DEFAULT_ASK = 'Do you want me to change what is on the board, or make something new?';

// THIS SECTION IS FOR: reading the router's reply, the way the browser's parseRoute does (app-09-route.js), plus the difficulty clue.
// Returns null for junk; the caller falls back to draw.
function firstJsonObject(s) {
  for (let a = s.indexOf('{'); a >= 0; a = s.indexOf('{', a + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = a; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { const o = JSON.parse(s.slice(a, i + 1)); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch (e) { /* next brace */ }
        break;
      }
    }
  }
  return null;
}
export function parseRoute(raw, routes = ROUTER_ROUTES) {
  if (typeof raw !== 'string') return null;
  const o = firstJsonObject(raw);
  if (!o) return null;
  const has = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(routes, k);
  const steps = Array.isArray(o.steps) ? o.steps.filter(has).slice(0, 2) : [];
  const route = has(o.route) ? o.route : steps[0];
  if (!route) return null;
  const confidence = typeof o.confidence === 'number' && isFinite(o.confidence) ? Math.max(0, Math.min(1, o.confidence)) : 0.8;
  const ask = typeof o.ask === 'string' ? o.ask.replace(/\s+/g, ' ').trim().slice(0, 140) : '';
  return { route, confidence, ask: ask || null, steps: steps.length ? steps : [route], difficulty: DIFFICULTY.includes(o.difficulty) ? o.difficulty : 'normal' };
}

const refuse = (status, reason) => ({ status, body: { ok: false, reason } });

// THIS SECTION IS FOR: the flow.
// input: { headers, ip, ask, summary (the browser's boardSummary object), job? (a named job skips the router), second? (the person
//          already answered one clarifying question: never ask another), hasImage? (the run will send the board picture), requestId
//          (made by the server, never by the browser) }
// deps: { rpc, findByHash, call(pick, messages, person, signal, hooks), hit(key) -> count, isFirstAsk(person), storeTicket(t),
//         recordBlock(person) -> epoch ms[], pause(person), usage: { start, finish }, avoidModels() -> ids, ticketSecret, now(), env, imageMode }
export async function route(deps, input) {
  const { headers, ip, ask = '', summary = null, requestId } = input;
  const now = deps.now();
  const summaryText = summary == null ? '' : JSON.stringify(summary);

  if (typeof ask !== 'string' || !ask.trim()) return refuse(400, 'empty');
  if (ask.length > LIMITS.askChars || summaryText.length > LIMITS.summaryChars) return refuse(413, 'too_big');
  if (input.job != null && !NAMED_JOBS.has(input.job)) return refuse(400, 'unknown_job');
  if (!requestId) return refuse(500, 'server');

  const who = await authenticate(headers, deps.findByHash);
  if (!who.ok) return refuse(who.reason === 'paused' ? 403 : 401, who.reason);
  const person = who.person;

  // The per-address limit needs an address the platform vouches for (http.mjs clientIp); without one only the person is counted.
  if ((await deps.hit('p:' + person)) > LIMITS.perPersonHour || (ip && (await deps.hit('ip:' + ip)) > LIMITS.perIpHour)) return refuse(429, 'rate');

  // The first ask ever (DEFAULT, open question 1) from the ask box becomes an idea map; the router is then not needed.
  const named = input.job || null;
  // Two reads that hold no money and do not depend on each other.
  const [firstAsk, avoid] = await Promise.all([named ? false : deps.isFirstAsk(person), deps.avoidModels ? deps.avoidModels() : []]);
  const useRouter = !named && !firstAsk;
  let gatePick, routerPick;
  try {
    gatePick = pick('gate', {}, { hasImage: false }, person, deps.env, avoid);
    routerPick = pick('router', {}, { hasImage: false }, person, deps.env, avoid);
  } catch (e) { return refuse(503, 'server'); }

  // The gate reads everything a model will read here: the router's whole input (ask and board summary), or just the ask.
  const routerText = userText('router', { ask, summary });
  const gateText = useRouter ? routerText : ask;
  const gateMsgs = gateMessages(gateText);
  const routerMsgs = [{ role: 'system', content: buildRouteSystem(ROUTER_ROUTES) + ' ' + ROUTER_CLUES }, { role: 'user', content: routerText }];
  const amount = worstCaseCost(gatePick, messageTokens(gateMsgs)) + (useRouter ? worstCaseCost(routerPick, messageTokens(routerMsgs)) : 0);
  const holdId = 'route:' + requestId;

  let out;
  try {
    out = await withHold({ rpc: deps.rpc, person, requestId: holdId, amount }, async (bill) => {
      let n = 0;
      const askModel = (p, job) => async (messages) => tally(bill, await recordedCall(deps, { p, job, messages, person, holdId, n: n++, attempt: 1 }));
      const g = await runGate(askModel(gatePick, 'gate'), { text: gateText, hasImage: false });
      if (!g.pass) return { gate: g };
      let r = null;
      if (useRouter) {
        const rr = await askModel(routerPick, 'router')(routerMsgs);
        if (rr.outcome === 'ok') r = parseRoute(rr.text);
      }
      return { gate: g, r };
    });
  } catch (e) {
    if (e instanceof LedgerError) return refuse(e.code === 'insufficient' ? 402 : e.code === 'paused' ? 403 : 503, e.code);
    return refuse(503, 'server');
  }

  if (!out.gate.pass) {
    if (out.gate.kind === 'server') return refuse(503, 'server'); // the gate failed; not an accusation
    await noteBlock(deps, person, now);
    return refuse(422, 'blocked');
  }

  let steps, difficulty = 'normal';
  if (named) steps = [named];
  else if (firstAsk) steps = ['ideamap'];
  else {
    const r = out.r || { route: 'draw', confidence: 1, ask: null, steps: ['draw'], difficulty: 'normal' }; // junk falls back to draw
    const unsure = r.confidence < MIN_CONFIDENCE || !!r.ask;
    if (unsure && !input.second) return { status: 200, body: { ok: true, clarify: r.ask || DEFAULT_ASK } };
    steps = unsure ? ['draw'] : r.steps;
    difficulty = r.difficulty;
  }

  const job = steps[0];
  let p;
  try { p = pick(job, { difficulty }, { hasImage: !!input.hasImage && (job === 'draw' || job === 'ideamap') }, person, deps.env, avoid); }
  catch (e) { return refuse(503, 'server'); }
  const t = issueTicket({ secret: deps.ticketSecret, person, askHash: hashAsk(ask), now });
  await deps.storeTicket({ id: t.payload.id, person, askHash: t.payload.h, job, pick: p, exp: t.payload.exp });
  return { status: 200, body: { ok: true, ticket: t.token, job, steps, firstAsk } };
}

// THIS SECTION IS FOR: one model call with its usage row (I3, I6): started before the call so a crash leaves a trace, marked when the
// first chunk names the generation, finished with the real cost. Shared with run.mjs. Never records any text.
export async function recordedCall(deps, { p, job, messages, person, holdId, n, attempt, signal, onDelta }) {
  const id = holdId + ':' + n;
  const t0 = deps.now();
  if (deps.usage) await deps.usage.start({ id, holdId, person, job, attempt });
  const r = await deps.call(p, messages, person, signal, {
    // best effort: the finish below writes the generation id too; this early write only helps if the function dies mid-answer
    onStart: (g) => { if (deps.usage) Promise.resolve().then(() => deps.usage.seen({ id, generationId: g })).catch(() => {}); },
    onDelta
  });
  if (deps.usage) await deps.usage.finish({ id, generationId: r.generationId || null, model: r.model || null, latencyMs: deps.now() - t0, cost: typeof r.cost === 'number' ? r.cost : null, outcome: r.outcome });
  return r;
}
