-- AI Magic Toolbox, build plan step 1.1: core tables and access rules.
-- Idempotent: safe to apply twice. Nothing here is readable or writable by the browser roles;
-- only the service role (our server functions) touches these tables. The one browser door is my_balance().
--
-- "Person" in phase 1 is the tester pass id. Phase 2 maps it to the signed-in user; person_id has no
-- foreign key to auth.users until then. Money is dollars, numeric(14,6). No prompt text is stored anywhere.

-- THIS SECTION IS FOR: tester passes. Only the SHA-256 hex of the private code is stored; the provider key is stored encrypted.
create table if not exists public.tester_passes (
  id uuid primary key default gen_random_uuid(),
  pass_hash text not null unique,
  label text not null default '',
  key_hash text,            -- OpenRouter's id for this person's capped key (not the key itself)
  key_enc text,             -- AES-GCM ciphertext of the key; never selectable by anon or authenticated
  disabled boolean not null default false,
  paused boolean not null default false,   -- reversible; set by the gate after repeated blocks
  created_at timestamptz not null default now()
);

-- THIS SECTION IS FOR: the ledger. Append-only, dollars, reasons match _shared/limit-rule.mjs plus 'spend' (settled calls).
create table if not exists public.credit_ledger (
  id bigint generated always as identity primary key,
  person_id uuid not null,
  reason text not null check (reason in
    ('paid','free','bonus','adjustment','refund','dispute','expire','refund_failed','dispute_restored','spend')),
  bucket text not null default 'paid' check (bucket in ('free','paid')),
  amount numeric(14,6) not null check (amount >= 0),
  note text not null default '',
  stripe_event_id text,
  invoice_id text,
  refund_id text,
  request_id text,           -- set on 'spend' rows: one settle per request
  idem_key text,             -- set on hand adjustments: a retried grant is not a second grant
  created_at timestamptz not null default now()
);
create unique index if not exists credit_ledger_stripe_event_u on public.credit_ledger (stripe_event_id) where stripe_event_id is not null;
create unique index if not exists credit_ledger_invoice_u on public.credit_ledger (invoice_id, reason) where invoice_id is not null;
create unique index if not exists credit_ledger_refund_u on public.credit_ledger (refund_id) where refund_id is not null;
create unique index if not exists credit_ledger_request_u on public.credit_ledger (request_id) where request_id is not null;
create unique index if not exists credit_ledger_idem_u on public.credit_ledger (idem_key) where idem_key is not null;
create index if not exists credit_ledger_person_i on public.credit_ledger (person_id);

create or replace function public.credit_ledger_append_only() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin raise exception 'credit_ledger is append-only'; end $$;
drop trigger if exists credit_ledger_no_change on public.credit_ledger;
create trigger credit_ledger_no_change before update or delete on public.credit_ledger
  for each row execute function public.credit_ledger_append_only();

-- THIS SECTION IS FOR: holds (reserved worst-case money for a call in flight). Settled or released exactly once.
create table if not exists public.ai_holds (
  request_id text primary key,
  person_id uuid not null,
  amount numeric(14,6) not null check (amount > 0),
  state text not null default 'open' check (state in ('open','settled','released')),
  settled_cost numeric(14,6),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists ai_holds_person_open_i on public.ai_holds (person_id) where state = 'open';

-- THIS SECTION IS FOR: usage records. Ids, model, timing, cost, outcome. Never prompt or answer text (I6).
create table if not exists public.ai_usage (
  request_id text primary key,
  person_id uuid not null,
  generation_id text,
  model text,
  job text not null,
  attempt int not null default 1,
  latency_ms int,
  cost numeric(14,6),
  outcome text,
  created_at timestamptz not null default now()
);

-- THIS SECTION IS FOR: route tickets (I5). Attempts are taken atomically by ticket_take_attempt.
create table if not exists public.route_tickets (
  id text primary key,
  person_id uuid not null,
  ask_hash text not null,
  job text,
  parent_id text,
  expires_at timestamptz not null,
  attempts int not null default 0 check (attempts between 0 and 2),
  child_issued boolean not null default false,
  created_at timestamptz not null default now()
);

-- THIS SECTION IS FOR: what needs Lilly's eyes. One open flag per cause, so a standing problem is not re-flagged daily.
create table if not exists public.ops_flags (
  id bigint generated always as identity primary key,
  cause text not null,
  severity text not null default 'normal' check (severity in ('normal','high')),
  person_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index if not exists ops_flags_open_cause_u on public.ops_flags (cause) where resolved_at is null;

create table if not exists public.gate_blocks (
  id bigint generated always as identity primary key,
  person_id uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists gate_blocks_person_i on public.gate_blocks (person_id, created_at);

-- THIS SECTION IS FOR: the retry queue for failed key-limit updates (step 1.8). A retry SETS the limit, never adds.
create table if not exists public.limit_updates (
  id bigint generated always as identity primary key,
  person_id uuid not null,
  attempts int not null default 0,
  next_try timestamptz not null default now(),
  done boolean not null default false,
  created_at timestamptz not null default now()
);

-- THIS SECTION IS FOR: rate counters (per person and per IP windows, step 1.10).
create table if not exists public.rate_counters (
  bucket_key text not null,
  window_start timestamptz not null,
  n int not null default 0,
  primary key (bucket_key, window_start)
);

-- THIS SECTION IS FOR: access. RLS on with no policies = no rows for anon or authenticated; grants removed as well.
do $$
declare t text;
begin
  foreach t in array array['tester_passes','credit_ledger','ai_holds','ai_usage','route_tickets',
                           'ops_flags','gate_blocks','limit_updates','rate_counters'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- THIS SECTION IS FOR: balance math, shared by my_balance and the hold function. Dollars: grants - deductions - spend - open holds.
create or replace function public.ai_balance(p_person uuid, p_include_holds boolean default true) returns numeric
  language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce((select sum(case
            when reason in ('paid','free','bonus','adjustment','refund_failed','dispute_restored') then amount
            else -amount end)
          from public.credit_ledger where person_id = p_person), 0)
       - case when p_include_holds
           then coalesce((select sum(amount) from public.ai_holds where person_id = p_person and state = 'open'), 0)
           else 0 end
$$;
revoke all on function public.ai_balance(uuid, boolean) from public, anon, authenticated;
grant execute on function public.ai_balance(uuid, boolean) to service_role;

-- THIS SECTION IS FOR: the browser's one door. The pass itself is the proof; a caller sees only the balance it belongs to.
create or replace function public.my_balance(p_pass text) returns numeric
  language sql stable security definer set search_path = pg_catalog, public as $$
  select public.ai_balance(p.id, true)
  from public.tester_passes p
  where p.pass_hash = encode(sha256(convert_to(p_pass, 'utf8')), 'hex') and not p.disabled
$$;
revoke all on function public.my_balance(text) from public;
grant execute on function public.my_balance(text) to anon, authenticated, service_role;
