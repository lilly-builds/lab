-- AI Magic Toolbox, build plan steps 1.8 to 1.12 and 1.20: the database doors the server functions use.
-- Idempotent (create or replace, add column if not exists). Service role only, like the ledger functions.
-- The Edge Functions reach these tables only through functions, so one seam, rpc(name, args), runs the same calls
-- on hosted Supabase (supabase-js .rpc) and on a scratch Postgres in tests. No prompt or answer text is stored anywhere.

-- THIS SECTION IS FOR: columns the server needs. A ticket remembers the pick /route made; a usage row names its hold.
alter table public.route_tickets add column if not exists pick jsonb;
alter table public.ai_usage add column if not exists hold_id text;
alter table public.ai_usage add column if not exists finished_at timestamptz;
create index if not exists ai_usage_hold_i on public.ai_usage (hold_id);
create index if not exists ai_usage_person_i on public.ai_usage (person_id, created_at);

-- THIS SECTION IS FOR: outcome logging (step 1.20). A code and ids only, never text.
create table if not exists public.ai_outcomes (
  id bigint generated always as identity primary key,
  person_id uuid not null,
  ticket_id text,
  code text not null check (code in ('redo','undo','edit','delete','nextmove_tap')),
  created_at timestamptz not null default now()
);
alter table public.ai_outcomes enable row level security;
revoke all on table public.ai_outcomes from public, anon, authenticated;

-- THIS SECTION IS FOR: tester passes and their capped keys (step 1.8).
create or replace function public.ai_find_pass(p_hash text)
  returns table (id uuid, pass_hash text, disabled boolean, paused boolean)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select t.id, t.pass_hash, t.disabled, t.paused from public.tester_passes t where t.pass_hash = p_hash
$$;

create or replace function public.ai_create_pass(p_hash text, p_label text) returns uuid
  language sql security definer set search_path = pg_catalog, public as $$
  insert into public.tester_passes (pass_hash, label) values (p_hash, coalesce(p_label, '')) returning id
$$;

create or replace function public.ai_set_key(p_person uuid, p_key_hash text, p_key_enc text) returns void
  language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.tester_passes set key_hash = p_key_hash, key_enc = p_key_enc where id = p_person;
  if not found then raise exception 'unknown person'; end if;
end $$;

create or replace function public.ai_key_of(p_person uuid)
  returns table (key_hash text, key_enc text, disabled boolean)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select t.key_hash, t.key_enc, t.disabled from public.tester_passes t where t.id = p_person
$$;

-- Revoking disables the pass and returns the key's hash so the caller can disable the key at OpenRouter too.
create or replace function public.ai_revoke_pass(p_person uuid) returns text
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_hash text;
begin
  update public.tester_passes set disabled = true where id = p_person returning key_hash into v_hash;
  if not found then raise exception 'unknown person'; end if;
  return v_hash;
end $$;

-- A pause is reversible. Pausing writes one open flag for Lilly; unpausing resolves it.
create or replace function public.ai_set_paused(p_person uuid, p_paused boolean, p_cause text) returns void
  language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.tester_passes set paused = p_paused where id = p_person;
  if not found then raise exception 'unknown person'; end if;
  if p_paused then
    insert into public.ops_flags (cause, severity, person_id, detail)
      values ('paused:' || p_person, 'normal', p_person, jsonb_build_object('why', coalesce(p_cause, '')))
      on conflict do nothing;
  else
    update public.ops_flags set resolved_at = now() where cause = 'paused:' || p_person and resolved_at is null;
  end if;
end $$;

-- THIS SECTION IS FOR: route tickets (step 1.5). The ticket row is the server's memory of what /route decided.
create or replace function public.ai_store_ticket(p_id text, p_person uuid, p_ask_hash text, p_job text, p_pick jsonb,
                                                  p_expires_ms bigint, p_parent text default null) returns void
  language sql security definer set search_path = pg_catalog, public as $$
  insert into public.route_tickets (id, person_id, ask_hash, job, pick, parent_id, expires_at)
  values (p_id, p_person, p_ask_hash, p_job, p_pick, p_parent, to_timestamp(p_expires_ms / 1000.0))
$$;

create or replace function public.ai_get_ticket(p_id text)
  returns table (id text, person_id uuid, ask_hash text, job text, pick jsonb, parent_id text, attempts int, child_issued boolean)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select r.id, r.person_id, r.ask_hash, r.job, r.pick, r.parent_id, r.attempts, r.child_issued from public.route_tickets r where r.id = p_id
