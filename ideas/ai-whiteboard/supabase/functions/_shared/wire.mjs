// THIS FILE IS FOR: turning a database rpc and the environment into the deps that route, run, admin, cleanup, reconcile and outcome use.
// The one place that knows database function names and secret names. Hosted: rpc is supabase-js .rpc (see ../_hosted.ts);
// tests and the local dev server: testing/psql-rpc.mjs. Nothing here decides money; it only connects.
import { pick } from './rulebook.mjs';
import { buildRequest, callOpenRouter } from './openrouter.mjs';
import { createKey, setKeyLimit, disableKey, getKey, generationCost, encryptKey, decryptKey } from './keys.mjs';
import { settle, release } from './ledger.mjs';
import { drainQueue } from './limit-setter.mjs';

// DEFAULT (build plan U4): a model that failed more than 10% of its last 50 job calls is skipped, once it has at least 10 calls.
export const FAIL_WINDOW = 50, FAIL_SHARE = 0.1, FAIL_MIN_CALLS = 10;

// Secrets the functions read. The browser never sees any of them.
export const SECRETS = ['AI_TICKET_SECRET', 'AI_KEY_ENC_SECRET', 'AI_OPENROUTER_MASTER_KEY', 'AI_ADMIN_SECRET', 'AI_CRON_SECRET'];

// THIS SECTION IS FOR: one rpc call. A database error becomes a plain message naming the function, never the database's own text.
async function data(rpc, name, args) {
  const { data: d, error } = await rpc(name, args);
  if (error) throw new Error(name + ' failed');
  return d;
}
const first = (rows) => (Array.isArray(rows) ? rows[0] || null : rows || null);

