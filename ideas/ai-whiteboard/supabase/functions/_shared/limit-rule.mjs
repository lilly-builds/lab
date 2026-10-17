// THIS FILE IS FOR: the OpenRouter key-limit rule (architecture section 5, invariant I4). Pure: no network, no clock.
// limit = max(granted - deducted, current usage), in dollars rounded to cents.

const GRANTS = new Set(['paid', 'free', 'bonus', 'adjustment']);
const DEDUCTIONS = new Set(['refund', 'dispute', 'expire']);
const RESTORES = new Set(['refund_failed', 'dispute_restored']);

const cents = (n) => Math.round(Number(n) * 100);

// rows: [{ id, reason, amount }] with amount >= 0 dollars. A repeated id counts once (duplicate webhooks, retries).
export function computeLimit(rows, usage) {
  const seen = new Set();
  let net = 0; // cents
  for (const r of rows || []) {
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    const c = cents(r.amount);
    if (!Number.isFinite(c) || c < 0) throw new Error('ledger row has a bad amount: ' + r.id);
    if (GRANTS.has(r.reason) || RESTORES.has(r.reason)) net += c;
    else if (DEDUCTIONS.has(r.reason)) net -= c;
    else throw new Error('unknown ledger reason: ' + r.reason);
  }
  return Math.max(net, cents(usage || 0)) / 100;
}

// THIS SECTION IS FOR: a person's whole ledger in, their key limit out (the limit setter, the reconciler and a new tester all use it).
// 'spend' rows are settled calls: they count as usage, not as grants or deductions. Returns { limit, usage } in dollars.
export function limitFromRows(rows) {
  const all = (rows || []).map((r) => ({ id: r.id, reason: r.reason, amount: Number(r.amount) }));
  const usage = all.filter((r) => r.reason === 'spend').reduce((s, r) => s + r.amount, 0);
  return { limit: computeLimit(all.filter((r) => r.reason !== 'spend'), usage), usage };
}
