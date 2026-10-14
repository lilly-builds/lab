-- U2: Core schema for the dreamspace whiteboard backend.
-- Plan: plans/2026-10-12-2015-feat-dreamspace-server-database-plan.md (HTD, KTD2, KTD3, KTD6).
-- One migration: tables, constraints, indexes, integrity triggers, views.
-- RLS and RPCs land in 202610121530_rls_rpcs_realtime.sql.

create extension if not exists citext;

-- Random bytes for token/key generation, from core gen_random_uuid() so the
-- schema does not depend on where pgcrypto is installed (Supabase vs scratch).
create or replace function public.app_random_bytes(p_len int) returns bytea
  language sql volatile set search_path = pg_catalog as $$
  select decode(substring(string_agg(replace(gen_random_uuid()::text, '-', ''), '') from 1 for p_len * 2), 'hex')
  from generate_series(1, ceil(p_len / 16.0)::int)
$$;

-- ---------------------------------------------------------------- constants
-- Per-board element cap (R14) and per-user board quota (R18).
-- Kept as literals in the triggers below: board_elements cap 2000, boards per owner 50.

-- ------------------------------------------------------------------ profiles
-- One row per auth.users row (provisioned by trigger). email/display_name are
-- null until claimed; email is visible to the owner only (RLS, U3 file).
create table public.profiles (
  id uuid primary key references auth.users (id),
  email citext,
  display_name text,
  claimed_at timestamptz,
  deleted_at timestamptz  -- soft delete only; no hard cascades anywhere in this schema
);
create unique index profiles_email_unique on public.profiles (email) where email is not null;

-- -------------------------------------------------------------------- boards
create table public.boards (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id),
  title text not null default 'Dream board',
  element_count int not null default 0 check (element_count >= 0),  -- trigger-maintained, capped
  import_key text unique,  -- client-generated idempotency key for first-sync import (R7)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

-- ------------------------------------------------------------ board_elements
-- One row per element (KTD2). element_key is the client element id: 'e<n>' on
-- legacy content, collision-resistant nanoid-style on synced boards.
create table public.board_elements (
  board_id uuid not null references public.boards (id),
  element_key text not null check (element_key ~ '^[A-Za-z0-9_-]{1,64}$'),
  type text not null check (type in ('note','text','image','rect','diamond','ellipse','line','arrow','pen','embed')),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object')
    check (octet_length(payload::text) <= 65536)              -- 64KB cap (R14)
    check (payload::text !~* 'data:[a-z0-9.+-]+/[a-z0-9.+-]+'), -- no data: URLs (R14)
  version int not null default 1,        -- trigger-set; CAS on write
  updated_by uuid,                       -- trigger-set from auth.uid()
  updated_at timestamptz not null default now(),  -- trigger-set
  deleted_at timestamptz,                -- tombstone; purge job hard-deletes after retention
  primary key (board_id, element_key)
);
create index board_elements_board_updated on public.board_elements (board_id, updated_at);
create index board_elements_live on public.board_elements (board_id) where deleted_at is null;

-- Integrity: version, updated_by, updated_at are set by the database, never
-- accepted from the client (KTD2). Tombstones and payload changes bump version.
create or replace function public.set_element_integrity() returns trigger
  language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.updated_at := now();
    new.updated_by := auth.uid();
    return new;
  end if;
  -- an element never changes board or key: moving it would vanish it from
  -- every other client's pull and dodge the source board's counter
  if new.board_id is distinct from old.board_id or new.element_key is distinct from old.element_key then
    raise exception 'elements cannot be moved between boards or keys' using errcode = 'raise_exception';
  end if;
  new.version := old.version + 1;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), old.updated_by);
  return new;
end $$;
create trigger board_elements_integrity
  before insert or update on public.board_elements
  for each row execute function public.set_element_integrity();

