-- U3: Authorization - RLS policies, security-definer RPCs, realtime channels.
-- Plan: plans/2026-10-12-2015-feat-dreamspace-server-database-plan.md (KTD6, R8, R9, R10, R17, R18, R5).

-- ------------------------------------------------- membership helpers (KTD6)
-- Security definer with pinned search_path: policies call these instead of
-- querying board_members directly, avoiding recursive policies.
create or replace function public.is_board_member(p_board uuid) returns boolean
  language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.board_members
                 where board_id = p_board and user_id = auth.uid())
$$;
create or replace function public.is_board_role(p_board uuid, p_role text) returns boolean
  language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.board_members
                 where board_id = p_board and user_id = auth.uid() and role = p_role)
$$;
create or replace function public.is_board_editor(p_board uuid) returns boolean
  language sql stable security definer set search_path = pg_catalog, public as $$
  select exists (select 1 from public.board_members
                 where board_id = p_board and user_id = auth.uid() and role in ('owner','editor'))
$$;

-- ------------------------------------------------------------- row security
alter table public.profiles enable row level security;
alter table public.boards enable row level security;
alter table public.board_elements enable row level security;
alter table public.board_members enable row level security;
alter table public.invites enable row level security;
alter table public.invite_accept_attempts enable row level security;
alter table public.juice_events enable row level security;
alter table public.templates enable row level security;

-- profiles: self-only (R17). Email changes go through claim_email, so clients
-- may update display_name only.
create policy profiles_self_select on public.profiles
  for select to authenticated using (id = auth.uid());
create policy profiles_self_update on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- boards: members read; owner updates title/archives. No client insert (boards
-- are created by import_board) and no delete (soft archive only).
create policy boards_member_select on public.boards
  for select to authenticated using (public.is_board_member(id));
create policy boards_owner_update on public.boards
  for update to authenticated
  using (public.is_board_role(id, 'owner')) with check (public.is_board_role(id, 'owner'));

-- board_elements: members read; owner+editor write; no hard delete (tombstones).
create policy board_elements_member_select on public.board_elements
  for select to authenticated using (public.is_board_member(board_id));
create policy board_elements_editor_insert on public.board_elements
  for insert to authenticated with check (public.is_board_editor(board_id));
create policy board_elements_editor_update on public.board_elements
  for update to authenticated
  using (public.is_board_editor(board_id)) with check (public.is_board_editor(board_id));

-- board_members: co-members read; owner changes roles and removes members.
-- Owner-row protections live in the pin trigger; inserts come from RPCs only.
create policy board_members_member_select on public.board_members
  for select to authenticated using (public.is_board_member(board_id));
create policy board_members_owner_update on public.board_members
  for update to authenticated
  using (public.is_board_role(board_id, 'owner')) with check (public.is_board_role(board_id, 'owner'));
create policy board_members_owner_delete on public.board_members
  for delete to authenticated using (public.is_board_role(board_id, 'owner'));

-- invites: the board owner creates, reads, and revokes. Token holders never
-- read invite rows; they redeem through accept_invite.
create policy invites_owner_select on public.invites
  for select to authenticated using (public.is_board_role(board_id, 'owner'));
create policy invites_owner_insert on public.invites
  for insert to authenticated
  with check (public.is_board_role(board_id, 'owner') and created_by = auth.uid());
create policy invites_owner_update on public.invites
  for update to authenticated
  using (public.is_board_role(board_id, 'owner')) with check (public.is_board_role(board_id, 'owner'));

-- invite_accept_attempts: written only by accept_invite (security definer).
-- No client policies: deny all.

-- juice_events: members read their boards' ledger; writes only via earn_juice
-- and import_board (KTD3).
create policy juice_events_member_select on public.juice_events
  for select to authenticated using (public.is_board_member(board_id));

-- templates: published is world-readable including signed-out visitors (R12);
-- authors see and edit their own pending rows only.
create policy templates_read on public.templates
  for select to anon, authenticated
  using (status = 'published' or author_user_id = auth.uid());
create policy templates_author_insert on public.templates
  for insert to authenticated
  with check (author_user_id = auth.uid() and status = 'pending');
create policy templates_author_update on public.templates
  for update to authenticated
  using (author_user_id = auth.uid() and status = 'pending')
  with check (author_user_id = auth.uid() and status = 'pending');

