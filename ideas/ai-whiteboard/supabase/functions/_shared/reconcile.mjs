// THIS FILE IS FOR: the daily reconciler (build plan 1.12, invariants I3 and I4). Compares our ledger with each person's OpenRouter key.
// It only flags; it never changes money or limits. A human decides what a mismatch means.
// deps: { people() -> [{ person_id, key_hash, disabled, rows: [{ id, reason, amount }], open_holds }],
//         readKey(hash) -> { limit, usage, disabled }, flag(cause, severity, person, detail) -> wroteNew }
import { limitFromRows } from './limit-rule.mjs';

export const NEAR_CAP_SHARE = 0.8;   // DEFAULT: a key this close to its limit is flagged so Lilly can top it up
const CENT = 0.01;

// THIS SECTION IS FOR: one person. Returns the causes found, for the report and the tests.
export function compare(p, key) {
  const { limit: expected, usage: spend } = limitFromRows(p.rows);
  const found = [];
  if (p.disabled) {
    if (!key.disabled) found.push({ cause: 'revoked_key_live', severity: 'high', detail: { note: 'pass revoked, key still enabled' } });
    return found;
  }
  if (Math.abs(key.limit - expected) > CENT / 2) found.push({ cause: 'limit_mismatch', severity: 'high', detail: { expected, actual: key.limit } });
  // OpenRouter may already count calls still in flight (open holds); beyond that the two must agree to the cent (I3).
  const over = key.usage - spend, held = Number(p.open_holds || 0);
  if (over > held + CENT || -over > CENT) found.push({ cause: 'usage_mismatch', severity: 'high', detail: { ledgerSpend: spend, keyUsage: key.usage, openHolds: held } });
  if (key.limit > 0 && key.usage >= NEAR_CAP_SHARE * key.limit) found.push({ cause: 'key_near_cap', severity: 'normal', detail: { usage: key.usage, limit: key.limit } });
  return found;
}

export async function reconcile(deps) {
  const report = { checked: 0, flagged: 0, unreadable: 0 };
  for (const p of await deps.people()) {
    let key;
    try { key = await deps.readKey(p.key_hash); }
    catch (e) {
      report.unreadable++;
      if (await deps.flag('key_unreadable:' + p.person_id, 'normal', p.person_id, {})) report.flagged++;
      continue;
    }
    report.checked++;
    for (const f of compare(p, key)) if (await deps.flag(f.cause + ':' + p.person_id, f.severity, p.person_id, f.detail)) report.flagged++;
  }
  return report;
}
