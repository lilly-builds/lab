-- Board Room publishing (#209): anyone can publish a template, no sign-in, no review.
-- Idempotent: safe to apply twice. Board-sync policies and grants are untouched;
-- the authenticated pending-submission path (templates_author_insert) stays as it was.

-- author_user_id is already nullable (default auth.uid(), null for anon and seed rows).

-- Field caps, enforced in the database as well as the dialog. Sample (seed) rows are
-- exempt and rows that predate this migration are not re-checked (NOT VALID still
-- guards every new insert and update). description = why (400) + 2 + love (400).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'templates_caps' and conrelid = 'public.templates'::regclass) then
    alter table public.templates add constraint templates_caps check (
      is_sample or (
        char_length(btrim(title)) between 1 and 60
        and char_length(description) <= 802
        and (author_name is null or char_length(author_name) <= 40)
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
        and octet_length(payload::text) <= 600000
      )
    ) not valid;
  end if;
end $$;

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
