-- THIS FILE IS FOR: making a plain Postgres look enough like Supabase to apply migrations/ and run policy_tests.sql
-- without Docker (the README's "scratch Postgres that mirrors Supabase"). Never applied to a real project.
-- What it mirrors: the API roles, an auth schema whose uid()/jwt() read request.jwt.claims like PostgREST sets them,
-- and Supabase's default privileges (ALL on new public tables and functions to the API roles), so a scratch run
-- cannot pass while the hosted project would leak. Run it once on an empty database, as a superuser.

-- THIS SECTION IS FOR: the API roles. Roles are cluster-wide, so they are created only when missing.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;
grant anon, authenticated, service_role to current_user;

-- THIS SECTION IS FOR: the auth schema the migrations reference.
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now()
);
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

-- THIS SECTION IS FOR: Supabase's default grants on public. Migrations must revoke what they do not want exposed.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
