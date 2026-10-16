/* Supabase connection for the dreamspace whiteboard sync layer.
   The URL and publishable anon key are public by design: Row Level Security, not secrecy,
   protects the data. Never put a service-role key in this file (it is committed).
   enabled is the runtime gate for board sync (plan KTD5): false = zero backend calls, app
   behaves as the pure local demo. ?sync=on opts in per session, ?sync=off always wins.
   templatesEnabled is the separate gate for the Board Room (gallery reads + publishing),
   so templates go live while board sync stays dark. ?sync=off kills both. */
window.AIWB_SUPABASE = {
  url: 'https://bgnjzyaxgjlpqnnbcfjs.supabase.co',
  anonKey: 'sb_publishable_o9F68Ot-Yb0UgmJsnHhAUg_loE-FE3A',
  enabled: false,
  templatesEnabled: true
};