$$;

-- THIS SECTION IS FOR: rate limits (step 1.10). One counter row per key per window; returns the count after this hit.
create or replace function public.ai_rate_hit(p_key text, p_window_secs int) returns int
  language sql security definer set search_path = pg_catalog, public as $$
  insert into public.rate_counters as c (bucket_key, window_start, n)
  values (p_key, to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs), 1)
  on conflict (bucket_key, window_start) do update set n = c.n + 1
  returning n
$$;

-- THIS SECTION IS FOR: safety-gate blocks (step 1.9). Records one block, returns this person's block times in the window (epoch ms).
create or replace function public.ai_record_block(p_person uuid, p_window_secs int) returns bigint[]
  language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  insert into public.gate_blocks (person_id) values (p_person);
  return array(select (extract(epoch from b.created_at) * 1000)::bigint from public.gate_blocks b
               where b.person_id = p_person and b.created_at > now() - make_interval(secs => p_window_secs) order by b.created_at);
end $$;

-- THIS SECTION IS FOR: the first ask (step 1.16, DEFAULT: first ask ever). True until this person has one job call that came
-- back ok. Gate, router and next-move calls do not count.
create or replace function public.ai_first_ask(p_person uuid) returns boolean
  language sql stable security definer set search_path = pg_catalog, public as $$
  select not exists (select 1 from public.ai_usage u
                     where u.person_id = p_person and u.outcome = 'ok' and u.job not in ('gate', 'router', 'nextmoves'))
$$;

-- THIS SECTION IS FOR: usage rows (I3, I6), one per model call. Started before the call so a crash leaves a trace, "seen" when the
-- first chunk names its generation (what the cleanup job looks up), finished with the real cost and outcome.
create or replace function public.ai_usage_start(p_request text, p_hold text, p_person uuid, p_job text, p_attempt int) returns void
  language sql security definer set search_path = pg_catalog, public as $$
  insert into public.ai_usage (request_id, hold_id, person_id, job, attempt) values (p_request, p_hold, p_person, p_job, p_attempt)
  on conflict (request_id) do nothing
$$;

create or replace function public.ai_usage_seen(p_request text, p_generation text) returns void
  language sql security definer set search_path = pg_catalog, public as $$
  update public.ai_usage set generation_id = p_generation where request_id = p_request and generation_id is null
$$;

create or replace function public.ai_usage_finish(p_request text, p_generation text, p_model text, p_latency_ms int,
                                                  p_cost numeric, p_outcome text) returns void
  language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_outcome not in ('ok', 'error_before_start', 'cut_off', 'unreadable', 'unknown') then raise exception 'unknown outcome'; end if;
  update public.ai_usage set generation_id = coalesce(generation_id, p_generation), model = p_model, latency_ms = p_latency_ms,
    cost = p_cost, outcome = p_outcome, finished_at = now()
  where request_id = p_request;
end $$;

-- Per model: how many of its last p_last finished job calls failed (step 1.20, the router avoids models that fail too often).
create or replace function public.ai_model_failures(p_last int)
  returns table (model text, calls int, failures int)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select x.model, count(*)::int, count(*) filter (where x.outcome <> 'ok')::int
  from (select u.model, u.outcome, row_number() over (partition by u.model order by u.created_at desc) as rn
        from public.ai_usage u where u.model is not null and u.finished_at is not null and u.job not in ('gate', 'router')) x
  where x.rn <= p_last
  group by x.model
$$;

-- THIS SECTION IS FOR: flags for Lilly (I2). One open flag per cause. Returns true when this call wrote a new flag.
create or replace function public.ai_flag(p_cause text, p_severity text, p_person uuid, p_detail jsonb) returns boolean
  language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  insert into public.ops_flags (cause, severity, person_id, detail)
    values (p_cause, p_severity, p_person, coalesce(p_detail, '{}'::jsonb));
  return true;
exception when unique_violation then
  return false;
end $$;

-- THIS SECTION IS FOR: the cleanup job (step 1.12). Open holds older than the wait, each with the usage rows under it.
create or replace function public.ai_stale_holds(p_older_secs int)
  returns table (request_id text, person_id uuid, amount numeric, usage jsonb)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select h.request_id, h.person_id, h.amount,
         coalesce(jsonb_agg(jsonb_build_object('request_id', u.request_id, 'generation_id', u.generation_id, 'cost', u.cost,
                  'outcome', u.outcome) order by u.created_at) filter (where u.request_id is not null), '[]'::jsonb)
  from public.ai_holds h left join public.ai_usage u on u.hold_id = h.request_id
  where h.state = 'open' and h.created_at < now() - make_interval(secs => p_older_secs)
  group by h.request_id, h.person_id, h.amount