-- ------------------------------------------------------------------- grants
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.boards to authenticated;
grant update (title, archived_at) on public.boards to authenticated;
grant select on public.board_elements to authenticated;
grant insert, update on public.board_elements to authenticated;
grant select on public.board_members to authenticated;
grant update, delete on public.board_members to authenticated;
grant select on public.invites to authenticated;
grant insert, update on public.invites to authenticated;
grant select on public.juice_events to authenticated;
grant select on public.templates to anon, authenticated;
grant insert, update on public.templates to authenticated;
grant select on public.juice_balances to authenticated;
grant select on public.board_member_profiles to authenticated;

-- ============================================================== import_board
-- First-sync import (R7): creates board + owner membership + element rows +
-- imported_balance event in one transaction; dedupes on import_key so a raced
-- import from two devices returns the same board instead of duplicating.
create or replace function public.import_board(p_scene jsonb, p_import_key text, p_juice_balance int default 0)
  returns uuid
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_uid uuid := auth.uid();
  v_board uuid;
  v_el jsonb;
  v_count int := 0;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = 'insufficient_privilege'; end if;
  if p_import_key is null or p_import_key !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'invalid import_key' using errcode = 'invalid_parameter_value';
  end if;
  if p_scene is null or jsonb_typeof(p_scene) <> 'array' then
    raise exception 'scene must be a json array' using errcode = 'invalid_parameter_value';
  end if;

  -- raced import: an existing board with this key is returned, never duplicated
  select id into v_board from public.boards where import_key = p_import_key;
  if found then
    if (select owner_id from public.boards where id = v_board) <> v_uid then
      raise exception 'import_key belongs to another account' using errcode = 'insufficient_privilege';
    end if;
    return v_board;
  end if;

  if (select count(*) from public.boards where owner_id = v_uid and archived_at is null) >= 50 then
    raise exception 'board quota reached' using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_scene) > 2000 then
    raise exception 'board element cap reached' using errcode = 'check_violation';
  end if;

  insert into public.boards (owner_id, import_key) values (v_uid, p_import_key) returning id into v_board;
  insert into public.board_members (board_id, user_id, role) values (v_board, v_uid, 'owner');

  for v_el in select value from jsonb_array_elements(p_scene) loop
    if jsonb_typeof(v_el) <> 'object' or v_el->>'type' is null then
      raise exception 'malformed element in scene' using errcode = 'invalid_parameter_value';
    end if;
    if v_el->>'type' = 'embed' and v_el->>'kind' = 'app' then
      continue;  -- built apps never travel (U4): dropped, not an error
    end if;
    insert into public.board_elements (board_id, element_key, type, payload)
    values (
      v_board,
      -- collision-resistant key for every imported element (adoptBoard's e<n>
      -- counter resets are what would mint collisions on synced boards)
      rtrim(translate(encode(public.app_random_bytes(12), 'base64'), '+/', '-_'), '='),
      v_el->>'type',
      v_el
    );
    v_count := v_count + 1;
  end loop;

  if coalesce(p_juice_balance, 0) > 0 then
    insert into public.juice_events (board_id, user_id, note_key, reason, amount, idempotency_key)
    values (v_board, v_uid, null, 'imported_balance', p_juice_balance, 'import:' || p_import_key);
  end if;

  return v_board;
end $$;
revoke all on function public.import_board(jsonb, text, int) from public;
grant execute on function public.import_board(jsonb, text, int) to authenticated;