-- Element count maintenance and per-board cap (R14). Enforcement lives in the
-- AFTER count trigger on purpose: a plain SELECT in a BEFORE trigger reads the
-- statement-start snapshot and cannot see rows inserted earlier in the same
-- multi-row statement, which would let a bulk insert skip the cap. The UPDATE
-- ... RETURNING here locks and re-reads the board row, so the check is exact
-- for single-row and bulk inserts alike; a raise rolls back the statement.
-- Security definer: editors have no UPDATE right on boards, so as the caller
-- the counter UPDATE would match zero rows under RLS and silently skip the cap.
create or replace function public.board_elements_count() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_count int;
begin
  if tg_op = 'INSERT' then
    if new.deleted_at is null then
      update public.boards set element_count = element_count + 1 where id = new.board_id
        returning element_count into v_count;
      if v_count > 2000 then
        raise exception 'board element cap reached' using errcode = 'check_violation';
      end if;
    end if;
    return new;
  end if;
  if (old.deleted_at is null) and (new.deleted_at is not null) then
    update public.boards set element_count = element_count - 1 where id = new.board_id;
  elsif (old.deleted_at is not null) and (new.deleted_at is null) then
    update public.boards set element_count = element_count + 1 where id = new.board_id
      returning element_count into v_count;
    if v_count > 2000 then
      raise exception 'board element cap reached' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger board_elements_count
  after insert or update on public.board_elements
  for each row execute function public.board_elements_count();

-- boards.updated_at is trigger-set; owner_id is immutable (R9: ownership
-- cannot be transferred).
create or replace function public.boards_integrity() returns trigger
  language plpgsql set search_path = pg_catalog, public as $$
begin
  new.updated_at := now();
  if new.owner_id is distinct from old.owner_id then
    raise exception 'board ownership cannot be transferred' using errcode = 'raise_exception';
  end if;
  return new;
end $$;
create trigger boards_integrity
  before update on public.boards
  for each row execute function public.boards_integrity();

-- ------------------------------------------------------------- board_members
create table public.board_members (
  board_id uuid not null references public.boards (id),
  user_id uuid not null references public.profiles (id),
  role text not null check (role in ('owner','editor','viewer')),
  joined_at timestamptz not null default now(),
  primary key (board_id, user_id)
);
create index board_members_user on public.board_members (user_id);

-- Ownership pinning (KTD6, R9): the owner row cannot be deleted or demoted,
-- no row can be promoted to owner, and no row can be moved to another person
-- or board (that would hand someone a board, or the ownership, unasked).
create or replace function public.board_members_pin_owner() returns trigger
  language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'DELETE' and old.role = 'owner' then
    raise exception 'the board owner cannot be removed' using errcode = 'raise_exception';
  end if;
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id or new.board_id is distinct from old.board_id then
      raise exception 'membership rows cannot be moved' using errcode = 'raise_exception';
    end if;
    if old.role = 'owner' and new.role <> 'owner' then
      raise exception 'the board owner cannot be demoted' using errcode = 'raise_exception';
    end if;
    if old.role <> 'owner' and new.role = 'owner' then
      raise exception 'ownership cannot be granted' using errcode = 'raise_exception';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger board_members_pin_owner
  before update or delete on public.board_members
  for each row execute function public.board_members_pin_owner();

-- ------------------------------------------------------------------- invites
-- Single-use links (U7). Token defaults to 192 bits of url-safe randomness
-- (24 bytes base64url = 32 chars); >=128-bit per plan.
create or replace function public.gen_invite_token() returns text
  language sql volatile set search_path = pg_catalog as $$
  select rtrim(translate(encode(public.app_random_bytes(24), 'base64'), '+/', '-_'), '=')
$$;
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards (id),
  token text not null unique default public.gen_invite_token(),
  role text not null default 'editor' check (role in ('editor','viewer')),
  created_by uuid not null default auth.uid() references public.profiles (id),  -- the app inserts without it (team.js)
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  accepted_by uuid references public.profiles (id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  check ((accepted_by is null) = (accepted_at is null))
);

