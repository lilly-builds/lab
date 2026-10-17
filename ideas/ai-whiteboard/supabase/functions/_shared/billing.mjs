// THIS FILE IS FOR: holding money around a group of AI calls and settling to the real cost (invariants I1, I2).
// Shared by route.mjs and run.mjs so both settle the same way.
import { placeHold, settle, release } from './ledger.mjs';

// THIS SECTION IS FOR: token guesses for the hold's input side. The hold only needs to be an upper bound, never a close guess.
// Models tokenize at the byte level (a token covers at least one byte), so UTF-8 bytes bound the tokens in any language;
// 16 more per text covers message framing. A picture is a flat cap: PLACEHOLDER until phase 0 step 0.5 measures real image costs.
export const IMAGE_TOKENS = 5000;
const utf8 = new TextEncoder();
export const estTokens = (...texts) => texts.reduce((n, s) => n + utf8.encode(String(s == null ? '' : s)).length + 16, 0);
export function messageTokens(messages) {
  let n = 0;
  for (const m of messages) {
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    for (const p of parts) n += p.type === 'text' ? estTokens(p.text) : IMAGE_TOKENS;
  }
  return n;
}

// THIS SECTION IS FOR: adding up what a call cost. Returns the bill after the call.
// A call that errored before it started cost nothing. A call whose cost we do not know (dropped connection, no cost in the reply)
// keeps the hold so the cleanup job (1.12) can look it up and flag it. Money is never quietly released.
export function tally(bill, r) {
  if (!r || r.outcome === 'unknown') bill.keep = true;
  else if (r.outcome === 'error_before_start') bill.cost += 0;
  else if (typeof r.cost !== 'number') bill.keep = true;
  else bill.cost += r.cost;
  return r;
}

// THIS SECTION IS FOR: the hold lifecycle. work(bill) makes the calls and tallies each one.
// A refused hold (insufficient, paused) throws a LedgerError before any call is made.
export async function withHold({ rpc, person, requestId, amount }, work) {
  await placeHold(rpc, person, requestId, amount);
  const bill = { cost: 0, keep: false };
  let result;
  try { result = await work(bill); } catch (e) { bill.keep = true; throw e; }
  if (bill.keep) return result;
  if (bill.cost === 0) await release(rpc, requestId);
  else await settle(rpc, requestId, bill.cost);
  return result;
}
