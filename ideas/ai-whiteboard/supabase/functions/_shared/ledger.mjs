// THIS FILE IS FOR: the thin client over the ledger RPCs (build plan 1.2). It holds no money logic; the database does.
// rpc is (name, args) => Promise<{ data, error }>, e.g. a supabase-js service-role client's .rpc bound to it.

// THIS SECTION IS FOR: turning database refusals into names the callers can branch on.
export class LedgerError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function classify(error) {
  const m = String((error && error.message) || error);
  if (/insufficient balance/.test(m)) return 'insufficient';
  if (/access paused/.test(m)) return 'paused';
  if (/unknown person/.test(m)) return 'unknown_person';
  return 'ledger_error';
}
async function call(rpc, name, args) {
  const { data, error } = await rpc(name, args);
  if (error) throw new LedgerError(classify(error), name + ' failed: ' + classify(error));
  return data;
}

export const placeHold = (rpc, person, requestId, amount) =>
  call(rpc, 'ledger_place_hold', { p_person: person, p_request: requestId, p_amount: amount });

// Settle to the real cost. A call refused before it started was not charged: use settleZero, which releases the hold.
export const settle = (rpc, requestId, cost) =>
  call(rpc, 'ledger_settle', { p_request: requestId, p_cost: cost });
export const release = (rpc, requestId) => call(rpc, 'ledger_release', { p_request: requestId });
export const settleZero = release;

export const adjust = (rpc, person, amount, note, idemKey = null) =>
  call(rpc, 'ledger_adjust', { p_person: person, p_amount: amount, p_note: note, p_idem: idemKey });

// Returns the attempt number taken (1 or 2), or null when refused (expired, wrong person, or both attempts used).
export const takeAttempt = (rpc, ticketId, person) =>
  call(rpc, 'ticket_take_attempt', { p_ticket: ticketId, p_person: person });
// A refused hold made no call: the attempt goes back. Returns true when it did.
export const giveBackAttempt = (rpc, ticketId, person, attempt) =>
  call(rpc, 'ticket_give_back_attempt', { p_ticket: ticketId, p_person: person, p_attempt: attempt });
export const takeChild = (rpc, ticketId, person) =>
  call(rpc, 'ticket_take_child', { p_ticket: ticketId, p_person: person });
