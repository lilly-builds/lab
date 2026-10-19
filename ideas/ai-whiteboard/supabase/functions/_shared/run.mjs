// THIS FILE IS FOR: /run (build plan 1.11). Takes a ticket, gates the whole payload, holds money, calls the stored pick, settles to real cost.
// Everything outside is injected (deps), as in route.mjs. Answer text streams out through onDelta; the result carries the whole reply.
import { authenticate } from './auth.mjs';
import { LedgerError, takeAttempt, takeChild, giveBackAttempt } from './ledger.mjs';
import { worstCaseCost } from './rulebook.mjs';
import { systemFor, userText, IMAGE_JOBS } from './prompts.mjs';
import { runGate, gateMessages, noteBlock } from './gate.mjs';
import { userContent } from './openrouter.mjs';
import { verifyTicket, issueTicket, hashAsk, MAX_ATTEMPTS } from './ticket.mjs';
import { withHold, tally, messageTokens } from './billing.mjs';
import { LIMITS, recordedCall } from './route.mjs';

// THIS SECTION IS FOR: which models an attempt may use. Attempt 2 moves on to the next model; it never retries the one that just failed.
export function modelsForAttempt(models, attempt) {
  const rest = models.slice(attempt - 1);
  return rest.length ? rest : models.slice(-1);
}

const refuse = (status, reason) => ({ status, body: { ok: false, reason } });

// input: { headers, ticket, ask, board, image (base64 PNG), advanceEm, signal, onDelta(text) }
// deps: route.mjs deps plus { getTicket(id) -> { id, person, job, pick, askHash, parent } | null, storeTicket, gatePick(hasImage) }
export async function run(deps, input) {
  const { headers, ticket, ask = '', board = '', image = null, advanceEm, signal, onDelta } = input;
  if (typeof ask !== 'string' || String(ask).length > LIMITS.askChars || String(board).length > LIMITS.boardChars ||
      (image && String(image).length > LIMITS.imageChars)) return refuse(413, 'too_big');

  const who = await authenticate(headers, deps.findByHash);
  if (!who.ok) return refuse(who.reason === 'paused' ? 403 : 401, who.reason);
  const person = who.person;

  const v = verifyTicket({ secret: deps.ticketSecret, token: ticket, person, askHash: hashAsk(ask), now: deps.now() });
  if (!v.ok) return refuse(403, 'ticket_' + v.reason);
  const stored = await deps.getTicket(v.payload.id);
  if (!stored || stored.person !== person) return refuse(403, 'ticket_unknown');
  const job = stored.job;
  const system = systemFor(job, advanceEm, { nextMoves: deps.env && deps.env.AI_NEXT_MOVES === 'off' ? false : true });
  if (!system) return refuse(400, 'unknown_job');

  // The attempt is taken atomically by the database before anything is held or sent (I5).
  let attempt;
  try { attempt = await takeAttempt(deps.rpc, stored.id, person); } catch (e) { return refuse(503, 'server'); }
  if (!attempt) return refuse(403, 'no_attempts_left');

  const picture = IMAGE_JOBS.has(job) && image ? image : null;
  const text = userText(job, { ask, board });
  const p = { ...stored.pick, models: modelsForAttempt(stored.pick.models, attempt) };
  const gatePick = deps.gatePick(!!picture);
  // The gate reads exactly the text the job model reads. More than it can read is refused here, before any hold.
  let gateMsgs;
  try { gateMsgs = gateMessages(text, deps.imageMode === 'native' ? picture : null); } catch (e) { return refuse(413, 'too_big'); }
  const messages = [{ role: 'system', content: system }, { role: 'user', content: userContent(text, picture) }];
  const amount = worstCaseCost(p, messageTokens(messages)) + worstCaseCost(gatePick, messageTokens(gateMsgs));
  const holdId = 'run:' + stored.id + ':' + attempt;

  let out;
  try {
    out = await withHold({ rpc: deps.rpc, person, requestId: holdId, amount }, async (bill) => {
      const g = await runGate(async (m) => tally(bill, await recordedCall(deps, { p: gatePick, job: 'gate', messages: m, person, holdId, n: 0, attempt })),
        { text, hasImage: !!picture, image: picture, imageMode: deps.imageMode || 'none', describe: deps.describe });
      if (!g.pass) return { gate: g };
      const r = tally(bill, await recordedCall(deps, { p, job, messages, person, holdId, n: 1, attempt, signal, onDelta }));
      return { gate: g, r };
    });
  } catch (e) {
    if (!(e instanceof LedgerError)) return refuse(503, 'server');
    // Out of credit or paused can only come from placing the hold, so no call was made: the attempt goes back, and the retry is
    // still there once the money is (a cut-off attempt 1 keeps its hold until cleanup prices it). If the give-back itself fails,
    // the refusal stands and the person can send the ask again for a fresh ticket.
    if (e.code === 'insufficient' || e.code === 'paused') {
      try { await giveBackAttempt(deps.rpc, stored.id, person, attempt); } catch (ge) { /* the refusal below is the answer either way */ }
    }
    return refuse(e.code === 'insufficient' ? 402 : e.code === 'paused' ? 403 : 503, e.code);
  }

  if (!out.gate.pass) {
    if (out.gate.kind === 'server') return refuse(503, 'server'); // the gate failed; not an accusation
    await noteBlock(deps, person, deps.now());
    return refuse(422, 'blocked');
  }
  const ok = out.r.outcome === 'ok';
  const body = { ok, job, text: ok ? out.r.text : '', attempt, canRetry: !ok && attempt < MAX_ATTEMPTS, reason: ok ? null : out.r.outcome };

  // Next moves for a finished build (build plan 1.19): one child ticket, usable once, billed like any call. A failure here never
  // touches the build's result.
  if (ok && job === 'build' && !(deps.env && deps.env.AI_NEXT_MOVES === 'off')) {
    try { body.next = await childTicket(deps, stored, person, ask); } catch (e) { body.next = null; }
  }
  return { status: ok ? 200 : 502, body };
}

// THIS SECTION IS FOR: the one nextmoves follow-up a build may issue. Same ask hash, so /run checks it against the same idea.
async function childTicket(deps, stored, person, ask) {
  if (!(await takeChild(deps.rpc, stored.id, person))) return null;
  const p = deps.nextMovesPick();
  const t = issueTicket({ secret: deps.ticketSecret, person, askHash: hashAsk(ask), now: deps.now(), parent: stored.id });
  await deps.storeTicket({ id: t.payload.id, person, askHash: t.payload.h, job: 'nextmoves', pick: p, exp: t.payload.exp, parent: stored.id });
  return t.token;
}