-- ============================================================ upsert_elements
-- CAS batch write (KTD2). Each element: {element_key, base_version, type?,
-- payload?, deleted?}. base_version 0/null means create. Returns one row per
-- element: status ok | conflict | rejected. A tombstoned row always beats an
-- upsert: writes to it come back as conflicts so the client re-pulls.
create or replace function public.upsert_elements(p_board_id uuid, p_elements jsonb)
  returns table (element_key text, version int, status text)
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_uid uuid := auth.uid();
  v_el jsonb;
  v_key text;
  v_base int;
  v_ver int;
  v_tomb boolean;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = 'insufficient_privilege'; end if;
  if not public.is_board_editor(p_board_id) then
    raise exception 'not a board editor' using errcode = 'insufficient_privilege';
  end if;
  if p_elements is null or jsonb_typeof(p_elements) <> 'array' then
    raise exception 'elements must be a json array' using errcode = 'invalid_parameter_value';
  end if;

  for v_el in select value from jsonb_array_elements(p_elements) loop
    v_key := v_el->>'element_key';
    v_base := coalesce((v_el->>'base_version')::int, 0);
    if v_key is null or v_key !~ '^[A-Za-z0-9_-]{1,64}$' or jsonb_typeof(v_el) <> 'object' then
      element_key := coalesce(v_key, ''); version := null; status := 'rejected'; return next; continue;
    end if;
    if (v_el ? 'payload') and (
         jsonb_typeof(v_el->'payload') <> 'object'
         or octet_length((v_el->'payload')::text) > 65536
         or (v_el->'payload')::text ~* 'data:[a-z0-9.+-]+/[a-z0-9.+-]+') then
      element_key := v_key; version := null; status := 'rejected'; return next; continue;
    end if;

    if v_base <= 0 then
      -- create path
      if not (v_el ? 'type') then
        element_key := v_key; version := null; status := 'rejected'; return next; continue;
      end if;
      begin
        insert into public.board_elements (board_id, element_key, type, payload)
        values (p_board_id, v_key, v_el->>'type', coalesce(v_el->'payload', '{}'::jsonb))
        returning board_elements.version into v_ver;
        element_key := v_key; version := v_ver; status := 'ok'; return next;
      exception
        when unique_violation then
          element_key := v_key; version := null; status := 'conflict'; return next;
        when check_violation then
          element_key := v_key; version := null; status := 'rejected'; return next;
      end;
      continue;
    end if;

    -- CAS update path
    select e.version, e.deleted_at is not null into v_ver, v_tomb
      from public.board_elements e where e.board_id = p_board_id and e.element_key = v_key;
    if not found then
      element_key := v_key; version := null; status := 'conflict'; return next; continue;
    end if;
    if v_tomb then
      -- tombstone wins: an undelete or edit against a deleted row conflicts
      if coalesce((v_el->>'deleted')::boolean, false) then
        element_key := v_key; version := v_ver; status := 'ok'; return next;  -- delete of deleted: no-op
      end if;
      element_key := v_key; version := null; status := 'conflict'; return next; continue;
    end if;

    begin
      update public.board_elements e set
        payload = case when v_el ? 'payload' then v_el->'payload' else e.payload end,
        deleted_at = case
          when not (v_el ? 'deleted') then e.deleted_at
          when (v_el->>'deleted')::boolean then now()
          else null end
      where e.board_id = p_board_id and e.element_key = v_key and e.version = v_base
      returning e.version into v_ver;
    exception when check_violation then
      -- a table CHECK (e.g. payload bounds) rejects this op, not the batch
      element_key := v_key; version := null; status := 'rejected'; return next; continue;
    end;
    if found then
      element_key := v_key; version := v_ver; status := 'ok'; return next;
    else
      element_key := v_key; version := null; status := 'conflict'; return next;
    end if;
  end loop;
  return;
end $$;
revoke all on function public.upsert_elements(uuid, jsonb) from public;
grant execute on function public.upsert_elements(uuid, jsonb) to authenticated;

