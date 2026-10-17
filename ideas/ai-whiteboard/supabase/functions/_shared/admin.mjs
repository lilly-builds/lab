// THIS FILE IS FOR: Lilly's admin door (build plan 1.8 and 1.12). Human-only actions: create a tester pass with its first grant and
// capped key, grant more, revoke, unpause, settle or release a flagged hold by hand, list and resolve flags.
// The caller has already checked the admin secret. deps: makeDeps(...).admin in wire.mjs. Money moves only through the ledger functions.
import { newPass } from './auth.mjs';
import { adjust, settle, release, LedgerError } from './ledger.mjs';
import { limitFromRows } from './limit-rule.mjs';
import { setLimitOrQueue } from './limit-setter.mjs';

// DEFAULT: one grant above this is refused as a likely typo (Lilly can raise it). Phase 1 grants are small, hand-entered amounts.
export const MAX_GRANT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const refuse = (status, reason) => ({ status, body: { ok: false, reason } });
const money = (v) => typeof v === 'number' && isFinite(v) && v > 0 && v <= MAX_GRANT && Math.round(v * 100) === v * 100;

export async function admin(deps, input) {
  const a = input || {};
  try {
    switch (a.action) {
      case 'create': return await create(deps, a);
      case 'grant': {
        if (!UUID.test(a.person || '') || !money(a.amount) || typeof a.idem !== 'string' || !a.idem) return refuse(400, 'bad_input');
        await adjust(deps.rpc, a.person, a.amount, String(a.note || 'hand grant').slice(0, 200), 'grant:' + a.idem.slice(0, 80));
        const limit = await setLimitOrQueue(a.person, deps.limits);
        return { status: 200, body: { ok: true, limit: limit.ok ? limit.limit : null, limitQueued: !limit.ok } };
      }
      case 'revoke': {
        if (!UUID.test(a.person || '')) return refuse(400, 'bad_input');
        const keyHash = await deps.revokePass(a.person);
        let keyDisabled = !keyHash;
        if (keyHash) {
          try { await deps.disableKey(keyHash); keyDisabled = true; }
          catch (e) { await deps.flag('revoke_key_failed:' + a.person, 'high', a.person, {}); }
        }
        return { status: 200, body: { ok: true, keyDisabled } };
      }
      case 'unpause': {
        if (!UUID.test(a.person || '')) return refuse(400, 'bad_input');
        await deps.setPaused(a.person, false);
        return { status: 200, body: { ok: true } };
      }
      case 'settle_hold': {
        if (typeof a.request !== 'string' || !(typeof a.cost === 'number' && isFinite(a.cost) && a.cost >= 0)) return refuse(400, 'bad_input');
        if (a.cost === 0) await release(deps.rpc, a.request); else await settle(deps.rpc, a.request, a.cost);
        return { status: 200, body: { ok: true } };
      }
      case 'flags': return { status: 200, body: { ok: true, flags: await deps.openFlags() } };
      case 'resolve_flag': {
        if (!Number.isInteger(a.id)) return refuse(400, 'bad_input');
        await deps.resolveFlag(a.id);
        return { status: 200, body: { ok: true } };
      }
      default: return refuse(400, 'unknown_action');
    }
  } catch (e) {
    if (e instanceof LedgerError) return refuse(409, e.code);
    return refuse(500, 'server');
  }
}

// THIS SECTION IS FOR: a new tester. The pass is shown once, here, and stored only as a hash. The key is created with its limit already
// set from the ledger (a key without a limit is never made), and stored encrypted. If the key cannot be made, the pass is revoked.
async function create(deps, a) {
  if (!money(a.grant)) return refuse(400, 'bad_input');
  const label = String(a.label || '').slice(0, 60);
  const p = newPass();
  const person = await deps.createPass(p.hash, label);
  await adjust(deps.rpc, person, a.grant, 'first grant', 'create:' + person);
  const { limit } = limitFromRows(await deps.limits.loadRows(person));
  let key;
  try {
    // The key's name goes to OpenRouter, so it carries the person id, never the label (which may be a real name).
    key = await deps.createKey({ name: 'tester ' + person.slice(0, 8), limit });
    await deps.setKey(person, key.hash, deps.encrypt(key.key));
  } catch (e) {
    await deps.revokePass(person);
    if (key && key.hash) { try { await deps.disableKey(key.hash); } catch (e2) { await deps.flag('create_key_orphan:' + person, 'high', person, {}); } }
    return refuse(502, 'key_failed');
  }
  return { status: 200, body: { ok: true, person, pass: p.pass, limit } };
}