$$;

-- Spend settled in the window, in dollars (the daily spend alert).
create or replace function public.ai_spend_since(p_secs int) returns numeric
  language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(sum(amount), 0) from public.credit_ledger where reason = 'spend' and created_at > now() - make_interval(secs => p_secs)
$$;

-- Old rate windows and gate blocks are not needed after a day.
create or replace function public.ai_prune(p_older_secs int) returns void
  language sql security definer set search_path = pg_catalog, public as $$
  delete from public.rate_counters where window_start < now() - make_interval(secs => p_older_secs);
  delete from public.gate_blocks where created_at < now() - make_interval(secs => p_older_secs);
$$;

-- THIS SECTION IS FOR: the limit setter and its retry queue (step 1.8, I4).
create or replace function public.ai_ledger_rows(p_person uuid)
  returns table (id bigint, reason text, amount numeric)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select l.id, l.reason, l.amount from public.credit_ledger l where l.person_id = p_person order by l.id
$$;

-- One waiting retry per person is enough: a retry recomputes from the whole ledger.
create or replace function public.ai_limit_enqueue(p_person uuid) returns void
  language sql security definer set search_path = pg_catalog, public as $$
  insert into public.limit_updates (person_id)
  select p_person where not exists (select 1 from public.limit_updates q where q.person_id = p_person and not q.done)
$$;

create or replace function public.ai_limit_take_due(p_max int)
  returns table (id bigint, person_id uuid, attempts int)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select q.id, q.person_id, q.attempts from public.limit_updates q where not q.done and q.next_try <= now() order by q.next_try limit p_max
$$;

create or replace function public.ai_limit_done(p_id bigint) returns void
  language sql security definer set search_path = pg_catalog, public as $$
  update public.limit_updates set done = true where id = p_id
$$;

create or replace function public.ai_limit_failed(p_id bigint, p_next_ms bigint, p_attempts int) returns void
  language sql security definer set search_path = pg_catalog, public as $$
  update public.limit_updates set next_try = to_timestamp(p_next_ms / 1000.0), attempts = p_attempts where id = p_id
$$;

-- THIS SECTION IS FOR: the reconciler (step 1.12). Every person with a key, with their ledger rows, for the limit rule.
create or replace function public.ai_reconcile_rows()
  returns table (person_id uuid, key_hash text, disabled boolean, rows jsonb)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select t.id, t.key_hash, t.disabled,
         coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'reason', l.reason, 'amount', l.amount) order by l.id)
                   from public.credit_ledger l where l.person_id = t.id), '[]'::jsonb)
  from public.tester_passes t where t.key_hash is not null
$$;

-- THIS SECTION IS FOR: outcome logging (step 1.20).
create or replace function public.ai_record_outcome(p_person uuid, p_ticket text, p_code text) returns void
  language sql security definer set search_path = pg_catalog, public as $$
  insert into public.ai_outcomes (person_id, ticket_id, code) values (p_person, p_ticket, p_code)
$$;

-- THIS SECTION IS FOR: access. Every function above is for the server (service role) only.
do $$
declare f text;
begin
  foreach f in array array[
    'ai_find_pass(text)', 'ai_create_pass(text,text)', 'ai_set_key(uuid,text,text)', 'ai_key_of(uuid)', 'ai_revoke_pass(uuid)',
    'ai_set_paused(uuid,boolean,text)', 'ai_store_ticket(text,uuid,text,text,jsonb,bigint,text)', 'ai_get_ticket(text)',
    'ai_rate_hit(text,int)', 'ai_record_block(uuid,int)', 'ai_first_ask(uuid)', 'ai_usage_start(text,text,uuid,text,int)',
    'ai_usage_seen(text,text)', 'ai_usage_finish(text,text,text,int,numeric,text)', 'ai_model_failures(int)',
    'ai_flag(text,text,uuid,jsonb)', 'ai_stale_holds(int)', 'ai_spend_since(int)', 'ai_prune(int)', 'ai_ledger_rows(uuid)',
    'ai_limit_enqueue(uuid)', 'ai_limit_take_due(int)', 'ai_limit_done(bigint)', 'ai_limit_failed(bigint,bigint,int)',
    'ai_reconcile_rows()', 'ai_record_outcome(uuid,text,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
