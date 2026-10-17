// THIS FILE IS FOR: the cleanup job (build plan 1.12, invariant I2). Every hold ends as a settle, a release, or a flag to Lilly;
// money is never quietly released. Also retries failed key-limit updates, raises the daily spend alert, and prunes old counters.
import { toMicros, fromMicros } from './billing.mjs';
// deps: { staleHolds(olderSecs) -> [{ request_id, person_id, amount, usage: [{ request_id, generation_id, cost, outcome }] }],
//         lookupCost(person, generationId) -> dollars | null, settle(requestId, dollars), release(requestId),
//         flag(cause, severity, person, detail) -> wroteNew, drainLimits(now) -> { done, failed }, spendSince(secs) -> dollars,
//         prune(olderSecs), now() }

// DEFAULTS Lilly can change (build plan U4).
export const ORPHAN_WAIT_SECS = 10 * 60;   // a hold this old with no settle is an orphan
export const DAILY_SPEND_ALERT = 10;       // dollars settled in 24 hours that raise a flag
export const PRUNE_AFTER_SECS = 2 * 86400; // rate windows and gate blocks older than this are deleted

// THIS SECTION IS FOR: what one orphaned hold cost, from its usage rows. Returns { total } or { unresolved: [usage ids] }.
// A known cost counts as is; an error before the call started cost nothing; a generation id is looked up; anything else is unknown.
export async function holdCost(hold, lookupCost) {
  let micros = 0;
  const unresolved = [];
  for (const u of hold.usage || []) {
    if (u.cost !== null && u.cost !== undefined && isFinite(Number(u.cost))) { micros += toMicros(u.cost); continue; }
    if (u.outcome === 'error_before_start') continue;
    const c = u.generation_id ? await lookupCost(hold.person_id, u.generation_id) : null;
    if (typeof c === 'number' && isFinite(c)) micros += toMicros(c);
    else unresolved.push(u.request_id);
  }
  return unresolved.length ? { unresolved } : { total: fromMicros(micros) };
}

export async function cleanup(deps) {
  const report = { settled: 0, released: 0, flagged: 0, kept: 0, limits: null, spendAlert: false };

  for (const h of await deps.staleHolds(deps.orphanWaitSecs == null ? ORPHAN_WAIT_SECS : deps.orphanWaitSecs)) {
    const c = await holdCost(h, deps.lookupCost);
    if (c.unresolved) {
      report.kept++;
      if (await deps.flag('hold_unresolved:' + h.request_id, 'high', h.person_id, { hold: Number(h.amount), unresolved: c.unresolved })) report.flagged++;
      continue;
    }
    // No usage rows means no call was ever started under this hold (each call writes its row first), so nothing was spent.
    if (c.total > 0) { await deps.settle(h.request_id, c.total); report.settled++; }
    else { await deps.release(h.request_id); report.released++; }
  }

  report.limits = await deps.drainLimits(deps.now());

  const spent = Number(await deps.spendSince(86400));
  if (spent > DAILY_SPEND_ALERT) {
    const day = new Date(deps.now()).toISOString().slice(0, 10);
    report.spendAlert = await deps.flag('daily_spend:' + day, 'high', null, { spent, threshold: DAILY_SPEND_ALERT });
  }

  await deps.prune(PRUNE_AFTER_SECS);
  return report;
}
