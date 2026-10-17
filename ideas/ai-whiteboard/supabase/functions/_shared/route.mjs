// THIS FILE IS FOR: /route (build plan 1.10). Decides which job an ask is, checks it is safe, and hands back a ticket. Never a model name.
// Everything outside is injected (deps) so the same code runs on the mock, on the local stack and live.
import { authenticate } from './auth.mjs';
import { LedgerError } from './ledger.mjs';
import { pick, worstCaseCost } from './rulebook.mjs';
import { buildRouteSystem } from './prompts.mjs';
import { runGate, shouldPause } from './gate.mjs';
import { issueTicket, hashAsk } from './ticket.mjs';
import { withHold, tally, estTokens } from './billing.mjs';

// THIS SECTION IS FOR: limits. All DEFAULTS Lilly can change (build plan 1.10).
export const LIMITS = { askChars: 2000, boardChars: 20000, memoryChars: 4000, imageChars: 1500000, perPersonHour: 30, perIpHour: 120 };
const PROMPT_TOKENS = 700; // the fixed system prompt on router and gate calls

// THIS SECTION IS FOR: the jobs the router may pick. Keys match rulebook rows.
export const ROUTES = {
  draw:  { label: 'draw', about: 'add notes, shapes, text or arrows to the board.' },
  edit:  { label: 'edit', about: 'change, move, restyle or delete what is already on the board.' },
  build: { label: 'build', about: 'make a small working app or page.' },
  plan:  { label: 'plan', about: 'turn a dream or goal into a plan.' },
  todo:  { label: 'todo', about: 'turn tasks into a have-to list.' }
};
const DIFFICULTY = ['easy', 'normal', 'hard'];

// THIS SECTION IS FOR: reading the router's reply. Junk falls back to draw, as the browser does today.
export function parseRoute(raw, routes = ROUTES) {
  const fallback = { job: 'draw', confidence: 0, ask: null, difficulty: 'normal', stage: null, tone: null };
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return fallback;
  let j;
  try { j = JSON.parse(m[0]); } catch (e) { return fallback; }
  if (!j || !Object.prototype.hasOwnProperty.call(routes, j.route)) return fallback;
  return {
    job: j.route,
    confidence: typeof j.confidence === 'number' ? j.confidence : 1,
    ask: typeof j.ask === 'string' ? j.ask.slice(0, 70) : null,
    difficulty: DIFFICULTY.includes(j.difficulty) ? j.difficulty : 'normal',
    stage: typeof j.stage === 'string' ? j.stage.slice(0, 40) : null,
    tone: typeof j.tone === 'string' ? j.tone.slice(0, 40) : null
  };
}

const refuse = (status, reason) => ({ status, body: { ok: false, reason } });

// THIS SECTION IS FOR: the flow. input: { headers, ip, ask, board, memory, image, job? (named job skips the router), requestId }.
// deps: { rpc, findByHash, call(pick, messages, person), hit(key) -> count, isFirstAsk(person), storeTicket(t), recordBlock(person, now) -> times[],
//         pause(person), ticketSecret, now(), env, imageMode, describe }
export async function route(deps, input) {
  const { headers, ip, ask = '', board = '', memory = '', image = null, requestId } = input;
  const now = deps.now();

  // Sizes first: nothing is held or sent for an oversized payload.
  if (!ask.trim()) return refuse(400, 'empty');
  if (ask.length > LIMITS.askChars || String(board).length > LIMITS.boardChars || String(memory).length > LIMITS.memoryChars ||
      (image && String(image).length > LIMITS.imageChars)) return refuse(413, 'too_big');

  const who = await authenticate(headers, deps.findByHash);
  if (!who.ok) return refuse(who.reason === 'paused' ? 403 : 401, who.reason);
  const person = who.person;

  if ((await deps.hit('p:' + person)) > LIMITS.perPersonHour || (await deps.hit('ip:' + ip)) > LIMITS.perIpHour) return refuse(429, 'rate');

  const named = input.job && Object.prototype.hasOwnProperty.call(ROUTES, input.job) ? input.job : null;
  const hasImage = !!image;
  let gatePick, routerPick;
  try { gatePick = pick('gate', {}, { hasImage: false }, person, deps.env); routerPick = pick('router', {}, { hasImage: false }, person, deps.env); }
  catch (e) { return refuse(503, 'server'); }
  const inTok = estTokens(ask.length + String(board).length + String(memory).length) + PROMPT_TOKENS;
  const amount = worstCaseCost(gatePick, inTok) + (named ? 0 : worstCaseCost(routerPick, inTok));

  let out;
  try {
    out = await withHold({ rpc: deps.rpc, person, requestId: 'route:' + requestId, amount }, async (bill) => {
      const askModel = (p) => async (messages) => tally(bill, await deps.call(p, messages, person));

      const g = await runGate(askModel(gatePick), { text: ask, hasImage, imageMode: deps.imageMode || 'none', describe: deps.describe });
      if (!g.pass) return { gate: g };

      let r = parseRoute('', ROUTES);
      if (named) r = { ...r, job: named, confidence: 1 };
      else {
        const rr = await askModel(routerPick)([{ role: 'system', content: buildRouteSystem(ROUTES) }, { role: 'user', content: ask }]);
        if (rr.outcome === 'ok') r = parseRoute(rr.text, ROUTES);
      }
      return { gate: g, r };
    });
  } catch (e) {
    if (e instanceof LedgerError) return refuse(e.code === 'insufficient' ? 402 : e.code === 'paused' ? 403 : 503, e.code);
    return refuse(503, 'server');
  }

  if (!out.gate.pass) {
    if (out.gate.kind === 'server') return refuse(503, 'server'); // the gate failed; not an accusation
    const times = await deps.recordBlock(person, now);
    if (shouldPause(times, now)) await deps.pause(person);
    return refuse(422, 'blocked');
  }
  if (out.r.confidence < 0.6 && out.r.ask) return { status: 200, body: { ok: true, clarify: out.r.ask } };

  let p;
  try { p = pick(out.r.job, { difficulty: out.r.difficulty }, { hasImage }, person, deps.env); } catch (e) { return refuse(503, 'server'); }
  const firstAsk = await deps.isFirstAsk(person);
  const t = issueTicket({ secret: deps.ticketSecret, person, askHash: hashAsk(ask), now });
  await deps.storeTicket({ id: t.payload.id, person, job: out.r.job, pick: p, exp: t.payload.exp });
  return { status: 200, body: { ok: true, ticket: t.token, job: out.r.job, stage: out.r.stage, tone: out.r.tone, firstAsk } };
}
