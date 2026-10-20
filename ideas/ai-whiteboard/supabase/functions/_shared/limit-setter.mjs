// THIS FILE IS FOR: the limit setter and its retry queue (build plan 1.8, invariant I4).
// After any money event it SETS the person's key limit to computeLimit(ledger, usage). It never adds. A failure goes on the retry queue.
import { limitFromRows } from './limit-rule.mjs';

// THIS SECTION IS FOR: one SET. deps: { loadRows(person), keyHashOf(person), setLimit(hash, dollars), enqueue(person) }.
export async function applyLimit(person, deps) {
  const { limit } = limitFromRows(await deps.loadRows(person));
  const hash = await deps.keyHashOf(person);
  if (!hash) return { ok: false, reason: 'no_key' };
  await deps.setLimit(hash, limit);
  return { ok: true, limit };
}

// Never throws: a failed SET is queued, and the money event that triggered it still stands.
export async function setLimitOrQueue(person, deps) {
  try { return await applyLimit(person, deps); }
  catch (e) { await deps.enqueue(person); return { ok: false, reason: 'queued' }; }
}

// THIS SECTION IS FOR: draining the queue. deps adds: { takeDue(now) -> [{id, person_id, attempts}], markDone(id), markFailed(id, nextTry, attempts) }.
// The retry recomputes from the ledger (a SET), so a retry after later events is still correct. Backoff doubles from one minute, capped at an hour.
export const backoffMs = (attempts) => Math.min(3600000, 60000 * 2 ** Math.max(0, attempts));
export async function drainQueue(now, deps) {
  const due = await deps.takeDue(now);
  let done = 0, failed = 0;
  for (const job of due) {
    try {
      const r = await applyLimit(job.person_id, deps);
      if (r.ok || r.reason === 'no_key') { await deps.markDone(job.id); done++; }
      else throw new Error('not applied');
    } catch (e) {
      await deps.markFailed(job.id, now + backoffMs(job.attempts + 1), job.attempts + 1);
      failed++;
    }
  }
  return { done, failed };
}