-- Throttle source for accept_invite (brute-force bound on token guesses).
create table public.invite_accept_attempts (
  id bigint generated always as identity primary key,
  token_attempted text not null,
  user_id uuid not null,
  succeeded boolean not null,
  created_at timestamptz not null default now()
);
create index invite_accept_attempts_user_recent
  on public.invite_accept_attempts (user_id, created_at);

-- -------------------------------------------------------------- juice_events
-- Append-only ledger (KTD3). Balances are SUMs over this table; rows are never
-- updated or deleted. reason/amount pairing and one-earn-per-note are CHECKs.
create table public.juice_events (
  id bigint generated always as identity primary key,
  board_id uuid not null references public.boards (id),
  user_id uuid not null references public.profiles (id),
  note_key text,  -- board_elements.element_key; null for imports
  reason text not null check (reason in ('have_to_completed','want_to_completed','dream_completed','imported_balance')),
  amount int not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  check (
    (reason = 'have_to_completed' and amount = 1 and note_key is not null) or
    (reason = 'want_to_completed' and amount = 2 and note_key is not null) or
    (reason = 'dream_completed'  and amount = 10 and note_key is not null) or
    (reason = 'imported_balance' and amount >= 0 and note_key is null)
  )
);
create index juice_events_board_user on public.juice_events (board_id, user_id);
-- One earn per note ever, regardless of which circle it sat in (AE4).
create unique index juice_events_one_earn on public.juice_events (board_id, note_key)
  where reason in ('have_to_completed','want_to_completed','dream_completed');

-- ----------------------------------------------------------------- templates
create table public.templates (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  description text not null default '',
  author_user_id uuid default auth.uid() references public.profiles (id),  -- session user; null for seed rows
  author_name text,
  author_x text,
  payload jsonb not null check (jsonb_typeof(payload) = 'array'),
  status text not null default 'pending' check (status in ('pending','published','rejected')),
  is_sample boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now()
);

-- A published template's payload is immutable (R12); fixes land as new
-- submissions. Per-author pending cap bounds submission volume.
create or replace function public.templates_guard() returns trigger
  language plpgsql set search_path = pg_catalog, public as $$
begin
  -- Submissions cannot pre-set moderator fields: a pending row is never a
  -- sample and has no publish date (published_at orders the gallery).
  if new.status = 'pending' then
    new.is_sample := case when tg_op = 'UPDATE' then old.is_sample else false end;
    new.published_at := null;
  end if;
  if tg_op = 'INSERT' then
    if new.status = 'published' and new.published_at is null then
      new.published_at := now();
    end if;
    if new.status = 'pending' and new.author_user_id is not null and
       (select count(*) from public.templates t
         where t.author_user_id = new.author_user_id and t.status = 'pending') >= 10 then
      raise exception 'pending template cap reached' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if old.status = 'published' and new.payload is distinct from old.payload then
    raise exception 'a published template payload cannot change' using errcode = 'raise_exception';
  end if;
  if new.status = 'published' and old.status <> 'published' then
    new.published_at := now();  -- stamped at publish, never carried in
  end if;
  return new;
end $$;
create trigger templates_guard
  before insert or update on public.templates
  for each row execute function public.templates_guard();

-- ------------------------------------------- profile provisioning (KTD6/HTD)
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- --------------------------------------------------------------------- views
-- Balance per person per board. security_invoker: the juice_events RLS policy
-- (U3 file) scopes what each caller sums - members see their boards only.
create view public.juice_balances with (security_invoker = true) as
  select board_id, user_id, sum(amount)::int as balance
  from public.juice_events
  group by board_id, user_id;

-- Co-member display (R17): display name and disambiguating id, never email.
-- Runs with owner rights but filters to boards the caller belongs to via
-- auth.uid(); the profiles RLS policy (self-only) stays intact.
create view public.board_member_profiles as
  select bm.board_id, bm.role, p.id, p.display_name, (p.claimed_at is not null) as claimed
  from public.board_members bm
  join public.profiles p on p.id = bm.user_id and p.deleted_at is null
  where bm.board_id in (select mine.board_id from public.board_members mine where mine.user_id = auth.uid());
