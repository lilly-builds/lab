// THIS FILE IS FOR: per-person capped OpenRouter keys (build plan 1.8). Create, set limit, disable, and encrypt for storage.
// Endpoint and field names (/keys, limit, disabled) are UNVERIFIED until step 0.7 runs live. The master key never leaves this module's callers.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// THIS SECTION IS FOR: AES-256-GCM at rest. Output is base64url(iv | tag | ciphertext). The secret is any string; it is hashed to 32 bytes.
const k32 = (secret) => { if (!secret) throw new Error('encryption secret missing'); return createHash('sha256').update(String(secret)).digest(); };
export function encryptKey(plain, secret) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k32(secret), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
export function decryptKey(blob, secret) {
  const b = Buffer.from(String(blob), 'base64url');
  const d = createDecipheriv('aes-256-gcm', k32(secret), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

// THIS SECTION IS FOR: calls to the provisioning API. Errors carry a status only, never a key or a response body.
async function api(cfg, method, path, body) {
  const f = cfg.fetchImpl || fetch;
  let res;
  try {
    res = await f(cfg.baseUrl + path, {
      method, headers: { authorization: 'Bearer ' + cfg.masterKey, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) { throw new Error('key service unreachable'); }
  if (!res.ok) throw new Error('key service said ' + res.status);
  return res.json();
}
// cfg: { baseUrl, masterKey, fetchImpl? }
export async function createKey(cfg, { name, limit }) {
  const j = await api(cfg, 'POST', '/keys', { name, limit });
  if (!j || !j.key || !j.data || !j.data.hash) throw new Error('key service gave an unreadable reply');
  return { key: j.key, hash: j.data.hash };
}
export const setKeyLimit = (cfg, hash, limit) => api(cfg, 'PATCH', '/keys/' + encodeURIComponent(hash), { limit });
export const disableKey = (cfg, hash) => api(cfg, 'PATCH', '/keys/' + encodeURIComponent(hash), { disabled: true });
