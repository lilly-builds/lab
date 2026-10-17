// THIS FILE IS FOR: /run (build plan 1.11). Takes a ticket, gates the payload, holds money, calls the stored pick, settles to real cost.
// Everything outside is injected (deps), as in route.mjs. Streaming to the browser is the function wrapper's job; this returns the whole reply.
import { authenticate } from './auth.mjs';
import { LedgerError, takeAttempt } from './ledger.mjs';
import { worstCaseCost } from './rulebook.mjs';
import { SYSTEM_EDIT, SYSTEM_APP, buildDrawSystem } from './prompts.mjs';
import { runGate } from './gate.mjs';
import { verifyTicket, hashAsk, MAX_ATTEMPTS } from './ticket.mjs';
import { withHold, tally, estTokens } from './billing.mjs';
import { LIMITS } from './route.mjs';

const GATE_TOKENS = 700;

// THIS SECTION IS FOR: the system prompt per job. Jobs whose prompts are not moved to the server yet are refused plainly.
function systemFor(job, advanceEm) {
  if (job === 'edit') return SYSTEM_EDIT;
  if (job === 'build') return SYSTEM_APP;
  if (job === 'draw') return buildDrawSystem(advanceEm);
  return null;
}

// THIS SECTION IS FOR: which models an attempt may use. Attempt 2 moves on to the next model; it never retries the one that just failed.
export function modelsForAttempt(models, attempt) {
  const rest = models.slice(attempt - 1);
  return rest.length ? rest : models.slice(-1);
}

const refuse = (status, reason) => ({ status, body: { ok: false, reason } });

// input: { headers, ticket, ask, board, memory, image, advanceEm, signal }
// deps: { rpc, findByHash, getTicket(id) -> { id, person, job, pick } | null, gateCall(pick, messages, person), call(pick, messages, person, signal),
//         gatePick, ticketSecret, now(), imageMode, describe }
export async function run(deps, input) {
  const { headers, ticket, ask = '', board = '', memory = '', image = null, advanceEm, signal } = input;
  if (String(ask).length > LIMITS.askChars || String(board).length > LIMITS.boardChars || String(memory).length > LIMITS.memoryChars) return refuse(413, 'too_big');

  const who = await authenticate(headers, deps.findByHash);
  if (!who.ok) return refuse(who.reason === 'paused' ? 403 : 401, who.reason);
  const person = who.person;

  const v = verifyTicket({ secret: deps.ticketSecret, token: ticket, person, askHash: hashAsk(ask), now: deps.now() });
  if (!v.ok) return refuse(403, 'ticket_' + v.reason);
  const stored = await deps.getTicket(v.payload.id);
  if (!stored || stored.person !== person) return refuse(403, 'ticket_unknown');
  const system = systemFor(stored.job, advanceEm);
  if (!system) return refuse(501, 'job_not_ready');

  // The attempt is taken atomically by the database before anything is held or sent (I5).
  let attempt;
  try { attempt = await takeAttempt(deps.rpc, stored.id, person); } catch (e) { return refuse(503, 'server'); }
  if (!attempt) return refuse(403, 'no_attempts_left');

  const p = { ...stored.pick, models: modelsForAttempt(stored.pick.models, attempt) };
  const user = String(ask) + (board ? '\n\nBoard:\n' + board : '') + (memory ? '\n\nMemory:\n' + memory : '');
  const inTok = estTokens(system.length + user.length) + GATE_TOKENS;
  const amount = worstCaseCost(p, inTok) + worstCaseCost(deps.gatePick, estTokens(user.length) + GATE_TOKENS);

  let out;
  try {
    out = await withHold({ rpc: deps.rpc, person, requestId: 'run:' + stored.id + ':' + attempt, amount }, async (bill) => {
      const g = await runGate(async (m) => tally(bill, await deps.gateCall(deps.gatePick, m, person)),
        { text: user, hasImage: !!image, imageMode: deps.imageMode || 'none', describe: deps.describe });
      if (!g.pass) return { gate: g };
      const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
      const r = tally(bill, await deps.call(p, messages, person, signal));
      return { gate: g, r };
    });
  } catch (e) {
    if (e instanceof LedgerError) return refuse(e.code === 'insufficient' ? 402 : e.code === 'paused' ? 403 : 503, e.code);
    return refuse(503, 'server');
  }

  if (!out.gate.pass) return refuse(out.gate.kind === 'server' ? 503 : 422, out.gate.kind === 'server' ? 'server' : 'blocked');
  const ok = out.r.outcome === 'ok';
  return { status: ok ? 200 : 502, body: { ok, text: ok ? out.r.text : '', attempt, canRetry: !ok && attempt < MAX_ATTEMPTS } };
}
