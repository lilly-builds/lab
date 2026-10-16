-- Board Room publishing (#209): anyone can publish a template, no sign-in, no review.
-- Idempotent: safe to apply twice. Board-sync policies and grants are untouched;
-- the authenticated pending-submission path (templates_author_insert) stays as it was.
--
-- MODERATION: there is no unpublish UI. The Supabase dashboard is the moderation path:
-- set status = 'rejected' on a row (templates_read only shows published rows) or delete it.
-- Anonymous publishing is rate capped below (templates_anon_rate).

-- author_user_id is already nullable (default auth.uid(), null for anon and seed rows).

-- True only for a jsonb array whose every element is a jsonb object. A function because a
-- CHECK cannot hold a subquery; CASE keeps jsonb_array_elements away from non-arrays.
create or replace function public.jsonb_all_objects(j jsonb) returns boolean
  language sql immutable set search_path = pg_catalog as $$
  select case when jsonb_typeof(j) = 'array'
    then not exists (select 1 from jsonb_array_elements(j) e where jsonb_typeof(e) <> 'object')
    else false end
$$;

-- Field caps, enforced in the database as well as the dialog. Sample (seed) rows are
-- exempt and rows that predate this migration are not re-checked (NOT VALID still
-- guards every new insert and update). description = why (400) + 2 + love (400).
-- Title and author need at least one visible character: whitespace, zero-width, bidi
-- and invisible filler characters alone do not count.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'templates_caps' and conrelid = 'public.templates'::regclass) then
    alter table public.templates add constraint templates_caps check (
      is_sample or (
        char_length(btrim(title)) between 1 and 60
        and title ~ '[^[:space:]­͏ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ﻿ﾠ]'
        and char_length(description) <= 802
        and (author_name is null or (
          char_length(author_name) <= 40
          and author_name ~ '[^[:space:]­͏ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ﻿ﾠ]'
        ))
        and (author_x is null or author_x ~ '^[A-Za-z0-9_]{1,15}$')
        and slug ~ '^[a-z0-9-]{1,40}$'
      )
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'templates_payload_caps' and conrelid = 'public.templates'::regclass) then
    alter table public.templates add constraint templates_payload_caps check (
      is_sample or (
        jsonb_typeof(payload) = 'array'
        and jsonb_array_length(payload) <= 120
        and public.jsonb_all_objects(payload)
        and octet_length(payload::text) <= 600000
      )
    ) not valid;
  end if;
  -- The built-in template ids belong to the built-ins (the board resolves ?template=<id>
  -- from the database first), so nobody else can publish under them, whether or not the
  -- seed rows are present. A new built-in id needs a migration that extends this list.
  if not exists (select 1 from pg_constraint where conname = 'templates_reserved_slugs' and conrelid = 'public.templates'::regclass) then
    alter table public.templates add constraint templates_reserved_slugs check (
      is_sample or slug <> all (array[
        'dream-board','dreamspace-plan','idea-map','metro-map','our-week','friends-trip',
        'group-party','learn-in-a-month','save-for-it','side-project-weekend',
        'drop-shrink-handoff','make-one-chore-smaller','first-time-with-ai',
        'say-the-hard-thing','dev-tracks'
      ])
    ) not valid;
  end if;
end $$;

-- Gallery paging: newest published first, samples and community read separately.
create index if not exists templates_gallery_idx
  on public.templates (is_sample, published_at desc) where status = 'published';

-- Anonymous insert: published straight away, never a sample, never attributed to a
-- user. Column grants keep anon away from is_sample, published_at and author_user_id.
drop policy if exists templates_anon_publish on public.templates;
create policy templates_anon_publish on public.templates
  for insert to anon
  with check (
    status = 'published'
    and author_user_id is null
    and is_sample = false
  );

grant insert (slug, title, description, author_name, author_x, payload, status)
  on public.templates to anon;

-- Global rate cap on unattributed, non-sample inserts: at most 20 a minute and 300 an
-- hour across everyone. A simple floor against bulk spam, not per-person fairness; the
-- caps are the numbers to change here. Security definer so the count sees every row.
create index if not exists templates_anon_recent_idx
  on public.templates (created_at) where author_user_id is null and not is_sample;

create or replace function public.templates_anon_rate() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if new.author_user_id is null and not new.is_sample then
    if (select count(*) from public.templates t
         where t.author_user_id is null and not t.is_sample
           and t.created_at > now() - interval '1 minute') >= 20
       or (select count(*) from public.templates t
         where t.author_user_id is null and not t.is_sample
           and t.created_at > now() - interval '1 hour') >= 300 then
      raise exception 'publish rate limit' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists templates_anon_rate on public.templates;
create trigger templates_anon_rate
  before insert on public.templates
  for each row execute function public.templates_anon_rate();
