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

## Local verification without the hosted project

`migrations/` and `tests/` are plain SQL and node scripts; see `tests/README` notes
in each test header for running against a scratch Postgres.

## Tests

`tests/policy_tests.sql` holds the U2/U3 assertion suite (schema constraints,
RLS role-split, RPC semantics; 110 assertions). It sets sessions through
`request.jwt.claims`, the setting Supabase's real `auth.uid()`/`auth.jwt()`
read, and runs against `supabase start` locally (CI, U10, on every PR) or a
scratch Postgres that mirrors Supabase: `anon`/`authenticated`/`service_role`
roles, an `auth` schema with `auth.users` and claim-reading `auth.uid()` and
`auth.jwt()`, and Supabase's default privileges (ALL on new public tables and
functions to the API roles). Without those default grants a scratch run can
pass while hosted Supabase leaks. A throwaway embedded-Postgres runner used during
development lives outside the repo; ask for it if you want the same setup.