export function makeDeps({ rpc, env, fetchImpl = fetch, now = () => Date.now() }) {
  const baseUrl = env.AI_OPENROUTER_URL || 'https://openrouter.ai/api/v1';
  const keysCfg = { baseUrl, masterKey: env.AI_OPENROUTER_MASTER_KEY, fetchImpl };
  const db = (name, args) => data(rpc, name, args);

  // THIS SECTION IS FOR: the person's own capped key, decrypted only in memory for the length of one request.
  const keyCache = new Map();
  async function personKey(person) {
    if (keyCache.has(person)) return keyCache.get(person);
    const row = first(await db('ai_key_of', { p_person: person }));
    if (!row || !row.key_enc || row.disabled) throw new Error('no usable key');
    const k = decryptKey(row.key_enc, env.AI_KEY_ENC_SECRET);
    keyCache.set(person, k);
    return k;
  }

  const flag = (cause, severity, person, detail) => db('ai_flag', { p_cause: cause, p_severity: severity, p_person: person || null, p_detail: detail || {} });
  const limits = {
    loadRows: async (person) => (await db('ai_ledger_rows', { p_person: person })).map((r) => ({ id: r.id, reason: r.reason, amount: Number(r.amount) })),
    keyHashOf: async (person) => { const r = first(await db('ai_key_of', { p_person: person })); return r && r.key_hash; },
    setLimit: (hash, dollars) => setKeyLimit(keysCfg, hash, dollars),
    enqueue: (person) => db('ai_limit_enqueue', { p_person: person }),
    takeDue: () => db('ai_limit_take_due', { p_max: 50 }),
    markDone: (id) => db('ai_limit_done', { p_id: id }),
    markFailed: (id, nextTry, attempts) => db('ai_limit_failed', { p_id: id, p_next_ms: nextTry, p_attempts: attempts })
  };

  return {
    rpc, env, now, ticketSecret: env.AI_TICKET_SECRET, imageMode: env.AI_GATE_IMAGE_MODE || 'native',

    // route and run
    findByHash: async (h) => first(await db('ai_find_pass', { p_hash: h })),
    hit: (key) => db('ai_rate_hit', { p_key: key, p_window_secs: 3600 }),
    isFirstAsk: (person) => db('ai_first_ask', { p_person: person }),
    storeTicket: (t) => db('ai_store_ticket', { p_id: t.id, p_person: t.person, p_ask_hash: t.askHash, p_job: t.job, p_pick: t.pick, p_expires_ms: t.exp, p_parent: t.parent || null }),
    getTicket: async (id) => {
      const r = first(await db('ai_get_ticket', { p_id: id }));
      return r ? { id: r.id, person: r.person_id, job: r.job, pick: r.pick, askHash: r.ask_hash, parent: r.parent_id } : null;
    },
    recordBlock: async (person) => (await db('ai_record_block', { p_person: person, p_window_secs: 86400 })).map(Number),
    pause: (person) => db('ai_set_paused', { p_person: person, p_paused: true, p_cause: 'safety gate blocks' }),
    usage: {
      start: (u) => db('ai_usage_start', { p_request: u.id, p_hold: u.holdId, p_person: u.person, p_job: u.job, p_attempt: u.attempt }),
      seen: (u) => db('ai_usage_seen', { p_request: u.id, p_generation: u.generationId }),
      finish: (u) => db('ai_usage_finish', { p_request: u.id, p_generation: u.generationId, p_model: u.model, p_latency_ms: u.latencyMs, p_cost: u.cost, p_outcome: u.outcome })
    },
    avoidModels: async () => (await db('ai_model_failures', { p_last: FAIL_WINDOW }))
      .filter((r) => r.calls >= FAIL_MIN_CALLS && r.failures / r.calls > FAIL_SHARE).map((r) => r.model),
    gatePick: (hasImage) => pick('gate', {}, { hasImage }, null, env),
    nextMovesPick: () => pick('nextmoves', {}, {}, null, env),
    // Every call, gate and router included, is made with the person's own capped key, so OpenRouter's cap backs up our ledger.
    call: async (p, messages, person, signal, hooks = {}) => {
      let apiKey;
      try { apiKey = await personKey(person); }
      catch (e) { return { outcome: 'error_before_start', text: '', cost: 0, generationId: null, model: null, error: 'no usable key' }; }
      return callOpenRouter({ baseUrl, apiKey, body: buildRequest({ pick: p, messages, person }), fetchImpl, signal, onStart: hooks.onStart, onDelta: hooks.onDelta });
    },
    recordOutcome: (person, ticketId, code) => db('ai_record_outcome', { p_person: person, p_ticket: ticketId, p_code: code }),

    // admin
    admin: {
      rpc,
      createPass: (hash, label) => db('ai_create_pass', { p_hash: hash, p_label: label }),
      setKey: (person, hash, enc) => db('ai_set_key', { p_person: person, p_key_hash: hash, p_key_enc: enc }),
      revokePass: (person) => db('ai_revoke_pass', { p_person: person }),
      setPaused: (person, paused) => db('ai_set_paused', { p_person: person, p_paused: paused, p_cause: paused ? 'paused by Lilly' : null }),
      createKey: (o) => createKey(keysCfg, o),
      disableKey: (hash) => disableKey(keysCfg, hash),
      encrypt: (plain) => encryptKey(plain, env.AI_KEY_ENC_SECRET),
      flag,
      openFlags: () => db('ai_open_flags', {}),
      resolveFlag: (id) => db('ai_resolve_flag', { p_id: id }),
      limits
    },

    // cleanup and reconcile
    jobs: {
      now,
      // DEFAULT is cleanup.mjs ORPHAN_WAIT_SECS; AI_ORPHAN_WAIT_SECS changes it (the local end-to-end test uses 0).
      orphanWaitSecs: env.AI_ORPHAN_WAIT_SECS == null ? null : Number(env.AI_ORPHAN_WAIT_SECS),
      staleHolds: (secs) => db('ai_stale_holds', { p_older_secs: secs }),
      lookupCost: async (person, generationId) => {
        let apiKey;
        try { apiKey = await personKey(person); } catch (e) { return null; }
        return generationCost({ baseUrl, apiKey, fetchImpl }, generationId);
      },
      settle: (id, dollars) => settle(rpc, id, dollars),
      release: (id) => release(rpc, id),
      flag,
      drainLimits: (t) => drainQueue(t, limits),
      spendSince: (secs) => db('ai_spend_since', { p_secs: secs }),
      prune: (secs) => db('ai_prune', { p_older_secs: secs }),
      people: () => db('ai_reconcile_rows', {}),
      readKey: (hash) => getKey(keysCfg, hash)
    }
  };
}
