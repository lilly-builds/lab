// THIS FILE IS FOR: an in-memory stand-in for the ledger RPCs, so route and run tests need no database. Test use only.
// It mirrors the refusals the SQL gives (insufficient balance, double settle is a no-op, two attempts per ticket).
// The real behavior is proven by supabase/tests/policy_tests.sql against the local stack.
export function fakeLedger(balance) {
  const s = { balance, holds: new Map(), settled: [], released: [], attempts: new Map(), children: new Set() };
  const rpc = async (name, a) => {
    if (name === 'ledger_place_hold') {
      const held = [...s.holds.values()].reduce((t, h) => t + h, 0);
      if (s.balance - held < a.p_amount) return { error: { message: 'insufficient balance' } };
      s.holds.set(a.p_request, a.p_amount);
      return { data: null };
    }
    if (name === 'ledger_settle') {
      if (s.holds.has(a.p_request)) { s.holds.delete(a.p_request); s.balance -= a.p_cost; s.settled.push([a.p_request, a.p_cost]); }
      return { data: null };
    }
    if (name === 'ledger_release') { if (s.holds.delete(a.p_request)) s.released.push(a.p_request); return { data: null }; }
    if (name === 'ticket_take_attempt') {
      const n = (s.attempts.get(a.p_ticket) || 0) + 1;
      if (n > 2) return { data: null };
      s.attempts.set(a.p_ticket, n);
      return { data: n };
    }
    if (name === 'ticket_take_child') {
      if (s.children.has(a.p_ticket)) return { data: false };
      s.children.add(a.p_ticket);
      return { data: true };
    }
    return { error: { message: 'unknown rpc ' + name } };
  };
  return { s, rpc };
}