-- ================================================================ earn_juice
-- Server-derived juice (KTD3, R10, AE4): the loop and amount come from the
-- note's actual position inside the labelled circle ellipses, never from the
-- client. Idempotent on idempotency_key and one-earn-per-note.
create or replace function public.earn_juice(p_board_id uuid, p_note_key text, p_idempotency_key text)
  returns table (event_id bigint, reason text, amount int, already_earned boolean)
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_uid uuid := auth.uid();
  v_note record;
  v_labels text[] := array['dream', 'want to do', 'have to do'];
  v_reasons text[] := array['dream_completed', 'want_to_completed', 'have_to_completed'];
  v_amounts int[] := array[10, 2, 1];
  v_i int;
  v_circle record;
  v_nx float8; v_ny float8; v_dx float8; v_dy float8;
  v_reason text; v_amount int;
  v_event bigint;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = 'insufficient_privilege'; end if;
  if not public.is_board_editor(p_board_id) then
    raise exception 'not a board editor' using errcode = 'insufficient_privilege';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 or length(p_idempotency_key) > 128 then
    raise exception 'invalid idempotency_key' using errcode = 'invalid_parameter_value';
  end if;

  -- replay: the same key returns the original event (AE4)
  select je.id, je.reason, je.amount into v_event, v_reason, v_amount
    from public.juice_events je where je.idempotency_key = p_idempotency_key;
  if found then
    event_id := v_event; reason := v_reason; amount := v_amount; already_earned := true; return next; return;
  end if;

  select e.payload into v_note from public.board_elements e
    where e.board_id = p_board_id and e.element_key = p_note_key and e.type = 'note' and e.deleted_at is null;
  if not found then
    raise exception 'note not found' using errcode = 'no_data_found';
  end if;
  if coalesce((v_note.payload->>'l1Done')::boolean, false) is not true then
    raise exception 'note is not completed' using errcode = 'raise_exception';
  end if;

  v_nx := (v_note.payload->>'x')::float8 + (v_note.payload->>'w')::float8 / 2;
  v_ny := (v_note.payload->>'y')::float8 + (v_note.payload->>'h')::float8 / 2;

  -- which circle the note sits in: mirror of the client's circleOf (dream,
  -- then want to do, then have to do). A circle is the ellipse nearest under
  -- the text label sitting on its top edge.
  v_reason := null;
  for v_i in 1..3 loop
    select c.payload into v_circle
    from public.board_elements t
    join public.board_elements c
      on c.board_id = t.board_id and c.deleted_at is null and c.type = 'ellipse'
     and (c.payload->>'w')::float8 > 0 and (c.payload->>'h')::float8 > 0
     and ((t.payload->>'x')::float8 + (t.payload->>'w')::float8 / 2)
         between (c.payload->>'x')::float8 and (c.payload->>'x')::float8 + (c.payload->>'w')::float8
     and abs(((t.payload->>'y')::float8 + coalesce((t.payload->>'size')::float8, 24) / 2) - (c.payload->>'y')::float8)
         <= (c.payload->>'h')::float8 * 0.3
    where t.board_id = p_board_id and t.deleted_at is null and t.type = 'text'
      and lower(btrim(t.payload->>'text')) = v_labels[v_i]
    order by abs(((t.payload->>'y')::float8 + coalesce((t.payload->>'size')::float8, 24) / 2) - (c.payload->>'y')::float8)
           + abs((t.payload->>'x')::float8 + (t.payload->>'w')::float8 / 2 - ((c.payload->>'x')::float8 + (c.payload->>'w')::float8 / 2))
    limit 1;
    if found then
      v_dx := (v_nx - ((v_circle.payload->>'x')::float8 + (v_circle.payload->>'w')::float8 / 2)) / ((v_circle.payload->>'w')::float8 / 2);
      v_dy := (v_ny - ((v_circle.payload->>'y')::float8 + (v_circle.payload->>'h')::float8 / 2)) / ((v_circle.payload->>'h')::float8 / 2);
      if v_dx * v_dx + v_dy * v_dy <= 1 then
        v_reason := v_reasons[v_i]; v_amount := v_amounts[v_i];
        exit;
      end if;
    end if;
  end loop;

  if v_reason is null then
    raise exception 'note is not in any circle' using errcode = 'raise_exception';
  end if;

  begin
    insert into public.juice_events (board_id, user_id, note_key, reason, amount, idempotency_key)
    values (p_board_id, v_uid, p_note_key, v_reason, v_amount, p_idempotency_key)
    returning id into v_event;
  exception
    when unique_violation then
      -- the note already earned (any circle) or the key raced; return the truth
      select je.id, je.reason, je.amount into v_event, v_reason, v_amount
        from public.juice_events je
        where je.board_id = p_board_id and je.note_key = p_note_key and je.reason <> 'imported_balance'
      limit 1;
      event_id := v_event; reason := v_reason; amount := v_amount; already_earned := true; return next; return;
  end;

  -- earned flag, same transaction (KTD3); the integrity trigger bumps version
  update public.board_elements e
    set payload = e.payload || '{"l1Earned":true}'::jsonb
    where e.board_id = p_board_id and e.element_key = p_note_key;

  event_id := v_event; reason := v_reason; amount := v_amount; already_earned := false; return next; return;
