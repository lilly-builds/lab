-- Count all stored element rows, not only live ones. Editors may insert a row
-- with deleted_at already set through PostgREST, and ordinary delete/create
-- churn also accumulates tombstones until the 30-day purge. Keep the existing
-- 2,000-live-element limit and bound retained rows to 4,000 per board.
alter table public.boards
  add column stored_element_count int not null default 0 check (stored_element_count >= 0);

update public.boards b set stored_element_count = (
  select count(*) from public.board_elements e where e.board_id = b.id
);

create or replace function public.board_elements_count() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_live int; v_stored int;
begin
  if tg_op = 'INSERT' then
    update public.boards set
      element_count = element_count + case when new.deleted_at is null then 1 else 0 end,
      stored_element_count = stored_element_count + 1
    where id = new.board_id
    returning element_count, stored_element_count into v_live, v_stored;
    if v_live > 2000 then
      raise exception 'board element cap reached' using errcode = 'check_violation';
    end if;
    if v_stored > 4000 then
      raise exception 'board storage cap reached' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    update public.boards set
      element_count = element_count - case when old.deleted_at is null then 1 else 0 end,
      stored_element_count = stored_element_count - 1
    where id = old.board_id;
    return old;
  end if;

  if old.deleted_at is null and new.deleted_at is not null then
    update public.boards set element_count = element_count - 1 where id = new.board_id;
  elsif old.deleted_at is not null and new.deleted_at is null then
    update public.boards set element_count = element_count + 1 where id = new.board_id
      returning element_count into v_live;
    if v_live > 2000 then
      raise exception 'board element cap reached' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger board_elements_count on public.board_elements;
create trigger board_elements_count
  after insert or update or delete on public.board_elements
  for each row execute function public.board_elements_count();

-- A lost import response is retried with the same persisted client key. Lock
-- that key before checking for an existing board so simultaneous retries wait
-- for the winner and then return its committed board, not a unique-key error.
create or replace function public.import_board(p_scene jsonb, p_import_key text, p_juice_balance int default 0)
  returns uuid
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_uid uuid := auth.uid();
  v_board uuid;
  v_el jsonb;
  v_key text;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = 'insufficient_privilege'; end if;
  if p_import_key is null or p_import_key !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'invalid import_key' using errcode = 'invalid_parameter_value';
  end if;
  if p_scene is null or jsonb_typeof(p_scene) <> 'array' then
    raise exception 'scene must be a json array' using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_import_key, 0));
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
      continue;
    end if;
    -- The sync client remaps legacy e<n> ids before the request. Preserve its
    -- new key so a response-lost retry can reconcile edits by element id.
    -- Direct callers still get a fresh key for legacy or invalid ids.
    v_key := v_el->>'id';
    if v_key is null or v_key !~ '^[A-Za-z0-9_-]{1,64}$' or v_key ~ '^e[0-9]+$' then
      v_key := rtrim(translate(encode(public.app_random_bytes(12), 'base64'), '+/', '-_'), '=');
    end if;
    insert into public.board_elements (board_id, element_key, type, payload)
    values (
      v_board,
      v_key,
      v_el->>'type',
      v_el
    );
  end loop;

  if coalesce(p_juice_balance, 0) > 0 then
    insert into public.juice_events (board_id, user_id, note_key, reason, amount, idempotency_key)
    values (v_board, v_uid, null, 'imported_balance', p_juice_balance, 'import:' || p_import_key);
  end if;

  return v_board;
end $$;
revoke all on function public.import_board(jsonb, text, int) from public, anon;
grant execute on function public.import_board(jsonb, text, int) to authenticated;
