// THIS FILE IS FOR: holding money around a group of AI calls and settling to the real cost (invariants I1, I2).
// Shared by route.mjs and run.mjs so both settle the same way.
import { placeHold, settle, release } from './ledger.mjs';

// THIS SECTION IS FOR: token guesses for the hold's input side. Rough on purpose; the hold only needs to be an upper bound.
export const estTokens = (chars) => Math.ceil(chars / 3);

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
