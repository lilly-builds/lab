/* Supabase connection for the dreamspace whiteboard sync layer.
   The URL and publishable anon key are public by design: Row Level Security, not secrecy,
   protects the data. Never put a service-role key in this file (it is committed).
   enabled is the runtime gate (plan KTD5): false = zero backend calls, app behaves as the
   pure local demo. ?sync=on opts in per session, ?sync=off always wins. */
window.AIWB_SUPABASE = {
  url: 'https://YOUR-PROJECT-REF.supabase.co',
  anonKey: 'PUBLISHABLE-ANON-KEY',
  enabled: false
};
