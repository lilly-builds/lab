// THIS FILE IS FOR: route tickets (architecture 4.2, invariant I5). Signing, expiry, person and ask matching, attempt counting.
// The database RPC ticket_take_attempt (step 1.2) is the atomic version of takeAttempt; this module is its spec and the signer.
import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto';

export const MAX_ATTEMPTS = 2;
// A build may run 5 minutes (the browser's cap) and fail; the retry then starts on the same ticket and may run 5 more.
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

// THIS SECTION IS FOR: the ask hash. Same ask, same hash, whatever the spacing or case.
export function hashAsk(text) {
  const norm = String(text == null ? '' : text).trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(norm).digest('hex');
}

const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (secret, body) => createHmac('sha256', secret).update(body).digest('base64url');

// THIS SECTION IS FOR: issuing. parent is set only for a nextmoves child ticket.
export function issueTicket({ secret, person, askHash, now, ttlMs = DEFAULT_TTL_MS, parent = null }) {
  if (!secret) throw new Error('ticket secret missing');
  const payload = { id: randomUUID(), p: person, h: askHash, exp: now + ttlMs, par: parent };
  const body = b64(JSON.stringify(payload));
  return { token: body + '.' + sign(secret, body), payload };
}

// THIS SECTION IS FOR: checking. Returns { ok, payload } or { ok:false, reason }.
export function verifyTicket({ secret, token, person, askHash, now }) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const want = Buffer.from(sign(secret, parts[0]));
  const got = Buffer.from(parts[1]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: 'bad_signature' };
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch (e) { return { ok: false, reason: 'malformed' }; }
  if (now > payload.exp) return { ok: false, reason: 'expired' };
  if (payload.p !== person) return { ok: false, reason: 'wrong_person' };
  if (payload.h !== askHash) return { ok: false, reason: 'wrong_ask' };
  return { ok: true, payload };
}

// THIS SECTION IS FOR: which ticket an outcome report is about. Checks the signature and the person, not the ask or expiry
// (an undo can come long after the answer). Returns the ticket id or null.
export function ticketIdOf({ secret, token, person }) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 2) return null;
  const want = Buffer.from(sign(secret, parts[0])), got = Buffer.from(parts[1]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try { const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); return p.p === person ? p.id : null; } catch (e) { return null; }
}

// THIS SECTION IS FOR: attempt counting on a state row { attempts, childIssued }.
export function takeAttempt(state) {
  if (state.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'no_attempts_left', state };
  return { ok: true, state: { ...state, attempts: state.attempts + 1 } };
}

// A build ticket may issue one nextmoves child, once.
export function takeChild(state) {
  if (state.childIssued) return { ok: false, reason: 'child_already_issued', state };
  return { ok: true, state: { ...state, childIssued: true } };
}
