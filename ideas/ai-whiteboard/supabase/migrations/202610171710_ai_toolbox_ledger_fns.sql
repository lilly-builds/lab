-- AI Magic Toolbox, build plan step 1.2: hold, settle, release, adjust, and atomic ticket attempts.
-- Idempotent (create or replace). Service role only. Invariants: I1 (never spend past the balance), I3 (one settle per request), I5 (two attempts).

-- THIS SECTION IS FOR: placing a hold. A per-person lock makes two holds that together exceed the balance impossible.
-- A request id names one hold for life: a retry while it is open is the same hold, but reusing the id of a settled or
-- released hold is refused. Otherwise a replayed id would run calls whose settle is a no-op, and they would cost nothing.
create or replace function public.ledger_place_hold(p_person uuid, p_request text, p_amount numeric) returns void
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_paused boolean; v_state text;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'hold must be positive'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_person::text, 0));
  select state into v_state from public.ai_holds where request_id = p_request;
  if found then
    if v_state = 'open' then return; end if; -- retry of the same request
    raise exception 'request already closed';
  end if;
  select paused or disabled into v_paused from public.tester_passes where id = p_person;
  if v_paused is null then raise exception 'unknown person'; end if;
  if v_paused then raise exception 'access paused'; end if;
  if public.ai_balance(p_person, true) < p_amount then raise exception 'insufficient balance'; end if;
  insert into public.ai_holds (request_id, person_id, amount) values (p_request, p_person, p_amount);
end $$;

-- THIS SECTION IS FOR: settling. Idempotent on request id. Real cost is always recorded, even past the hold (never hide money),
-- but then a high-severity flag is written and the person is paused until a human looks.
create or replace function public.ledger_settle(p_request text, p_cost numeric) returns void
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare h public.ai_holds;
begin
  if p_cost is null or p_cost < 0 then raise exception 'cost must be zero or more'; end if;
  select * into h from public.ai_holds where request_id = p_request for update;
  if not found then raise exception 'no hold for request'; end if;
  if h.state <> 'open' then return; end if;
  if p_cost > 0 then
    insert into public.credit_ledger (person_id, reason, bucket, amount, request_id, note)
      values (h.person_id, 'spend', 'paid', p_cost, p_request, 'settled call');
  end if;
  update public.ai_holds set state = 'settled', settled_cost = p_cost, closed_at = now() where request_id = p_request;
  if p_cost > h.amount then
    insert into public.ops_flags (cause, severity, person_id, detail)
      values ('settle_over_hold:' || p_request, 'high', h.person_id, jsonb_build_object('hold', h.amount, 'cost', p_cost))
      on conflict do nothing;
    update public.tester_passes set paused = true where id = h.person_id;
  end if;
end $$;

-- THIS SECTION IS FOR: releasing a hold that was never charged (error before the first chunk).
create or replace function public.ledger_release(p_request text) returns void
  language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.ai_holds set state = 'released', closed_at = now() where request_id = p_request and state = 'open';
end $$;

-- THIS SECTION IS FOR: Lilly's hand-entered grants. A retried call with the same key is not a second grant.
create or replace function public.ledger_adjust(p_person uuid, p_amount numeric, p_note text, p_idem text default null) returns void
  language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_amount is null or p_amount <= 0 then raise exception 'grant must be positive'; end if;
  if not exists (select 1 from public.tester_passes where id = p_person) then raise exception 'unknown person'; end if;
  insert into public.credit_ledger (person_id, reason, bucket, amount, note, idem_key)
    values (p_person, 'adjustment', 'paid', p_amount, coalesce(p_note, ''), p_idem)
    on conflict do nothing;
end $$;

-- THIS SECTION IS FOR: tickets. One UPDATE checks person, expiry and count and increments, so parallel calls cannot both pass.
-- Returns the attempt number taken (1 or 2), or null when refused.
create or replace function public.ticket_take_attempt(p_ticket text, p_person uuid) returns int
  language sql security definer set search_path = pg_catalog, public as $$
  update public.route_tickets set attempts = attempts + 1
  where id = p_ticket and person_id = p_person and expires_at > now() and attempts < 2
  returning attempts
$$;

-- A /run whose hold was refused (out of credit, paused) made no call, so it gives its attempt back: the person can try again once
-- the money is there (a cut-off attempt 1 keeps its hold until cleanup prices it). Only the newest attempt can be given back, by its
-- own person, once. Returns true when an attempt was given back.
create or replace function public.ticket_give_back_attempt(p_ticket text, p_person uuid, p_attempt int) returns boolean
  language sql security definer set search_path = pg_catalog, public as $$
  with u as (
    update public.route_tickets set attempts = attempts - 1
    where id = p_ticket and person_id = p_person and attempts = p_attempt and p_attempt > 0 returning 1)
  select exists (select 1 from u)
$$;

-- A build ticket may issue one nextmoves child, once. Returns true when this call won the child slot.
create or replace function public.ticket_take_child(p_ticket text, p_person uuid) returns boolean
  language sql security definer set search_path = pg_catalog, public as $$
  with u as (
    update public.route_tickets set child_issued = true
    where id = p_ticket and person_id = p_person and not child_issued returning 1)
  select exists (select 1 from u)
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'ledger_place_hold(uuid,text,numeric)', 'ledger_settle(text,numeric)', 'ledger_release(text)',
    'ledger_adjust(uuid,numeric,text,text)', 'ticket_take_attempt(text,uuid)', 'ticket_give_back_attempt(text,uuid,int)',
    'ticket_take_child(text,uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
