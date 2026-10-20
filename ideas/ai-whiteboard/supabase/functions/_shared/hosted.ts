// THIS FILE IS FOR: the hosted wiring every AI Edge Function shares: a service-role database client and the environment. Deno only.
// Supabase injects SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; the AI_* secrets are set by Lilly (see supabase/README.md).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { makeDeps, SECRETS } from './wire.mjs';

export function hostedDeps() {
  const env = Deno.env.toObject();
  const missing = SECRETS.filter((k) => !env[k]);
  if (missing.length) console.error('[ai-toolbox] missing secrets: ' + missing.join(', ')); // names only, never values
  const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return makeDeps({ rpc: (name: string, args: Record<string, unknown>) => db.rpc(name, args), env });
}