end $$;
revoke all on function public.earn_juice(uuid, text, text) from public;
grant execute on function public.earn_juice(uuid, text, text) to authenticated;

-- ============================================================== accept_invite
-- Single-use invite redemption (R8). Throttled per user via
-- invite_accept_attempts; token entropy makes guessing impractical.
-- Invalid tokens RETURN error = 'invalid_invite' rather than raising: the
-- attempt row must persist, and an exception would roll its own recording
-- back. Only precondition failures (auth, malformed input) raise.
create or replace function public.accept_invite(p_token text)
  returns table (board_id uuid, role text, error text)
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_uid uuid := auth.uid();
  v_inv record;
  v_fails int;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = 'insufficient_privilege'; end if;
  if p_token is null or length(p_token) < 16 or length(p_token) > 128 then
    raise exception 'invalid_invite' using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_fails from public.invite_accept_attempts
    where user_id = v_uid and not succeeded and created_at > now() - interval '1 hour';
  if v_fails >= 10 then
    board_id := null; role := null; error := 'too_many_attempts'; return next; return;
  end if;

  select * into v_inv from public.invites where token = p_token for update;
  if not found or v_inv.revoked_at is not null
     or (v_inv.expires_at is not null and v_inv.expires_at <= now())
     or (v_inv.accepted_by is not null and v_inv.accepted_by <> v_uid) then
    insert into public.invite_accept_attempts (token_attempted, user_id, succeeded)
    values (left(p_token, 128), v_uid, false);
    board_id := null; role := null; error := 'invalid_invite'; return next; return;
  end if;

  insert into public.board_members (board_id, user_id, role)
  values (v_inv.board_id, v_uid, v_inv.role)
  on conflict on constraint board_members_pkey do nothing;  -- already a member: keep the existing role

  if v_inv.accepted_by is null then
    update public.invites set accepted_by = v_uid, accepted_at = now() where id = v_inv.id;
  end if;

  insert into public.invite_accept_attempts (token_attempted, user_id, succeeded)
  values (left(p_token, 128), v_uid, true);

  board_id := v_inv.board_id; role := v_inv.role; error := null; return next; return;
end $$;
revoke all on function public.accept_invite(text) from public;
grant execute on function public.accept_invite(text) to authenticated;

-- =============================================================== claim_email
-- Identity claim (R1, R3): magic-link confirm lands the email on the profile.
-- The claimed email must match the authenticated session's own email claim.
create or replace function public.claim_email(p_display_name text)
  returns void
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_uid uuid := auth.uid();
  v_email citext := (auth.jwt() ->> 'email')::citext;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = 'insufficient_privilege'; end if;
  if v_email is null then
    raise exception 'session has no verified email' using errcode = 'insufficient_privilege';
  end if;
  if p_display_name is null or btrim(p_display_name) = '' then
    raise exception 'display name required' using errcode = 'invalid_parameter_value';
  end if;
  update public.profiles
    set email = v_email, display_name = btrim(p_display_name), claimed_at = coalesce(claimed_at, now())
    where id = v_uid;
end $$;
revoke all on function public.claim_email(text) from public;
grant execute on function public.claim_email(text) to authenticated;

-- ================================================================== realtime
-- Postgres changes for both sync tables (R5). Table RLS scopes delivery to
-- members. Guarded so the migration also applies on a scratch Postgres.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'board_elements') then
      alter publication supabase_realtime add table public.board_elements;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'juice_events') then
      alter publication supabase_realtime add table public.juice_events;
    end if;
  end if;
end $$;

-- Private per-board broadcast channels (KTD6; presence/cursors later). Topic
-- convention: board:<board_id>. Policies only - never ALTER realtime.messages.
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'realtime' and tablename = 'messages') then
    if not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'board_channel_read') then
      create policy board_channel_read on realtime.messages for select to authenticated
        using (exists (select 1 from public.board_members bm
                 where bm.user_id = auth.uid()
                   and bm.board_id::text = split_part(realtime.messages.topic, ':', 2)));
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'board_channel_write') then
      create policy board_channel_write on realtime.messages for insert to authenticated
        with check (exists (select 1 from public.board_members bm
                 where bm.user_id = auth.uid()
                   and bm.board_id::text = split_part(realtime.messages.topic, ':', 2)));
    end if;
  end if;
end $$;
