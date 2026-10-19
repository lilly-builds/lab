# Dreamspace whiteboard backend (Supabase)

Plan: `plans/2026-10-12-2015-feat-dreamspace-server-database-plan.md` (KTD1, KTD5).

## One-time setup

1. Create the hosted project at supabase.com (free tier is fine for demo scale).
2. Install the CLI (`brew install supabase/tap/supabase` or see supabase.com/docs/guides/cli).
3. From this directory: `supabase link --project-ref <your-project-ref>`.
4. Put the project's URL and publishable anon key into `../supabase-config.js`
   (never the service-role key - this file is committed and shipped to browsers).
5. Enable CAPTCHA for sign-in in the hosted project settings (R18), and set
   `[auth.captcha] enabled = true` with the secret in `config.toml`.
6. Enable secure email change in Auth settings (U5).

## Migrations

- Apply to the linked hosted project: `supabase db push`
- Reset and replay locally (needs Docker): `supabase db reset`
- Migration files live in `migrations/`, timestamp-prefixed, one change per file.
  They must apply cleanly on an empty database twice in a row.

## Rollout and kill switch

`supabase-config.js` ships with `enabled: false`. Sync is opt-in via `?sync=on`
until the plan's M-gates pass; rollout flips the default; `?sync=off` always kills it.

## Backup posture

The free tier has NO automatic backups (supabase.com/pricing). Until the project is
on a paid tier, run a scheduled export:

    supabase db dump --linked -f backups/$(date +%F).sql

Weekly cadence is enough at demo scale. Pro adds 7-day automatic backups; PITR is a
paid add-on. Revisit when real user data accumulates.

## Board storage limits

A board allows up to 2,000 live elements and 4,000 retained rows total (live
elements plus 30-day tombstones). Every insert, including an already-deleted
direct API insert, consumes retained-row capacity; the purge releases capacity.
Heavy delete/create churn can therefore stop new writes before the live limit is
reached. Raise the retained-row limit only with a storage and abuse review; do
not bypass the counter or shorten tombstone retention to hide a full board.

## AI Magic Toolbox (phase 1: tester passes)

Plans: `plans/2026-10-14-ai-magic-toolbox-architecture.md`, `plans/2026-10-17-ai-magic-toolbox-build-plan.md`.
Every AI ask goes through six Edge Functions (`functions/route`, `run`, `outcome`, `admin`, `cleanup`, `reconcile`); the logic lives in
`functions/_shared`. The board only uses them when switched on (`toolboxEnabled: true` in `../supabase-config.js`, or `?toolbox=on`).

Turning it on is Lilly's, in this order. Nothing here has been run against the hosted project.

1. Phase 0 first: the model allowlist (`functions/_shared/allowlist.mjs`) is a placeholder and the functions refuse to run on it.
   The OpenRouter field names are unverified until the step 0.7 probe passes.
2. Apply the migrations: `supabase db push`.
3. Set the function secrets (names only here; values never go in a file):
   `supabase secrets set AI_TICKET_SECRET=... AI_KEY_ENC_SECRET=... AI_OPENROUTER_MASTER_KEY=... AI_ADMIN_SECRET=... AI_CRON_SECRET=...`
   Use long random values (`openssl rand -hex 32`) for all but the OpenRouter provisioning key. Changing AI_KEY_ENC_SECRET later makes
   every stored tester key unreadable. Optional: AI_ALLOWED_ORIGINS (default `https://lilly-builds.github.io`), AI_NEXT_MOVES=off,
   AI_IP_HEADER (default `cf-connecting-ip`; check on the first deploy that this header arrives).
4. Deploy: `supabase functions deploy route run outcome admin cleanup reconcile` (config.toml turns the JWT check off for these; they
   check a tester pass or a secret themselves).
5. Schedule the jobs: run `ops/ai_toolbox_schedule.sql` once in the SQL editor (its header says what to fill in).
6. Make a tester: `AI_ADMIN_SECRET=... node ideas/ai-whiteboard/tools/toolbox-admin.mjs create --label "Sam" --grant 5`
   (prints the pass once). `grant`, `revoke`, `unpause`, `flags`, `resolve` and `settle-hold` work the same way.
7. Keep OpenRouter auto top-up OFF. Check `flags` regularly: that list is how the system tells Lilly something needs her
   (a hold it could not price, a key that disagrees with the ledger, a paused tester, a day's spend over $10).

Locally, with no accounts: `bash ideas/ai-whiteboard/supabase/tests/scratch.sh`, then
`AI_TEST_DATABASE_URL=postgresql://localhost:5432/ai_toolbox_scratch node ideas/ai-whiteboard/tools/dev-server.mjs --pass 5`
and open `http://localhost:8787/?toolbox=local`. A fake model answers every job; `POST /dev/mock {"mode":"cutoff"}` tries failures.

## Local verification without the hosted project

`migrations/` and `tests/` are plain SQL and node scripts; see `tests/README` notes
in each test header for running against a scratch Postgres.

## Tests

`tests/policy_tests.sql` holds the U2/U3 assertion suite (schema constraints,
RLS role-split, RPC semantics; 118 assertions). It sets sessions through
`request.jwt.claims`, the setting Supabase's real `auth.uid()`/`auth.jwt()`
read, and runs against `supabase start` locally (CI, U10, on every PR) or a
scratch Postgres that mirrors Supabase: `anon`/`authenticated`/`service_role`
roles, an `auth` schema with `auth.users` and claim-reading `auth.uid()` and
`auth.jwt()`, and Supabase's default privileges (ALL on new public tables and
functions to the API roles). Without those default grants a scratch run can
pass while hosted Supabase leaks. A throwaway embedded-Postgres runner used during
development lives outside the repo; ask for it if you want the same setup.
