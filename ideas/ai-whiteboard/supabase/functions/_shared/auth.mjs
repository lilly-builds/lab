// THIS FILE IS FOR: tester passes (build plan 1.8). A pass is a random private code shown once; only its SHA-256 hex is stored.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// THIS SECTION IS FOR: making and hashing a pass. Plain SHA-256 hex, because my_balance() hashes the same way in SQL.
export const hashPass = (pass) => createHash('sha256').update(String(pass), 'utf8').digest('hex');
export function newPass() {
  const pass = 'tp_' + randomBytes(24).toString('base64url');
  return { pass, hash: hashPass(pass) };
}

// THIS SECTION IS FOR: reading the bearer header.
export function bearer(headers) {
  const h = (headers && (typeof headers.get === 'function' ? headers.get('authorization') : headers.authorization)) || '';
  const m = /^Bearer (\S+)$/.exec(h);
  return m ? m[1] : null;
}

// THIS SECTION IS FOR: checking a pass. findByHash(hash) -> { id, pass_hash, disabled, paused } | null (a service-role lookup).
// Returns { ok, person } or { ok:false, reason: 'missing'|'unknown'|'disabled'|'paused' }. The hashes are compared in constant time.
export async function authenticate(headers, findByHash) {
  const pass = bearer(headers);
  if (!pass) return { ok: false, reason: 'missing' };
  const hash = hashPass(pass);
  const row = await findByHash(hash);
  if (!row) return { ok: false, reason: 'unknown' };
  const a = Buffer.from(hash), b = Buffer.from(String(row.pass_hash));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'unknown' };
  if (row.disabled) return { ok: false, reason: 'disabled' };
  if (row.paused) return { ok: false, reason: 'paused' };
  return { ok: true, person: row.id };
}

// THIS SECTION IS FOR: the human-only admin door (create or revoke a pass). Compared in constant time against a server secret.
export function isAdmin(headers, adminSecret) {
  const t = bearer(headers);
  if (!t || !adminSecret) return false;
  const a = Buffer.from(hashPass(t)), b = Buffer.from(hashPass(adminSecret));
  return timingSafeEqual(a, b);
}
