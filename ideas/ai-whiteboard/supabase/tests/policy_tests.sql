-- U2/U3 verification: schema constraints, RLS policies, RPC semantics.
-- Runs against a local Supabase stack via psql, or a scratch Postgres that
-- mirrors Supabase (anon/authenticated roles, Supabase's default ALL grants on
-- public, auth.uid()/auth.jwt() reading request.jwt.claims). Sessions are set
-- through request.jwt.claims, the same setting PostgREST uses, so the suite
-- exercises the real auth functions. Assertion log lands in test_results.
create temp table test_results (ord serial, name text, ok boolean, detail text);
create or replace function pg_temp.log(p_name text, p_ok boolean, p_detail text default '')
  returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin insert into pg_temp.test_results(name, ok, detail) values (p_name, coalesce(p_ok,false), p_detail); end $$;
create or replace function pg_temp.ok(p_name text, p_cond boolean, p_detail text default '')
  returns void language plpgsql set search_path = pg_catalog, pg_temp as $$
begin perform pg_temp.log(p_name, p_cond, p_detail); end $$;
create or replace function pg_temp.throws(p_name text, p_sql text, p_pattern text default '')
  returns void language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  execute p_sql;
  perform pg_temp.log(p_name, false, 'no error raised');
exception when others then
  perform pg_temp.log(p_name, p_pattern = '' or sqlerrm ~ p_pattern, sqlerrm);
end $$;

-- ------------------------------------------------------------ test accounts
select set_config('request.jwt.claims', '', false);
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'editor@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'viewer@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'stranger@example.com');
select pg_temp.ok('auth.users insert provisions profiles',
  (select count(*) from public.profiles) = 4);

create temp table ctx (k text primary key, v text);
grant all on pg_temp.ctx to authenticated, anon;
grant select on pg_temp.test_results to authenticated, anon;

-- ------------------------------------------------------- fixture import (A)
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false);
insert into ctx values ('board', public.import_board('[
  {"id":"e1","type":"ellipse","x":0,"y":0,"w":200,"h":200},
  {"id":"e2","type":"text","x":0,"y":-51,"w":280,"size":24,"text":"Dream"},
  {"id":"e3","type":"ellipse","x":300,"y":0,"w":200,"h":200},
  {"id":"e4","type":"text","x":300,"y":-51,"w":280,"size":24,"text":"want to do"},
  {"id":"e5","type":"ellipse","x":600,"y":0,"w":200,"h":200},
  {"id":"e6","type":"text","x":600,"y":-51,"w":280,"size":24,"text":"have to do"},
  {"id":"e7","type":"note","x":90,"y":90,"w":20,"h":20,"text":"dream note","l1Done":true},
  {"id":"e8","type":"note","x":390,"y":90,"w":20,"h":20,"text":"want note","l1Done":true},
  {"id":"e9","type":"note","x":690,"y":90,"w":20,"h":20,"text":"have note","l1Done":true},
  {"id":"e10","type":"note","x":1000,"y":1000,"w":20,"h":20,"text":"outside","l1Done":true},
  {"id":"e11","type":"note","x":80,"y":80,"w":20,"h":20,"text":"not done","l1Done":false},
  {"id":"e12","type":"embed","kind":"app","url":"https://x.example","html":"<p>local only</p>"}
]'::jsonb, 'import-test-key-0001', 7)::text);
select pg_temp.ok('import_board returns a board id', (select v from ctx where k='board') ~ '^[0-9a-f-]{36}$');
select pg_temp.ok('import remaps to collision-resistant keys and drops app embeds',
  (select count(*) from public.board_elements where board_id = (select v from ctx where k='board')::uuid) = 11
  and (select count(*) from public.board_elements where board_id = (select v from ctx where k='board')::uuid and element_key ~ '^e[0-9]+$') = 0
  and (select count(*) from public.board_elements where board_id = (select v from ctx where k='board')::uuid and type='embed') = 0);
select pg_temp.ok('owner membership row exists',
  (select role from public.board_members where board_id=(select v from ctx where k='board')::uuid and user_id='11111111-1111-1111-1111-111111111111') = 'owner');
select pg_temp.ok('imported_balance backfill fires at board creation',
  (select amount from public.juice_events where board_id=(select v from ctx where k='board')::uuid and reason='imported_balance') = 7);
select pg_temp.ok('element_count maintained on import',
  (select element_count from public.boards where id=(select v from ctx where k='board')::uuid) = 11);
select pg_temp.ok('stored_element_count includes every imported row',
  (select stored_element_count from public.boards where id=(select v from ctx where k='board')::uuid) = 11);

-- stash the remapped element keys for later tests
insert into ctx select 'key_' || (payload->>'text'), element_key from public.board_elements
  where board_id = (select v from ctx where k='board')::uuid and type = 'note';

-- raced import dedupes on import_key (R7)
insert into ctx values ('board_again', public.import_board('[]'::jsonb, 'import-test-key-0001', 0)::text);
select pg_temp.ok('raced import returns the same board',
  (select v from ctx where k='board_again') = (select v from ctx where k='board'));
select pg_temp.ok('raced import did not duplicate elements',
  (select element_count from public.boards where id=(select v from ctx where k='board')::uuid) = 11);

-- another account cannot claim the same import key
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', false);
select pg_temp.throws('import_key of another account is rejected',
  $$select public.import_board('[]'::jsonb, 'import-test-key-0001', 0)$$, 'another account');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false);

-- malformed element rolls back the whole import
select pg_temp.throws('import with one malformed element fails',
  $$select public.import_board('[{"id":"a","type":"note","x":0,"y":0,"w":1,"h":1},{"id":"b","type":"widget"}]'::jsonb, 'import-test-key-0002', 0)$$);
select pg_temp.ok('failed import left no board behind',
  (select count(*) from public.boards where import_key='import-test-key-0002') = 0);
insert into ctx values ('client_key_board', public.import_board(
  '[{"id":"client_Key_47Ab","type":"note","text":"stable"}]'::jsonb,
  'import-test-key-client', 0)::text);
select pg_temp.ok('import preserves a collision-resistant client key for response-lost retry',
  (select count(*) from public.board_elements
    where board_id=(select v from ctx where k='client_key_board')::uuid
      and element_key='client_Key_47Ab') = 1);

-- ------------------------------------------------------- U2 constraint tests
reset role;
select pg_temp.throws('mismatched reason and amount rejected by CHECK',
  $$insert into public.juice_events (board_id, user_id, note_key, reason, amount, idempotency_key)
    values ((select v from ctx where k='board')::uuid, '11111111-1111-1111-1111-111111111111', 'n1', 'dream_completed', 1, 'k-mismatch')$$);
select pg_temp.throws('duplicate idempotency_key rejected',
  $$insert into public.juice_events (board_id, user_id, reason, amount, idempotency_key)
    values ((select v from ctx where k='board')::uuid, '11111111-1111-1111-1111-111111111111', 'imported_balance', 1, 'import:import-test-key-0001')$$);
select pg_temp.throws('oversized payload rejected',
  $$insert into public.board_elements (board_id, element_key, type, payload)
    values ((select v from ctx where k='board')::uuid, 'big1', 'note', jsonb_build_object('text', repeat('x', 70000)))$$);
select pg_temp.throws('data: URL payload rejected',
  $$insert into public.board_elements (board_id, element_key, type, payload)
    values ((select v from ctx where k='board')::uuid, 'big2', 'image', '{"url":"data:image/png;base64,AAAA"}'::jsonb)$$);
select pg_temp.throws('unknown element type rejected',
  $$insert into public.board_elements (board_id, element_key, type, payload)
    values ((select v from ctx where k='board')::uuid, 'big3', 'widget', '{}'::jsonb)$$);
select pg_temp.throws('element-count cap rejects the element past the limit',
  $$insert into public.board_elements (board_id, element_key, type, payload)
    select (select v from ctx where k='board')::uuid, 'cap' || g, 'note', '{}'::jsonb from generate_series(1, 2000) g$$,
  'cap');
select pg_temp.ok('cap failure left element_count unchanged',
  (select element_count from public.boards where id=(select v from ctx where k='board')::uuid) = 11);

-- trigger-set integrity fields override client-supplied values
select set_config('request.jwt.claims', '', false);
insert into public.board_elements (board_id, element_key, type, payload, version, updated_by, updated_at)
  values ((select v from ctx where k='board')::uuid, 'trig1', 'note', '{}'::jsonb, 99, '44444444-4444-4444-4444-444444444444', '2001-01-01');
select pg_temp.ok('client-supplied version/updated_by/updated_at overridden by triggers',
  (select version = 1 and updated_by is null and updated_at > '2020-01-01'
     from public.board_elements where board_id=(select v from ctx where k='board')::uuid and element_key='trig1'));
delete from public.board_elements where board_id=(select v from ctx where k='board')::uuid and element_key='trig1';
select pg_temp.ok('hard delete releases total-row capacity',
  (select stored_element_count from public.boards where id=(select v from ctx where k='board')::uuid) = 11);

-- ------------------------------------------- memberships: invites and joins
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false);
insert into public.invites (board_id, created_by, role) values ((select v from ctx where k='board')::uuid, '11111111-1111-1111-1111-111111111111', 'editor');
insert into ctx values ('invite_editor', (select token from public.invites where board_id=(select v from ctx where k='board')::uuid and role='editor' order by created_at desc limit 1));
insert into public.invites (board_id, created_by, role) values ((select v from ctx where k='board')::uuid, '11111111-1111-1111-1111-111111111111', 'viewer');
insert into ctx values ('invite_viewer', (select token from public.invites where board_id=(select v from ctx where k='board')::uuid and role='viewer' order by created_at desc limit 1));
insert into public.invites (board_id, created_by, role, expires_at) values ((select v from ctx where k='board')::uuid, '11111111-1111-1111-1111-111111111111', 'editor', now() - interval '1 hour');
insert into ctx values ('invite_expired', (select token from public.invites where board_id=(select v from ctx where k='board')::uuid and expires_at is not null limit 1));
insert into public.invites (board_id, created_by, role) values ((select v from ctx where k='board')::uuid, '11111111-1111-1111-1111-111111111111', 'editor');
insert into ctx values ('invite_throttle', (select token from public.invites where board_id=(select v from ctx where k='board')::uuid and role='editor' and accepted_by is null and expires_at is null order by created_at desc limit 1));
insert into public.invites (board_id, created_by, role, revoked_at) values ((select v from ctx where k='board')::uuid, '11111111-1111-1111-1111-111111111111', 'editor', now());
insert into ctx values ('invite_revoked', (select token from public.invites where board_id=(select v from ctx where k='board')::uuid and revoked_at is not null order by created_at desc limit 1));
insert into public.invites (board_id, role) values ((select v from ctx where k='board')::uuid, 'viewer');  -- team.js insert shape
select pg_temp.ok('an invite sent without created_by is stamped with the session user',
  (select created_by from public.invites where board_id=(select v from ctx where k='board')::uuid order by created_at desc limit 1) = '11111111-1111-1111-1111-111111111111');
select pg_temp.ok('invite tokens are >=128-bit url-safe',
  (select min(length(token)) from public.invites) >= 22 and (select bool_and(token ~ '^[A-Za-z0-9_-]+$') from public.invites));

select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', false);
insert into ctx values ('join_board', (select board_id::text from public.accept_invite((select v from ctx where k='invite_editor'))));
select pg_temp.ok('accept_invite lands the member on the shared board',
  (select v from ctx where k='join_board') = (select v from ctx where k='board'));
select pg_temp.ok('member role comes from the invite',
  (select role from public.board_members where board_id=(select v from ctx where k='board')::uuid and user_id='22222222-2222-2222-2222-222222222222') = 'editor');
select pg_temp.ok('re-accept by the same person is idempotent',
  (select error is null from public.accept_invite((select v from ctx where k='invite_editor'))));

select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', false);
insert into ctx values ('viewer_accept', (select row_to_json(r)::text from public.accept_invite((select v from ctx where k='invite_viewer')) r));
select pg_temp.ok('viewer invite accepted',
  (select coalesce((v::jsonb ->> 'error'), '') = '' from ctx where k='viewer_accept')
  and (select role from public.board_members where board_id=(select v from ctx where k='board')::uuid and user_id='33333333-3333-3333-3333-333333333333') = 'viewer',
  (select v from ctx where k='viewer_accept'));

-- stranger: used, expired, revoked tokens all fail and record attempts
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', false);
select pg_temp.ok('single-use token rejected for a second person',
  (select error from public.accept_invite((select v from ctx where k='invite_editor'))) = 'invalid_invite');
select pg_temp.ok('expired token rejected',
  (select error from public.accept_invite((select v from ctx where k='invite_expired'))) = 'invalid_invite');
select pg_temp.ok('revoked token rejected',
  (select error from public.accept_invite((select v from ctx where k='invite_revoked'))) = 'invalid_invite');
reset role;
select pg_temp.ok('failed attempts are recorded despite returning an error',
  (select count(*) from public.invite_accept_attempts where user_id='44444444-4444-4444-4444-444444444444' and not succeeded) = 3);
set role authenticated;
-- burn 7 more failures, then even a valid token is throttled
select pg_temp.ok('bad token guesses fail',
  (select count(*) from (select (public.accept_invite('bad-token-00000000000000' || g)).error e from generate_series(1,7) g) t where t.e = 'invalid_invite') = 7);
select pg_temp.ok('repeated failed attempts are throttled',
  (select error from public.accept_invite((select v from ctx where k='invite_throttle'))) = 'too_many_attempts');

-- ---------------------------------------------------------------- RLS reads
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', false);
select pg_temp.ok('stranger reads no board rows',
  (select count(*) from public.board_elements where board_id=(select v from ctx where k='board')::uuid) = 0
  and (select count(*) from public.boards where id=(select v from ctx where k='board')::uuid) = 0
  and (select count(*) from public.juice_events where board_id=(select v from ctx where k='board')::uuid) = 0
  and (select count(*) from public.board_members where board_id=(select v from ctx where k='board')::uuid) = 0);
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', false);
select pg_temp.ok('member reads board rows',
  (select count(*) from public.board_elements where board_id=(select v from ctx where k='board')::uuid) = 11
  and (select count(*) from public.boards where id=(select v from ctx where k='board')::uuid) = 1);
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', false);
select pg_temp.ok('viewer reads board rows',
  (select count(*) from public.board_elements where board_id=(select v from ctx where k='board')::uuid) = 11);

-- ------------------------------------------------------- R17 profile privacy
select pg_temp.ok('co-members see display names and disambiguator ids, not emails',
  (select count(*) from public.board_member_profiles where board_id=(select v from ctx where k='board')::uuid) = 3
  and (select count(*) from information_schema.columns where table_schema='public' and table_name='board_member_profiles' and column_name='email') = 0);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', false);
select pg_temp.ok('stranger sees no member profiles',
  (select count(*) from public.board_member_profiles) = 0);
select pg_temp.ok('stranger cannot read a profile row',
  (select count(*) from public.profiles where id='11111111-1111-1111-1111-111111111111') = 0);

-- ------------------------------------------------------ role change pinning
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', false);
update public.board_members set role='viewer' where board_id=(select v from ctx where k='board')::uuid and user_id='33333333-3333-3333-3333-333333333333';
select pg_temp.ok('role change by a non-owner silently matches nothing',
  (select role from public.board_members where board_id=(select v from ctx where k='board')::uuid and user_id='33333333-3333-3333-3333-333333333333') = 'viewer');
update public.board_members set role='owner' where board_id=(select v from ctx where k='board')::uuid and user_id='22222222-2222-2222-2222-222222222222';
select pg_temp.ok('self-promotion to owner blocked',
  (select role from public.board_members where board_id=(select v from ctx where k='board')::uuid and user_id='22222222-2222-2222-2222-222222222222') = 'editor');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false);
select pg_temp.throws('owner row cannot be demoted',
  $$update public.board_members set role='editor' where board_id=(select v from ctx where k='board')::uuid and user_id='11111111-1111-1111-1111-111111111111'$$,
  'demoted');
select pg_temp.throws('owner row cannot be deleted',
  $$delete from public.board_members where board_id=(select v from ctx where k='board')::uuid and user_id='11111111-1111-1111-1111-111111111111'$$,
  'removed');
select pg_temp.throws('ownership cannot be granted by an owner update',
  $$update public.board_members set role='owner' where board_id=(select v from ctx where k='board')::uuid and user_id='22222222-2222-2222-2222-222222222222'$$,
  'granted');
update public.board_members set role='viewer' where board_id=(select v from ctx where k='board')::uuid and user_id='22222222-2222-2222-2222-222222222222';
select pg_temp.ok('owner can change a member role',
  (select role from public.board_members where board_id=(select v from ctx where k='board')::uuid and user_id='22222222-2222-2222-2222-222222222222') = 'viewer');
update public.board_members set role='editor' where board_id=(select v from ctx where k='board')::uuid and user_id='22222222-2222-2222-2222-222222222222';
reset role;
select pg_temp.throws('board owner_id is immutable',
  $$update public.boards set owner_id='22222222-2222-2222-2222-222222222222' where id=(select v from ctx where k='board')::uuid$$,
  'transferred');
set role authenticated;

-- ------------------------------------------------------ viewer cannot write
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', false);
select pg_temp.throws('viewer element insert rejected (AE7)',
  $$insert into public.board_elements (board_id, element_key, type, payload)
    values ((select v from ctx where k='board')::uuid, 'vw1', 'note', '{}'::jsonb)$$,
  'row-level security');
update public.board_elements set payload = '{"x":1}'::jsonb
  where board_id=(select v from ctx where k='board')::uuid and element_key=(select v from ctx where k='key_dream note');
select pg_temp.ok('viewer element update matches nothing',
  (select payload->>'x' is distinct from '1' from public.board_elements
    where board_id=(select v from ctx where k='board')::uuid and element_key=(select v from ctx where k='key_dream note')));
select pg_temp.throws('viewer cannot call upsert_elements (AE7)',
  $$select public.upsert_elements((select v from ctx where k='board')::uuid, '[{"element_key":"vw2","base_version":0,"type":"note"}]'::jsonb)$$,
  'not a board editor');
select pg_temp.throws('viewer cannot call earn_juice',
  $$select public.earn_juice((select v from ctx where k='board')::uuid, (select v from ctx where k='key_dream note'), 'viewer-earn-0001')$$,
  'not a board editor');
select pg_temp.throws('member cannot insert a ledger row directly',
  $$insert into public.juice_events (board_id, user_id, note_key, reason, amount, idempotency_key)
    values ((select v from ctx where k='board')::uuid, '33333333-3333-3333-3333-333333333333', 'x', 'dream_completed', 10, 'direct-insert-1')$$,
  'permission denied|row-level security');

-- a removed member's old single-use link is dead, not a way back in
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false);
delete from public.board_members where board_id=(select v from ctx where k='board')::uuid and user_id='33333333-3333-3333-3333-333333333333';
select pg_temp.ok('owner removes a member',
  (select count(*) from public.board_members where board_id=(select v from ctx where k='board')::uuid and user_id='33333333-3333-3333-3333-333333333333') = 0);
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', false);
select pg_temp.ok('a removed member cannot rejoin with their old invite link',
  (select error from public.accept_invite((select v from ctx where k='invite_viewer'))) = 'invalid_invite');
reset role;
select pg_temp.ok('the removed member stays removed',
  (select count(*) from public.board_members where board_id=(select v from ctx where k='board')::uuid and user_id='33333333-3333-3333-3333-333333333333') = 0);
set role authenticated;

-- ---------------------------------------------------------------- earn_juice
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false);
insert into ctx values ('earn1', (select row_to_json(r)::text from (select * from public.earn_juice((select v from ctx where k='board')::uuid, (select v from ctx where k='key_dream note'), 'earn-key-0001')) r));
select pg_temp.ok('earn derives dream circle and 10 from the note position, not the client',
  (select v from ctx where k='earn1')::jsonb ->> 'reason' = 'dream_completed'
  and ((select v from ctx where k='earn1')::jsonb ->> 'amount')::int = 10
  and ((select v from ctx where k='earn1')::jsonb ->> 'already_earned')::boolean = false);
select pg_temp.ok('replayed idempotency key returns the original event (AE4)',
  (select r.event_id = ((select v from ctx where k='earn1')::jsonb ->> 'event_id')::bigint
     and r.already_earned
   from public.earn_juice((select v from ctx where k='board')::uuid,
                          (select v from ctx where k='key_dream note'), 'earn-key-0001') r));
select pg_temp.ok('a second completion call for the same note earns nothing new (AE4)',
  (select r.already_earned and r.amount = 10
    from public.earn_juice((select v from ctx where k='board')::uuid, (select v from ctx where k='key_dream note'), 'earn-key-0002') r));
select pg_temp.ok('exactly one completion event exists for the note',
  (select count(*) from public.juice_events where board_id=(select v from ctx where k='board')::uuid and note_key=(select v from ctx where k='key_dream note')) = 1);
select pg_temp.ok('earned flag written on the note payload',
  (select coalesce((payload->>'l1Earned')::boolean, false) from public.board_elements
    where board_id=(select v from ctx where k='board')::uuid and element_key=(select v from ctx where k='key_dream note')));
select pg_temp.ok('want-to earn derives 2',
  (select r.amount = 2 and r.reason = 'want_to_completed'
    from public.earn_juice((select v from ctx where k='board')::uuid, (select v from ctx where k='key_want note'), 'earn-key-0003') r));
select pg_temp.ok('have-to earn derives 1',
  (select r.amount = 1 and r.reason = 'have_to_completed'
    from public.earn_juice((select v from ctx where k='board')::uuid, (select v from ctx where k='key_have note'), 'earn-key-0004') r));
select pg_temp.throws('earn without l1Done fails',
  $$select public.earn_juice((select v from ctx where k='board')::uuid, (select v from ctx where k='key_not done'), 'earn-key-0005')$$,
  'not completed');
select pg_temp.throws('earn outside every circle fails',
  $$select public.earn_juice((select v from ctx where k='board')::uuid, (select v from ctx where k='key_outside'), 'earn-key-0006')$$,
  'not in any circle');
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', false);
select pg_temp.throws('earn as non-member fails',
  $$select public.earn_juice((select v from ctx where k='board')::uuid, (select v from ctx where k='key_want note'), 'earn-key-0007')$$,
  'not a board editor');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false);
select pg_temp.ok('balance equals the ledger sum (7 imported + 10 + 2 + 1)',
  (select balance from public.juice_balances where board_id=(select v from ctx where k='board')::uuid and user_id='11111111-1111-1111-1111-111111111111') = 20);

-- ------------------------------------------------------------- upsert_elements
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', false);
select pg_temp.ok('editor creates an element at version 1',
  (select r.status = 'ok' and r.version = 1 from public.upsert_elements((select v from ctx where k='board')::uuid,
    '[{"element_key":"u1","base_version":0,"type":"note","payload":{"x":1,"y":1,"w":10,"h":10,"text":"hi"}}]'::jsonb) r));
select pg_temp.ok('CAS update with the right base version succeeds',
  (select r.status = 'ok' and r.version = 2 from public.upsert_elements((select v from ctx where k='board')::uuid,
    '[{"element_key":"u1","base_version":1,"payload":{"x":2,"y":1,"w":10,"h":10,"text":"hi"}}]'::jsonb) r));
select pg_temp.ok('stale base version is rejected (AE7)',
  (select r.status = 'conflict' from public.upsert_elements((select v from ctx where k='board')::uuid,
    '[{"element_key":"u1","base_version":1,"payload":{"x":3}}]'::jsonb) r));
select pg_temp.ok('create against an existing key conflicts',
  (select r.status = 'conflict' from public.upsert_elements((select v from ctx where k='board')::uuid,
    '[{"element_key":"u1","base_version":0,"type":"note","payload":{}}]'::jsonb) r));
insert into ctx values ('del1', (select row_to_json(r)::text from public.upsert_elements((select v from ctx where k='board')::uuid,
    '[{"element_key":"u1","base_version":2,"deleted":true}]'::jsonb) r));
select pg_temp.ok('delete tombstones with CAS',
  (select (v::jsonb ->> 'status') = 'ok' from ctx where k='del1')
  and (select deleted_at is not null from public.board_elements where board_id=(select v from ctx where k='board')::uuid and element_key='u1'),
  (select v from ctx where k='del1'));
select pg_temp.ok('tombstone wins: edits to a deleted row conflict',
  (select r.status = 'conflict' from public.upsert_elements((select v from ctx where k='board')::uuid,
    '[{"element_key":"u1","base_version":3,"payload":{"x":9}}]'::jsonb) r));
select pg_temp.ok('re-deleting a tombstone is a no-op ok',
  (select r.status = 'ok' from public.upsert_elements((select v from ctx where k='board')::uuid,
    '[{"element_key":"u1","base_version":3,"deleted":true}]'::jsonb) r));
select pg_temp.ok('oversized, data: URL, and malformed-key elements are rejected per-element',
  (select count(*) from public.upsert_elements((select v from ctx where k='board')::uuid,
    (('[{"element_key":"bad1","base_version":0,"type":"note","payload":{"text":"' || repeat('x', 70000) || '"}},'
      || '{"element_key":"bad2","base_version":0,"type":"image","payload":{"url":"data:image/png;base64,AA"}},'
      || '{"element_key":"bad key!","base_version":0,"type":"note","payload":{}},'
      || '{"element_key":"bad3","base_version":0,"payload":{}}]')::jsonb)) r where r.status = 'rejected') = 4);
select pg_temp.ok('element_count tracks live rows after create and tombstone',
  (select element_count from public.boards where id=(select v from ctx where k='board')::uuid) = 11);
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', false);
select pg_temp.throws('stranger cannot call upsert_elements',
  $$select public.upsert_elements((select v from ctx where k='board')::uuid, '[{"element_key":"st1","base_version":0,"type":"note"}]'::jsonb)$$,
  'not a board editor');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', false);
select pg_temp.ok('re-deleting a tombstone answers exactly once',
  (select count(*) from public.upsert_elements((select v from ctx where k='board')::uuid,
    '[{"element_key":"u1","base_version":3,"deleted":true}]'::jsonb)) = 1);

-- ------------------------------ direct writes under Supabase's default grants
-- Supabase grants ALL on every new public table to anon and authenticated.
-- These hold only because the migration revokes that first, so the column
-- grants bind, and because the element counter runs with owner rights.
insert into public.board_elements (board_id, element_key, type, payload)
  values ((select v from ctx where k='board')::uuid, 'ed1', 'note', '{}'::jsonb);
select pg_temp.ok('editor direct insert is counted (the cap cannot be dodged by skipping the RPC)',
  (select element_count from public.boards where id=(select v from ctx where k='board')::uuid) = 12);
update public.board_elements set deleted_at = now()
  where board_id=(select v from ctx where k='board')::uuid and element_key='ed1';
select pg_temp.ok('editor direct tombstone is counted',
  (select element_count from public.boards where id=(select v from ctx where k='board')::uuid) = 11);
insert into public.board_elements (board_id, element_key, type, payload, deleted_at)
  values ((select v from ctx where k='board')::uuid, 'predeleted1', 'note', '{}'::jsonb, now());
select pg_temp.ok('pre-deleted direct insert still consumes storage capacity',
  (select stored_element_count from public.boards where id=(select v from ctx where k='board')::uuid) = 14);
select pg_temp.throws('editor bulk direct insert past the cap is rejected',
  $$insert into public.board_elements (board_id, element_key, type, payload)
    select (select v from ctx where k='board')::uuid, 'edcap' || g, 'note', '{}'::jsonb from generate_series(1, 2000) g$$,
  'cap');
select pg_temp.ok('the editor cap failure left element_count unchanged',
  (select element_count from public.boards where id=(select v from ctx where k='board')::uuid) = 11);
reset role;
update public.boards set stored_element_count = 4000 where id=(select v from ctx where k='board')::uuid;
set role authenticated;
select pg_temp.throws('editor cannot insert past the total-row cap, even with a tombstone',
  $$insert into public.board_elements (board_id, element_key, type, payload, deleted_at)
    values ((select v from ctx where k='board')::uuid, 'predeleted2', 'note', '{}'::jsonb, now())$$, 'storage cap');
reset role;
update public.boards set stored_element_count =
  (select count(*) from public.board_elements where board_id=(select v from ctx where k='board')::uuid)
  where id=(select v from ctx where k='board')::uuid;
set role authenticated;
select pg_temp.throws('editor cannot move an element to another key or board',
  $$update public.board_elements set element_key='moved1'
    where board_id=(select v from ctx where k='board')::uuid and element_key=(select v from ctx where k='key_want note')$$,
  'permission denied');
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false);
select pg_temp.throws('owner cannot rewrite element_count directly',
  $$update public.boards set element_count = 0 where id=(select v from ctx where k='board')::uuid$$,
  'permission denied');
select pg_temp.throws('owner cannot rewrite stored_element_count directly',
  $$update public.boards set stored_element_count = 0 where id=(select v from ctx where k='board')::uuid$$,
  'permission denied');
select pg_temp.throws('owner cannot hand their owner row to another person',
  $$update public.board_members set user_id='44444444-4444-4444-4444-444444444444'
    where board_id=(select v from ctx where k='board')::uuid and user_id='11111111-1111-1111-1111-111111111111'$$,
  'permission denied');
select pg_temp.throws('owner cannot move a member row onto another person',
  $$update public.board_members set user_id='44444444-4444-4444-4444-444444444444'
    where board_id=(select v from ctx where k='board')::uuid and user_id='22222222-2222-2222-2222-222222222222'$$,
  'permission denied');
reset role;
select pg_temp.throws('membership rows cannot be moved even with table rights',
  $$update public.board_members set user_id='44444444-4444-4444-4444-444444444444'
    where board_id=(select v from ctx where k='board')::uuid and user_id='22222222-2222-2222-2222-222222222222'$$,
  'cannot be moved');
select pg_temp.throws('elements cannot be moved even with table rights',
  $$update public.board_elements set element_key='moved1'
    where board_id=(select v from ctx where k='board')::uuid and element_key=(select v from ctx where k='key_want note')$$,
  'cannot be moved');
set role authenticated;

-- --------------------------------------------------------------- claim_email
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', false);
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","email":"editor@example.com"}', false);
select public.claim_email('Ed');
select pg_temp.ok('claim sets email, display name, claimed_at from the session jwt',
  (select email = 'editor@example.com' and display_name = 'Ed' and claimed_at is not null
    from public.profiles where id = '22222222-2222-2222-2222-222222222222'));
select pg_temp.ok('claim keeps the same user id, so memberships and juice follow (R3)',
  (select role from public.board_members where board_id=(select v from ctx where k='board')::uuid and user_id='22222222-2222-2222-2222-222222222222') = 'editor');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', false);
select pg_temp.throws('claim without a verified session email fails',
  $$select public.claim_email('X')$$, 'no verified email');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","email":""}', false);
select pg_temp.throws('claim with a blank session email fails (anonymous sessions carry "")',
  $$select public.claim_email('X')$$, 'no verified email');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","email":"editor@example.com","is_anonymous":true}', false);
select pg_temp.throws('claim from an anonymous session fails',
  $$select public.claim_email('X')$$, 'no verified email');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","email":"editor@example.com"}', false);
select pg_temp.throws('clients cannot set the email column directly',
  $$update public.profiles set email='other@example.com' where id='22222222-2222-2222-2222-222222222222'$$,
  'permission denied');
select pg_temp.throws('clients cannot set claimed_at directly',
  $$update public.profiles set claimed_at=now() where id='22222222-2222-2222-2222-222222222222'$$,
  'permission denied');
update public.profiles set display_name='Ed direct' where id='22222222-2222-2222-2222-222222222222';
select pg_temp.ok('clients can still set their own display name directly',
  (select display_name from public.profiles where id='22222222-2222-2222-2222-222222222222') = 'Ed direct');
select public.claim_email('Eddie');
select pg_temp.ok('display name updates through the claim path',
  (select display_name from public.profiles where id='22222222-2222-2222-2222-222222222222') = 'Eddie');
select pg_temp.ok('a member reads their own profile including email',
  (select email from public.profiles where id='22222222-2222-2222-2222-222222222222') = 'editor@example.com');
select pg_temp.ok('a member cannot read another profile row',
  (select count(*) from public.profiles where id='11111111-1111-1111-1111-111111111111') = 0);

-- ----------------------------------------------------------------- templates
select set_config('request.jwt.claims', '', false);
set role anon;
select pg_temp.ok('signed-out visitor sees no unpublished templates',
  (select count(*) from public.templates where status <> 'published') = 0);
select pg_temp.throws('signed-out visitors cannot call the write RPCs',
  $$select public.import_board('[]'::jsonb, 'anon-import-0001', 0)$$, 'permission denied');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', false);
insert into public.templates (slug, title, author_user_id, author_name, payload)
  values ('t-one', 'First', '22222222-2222-2222-2222-222222222222', 'Eddie', '[]'::jsonb);
select pg_temp.ok('submission lands pending with author attribution',
  (select status from public.templates where slug='t-one') = 'pending');
select pg_temp.ok('author sees their pending row',
  (select count(*) from public.templates where slug='t-one') = 1);
insert into public.templates (slug, title, description, author_name, author_x, payload, status)
  values ('t-app', 'App shape', '', 'Eddie', null, '[{"type":"note"}]'::jsonb, 'pending');  -- templates.js insert shape
select pg_temp.ok('a submission sent without author_user_id is stamped with the session user',
  (select author_user_id from public.templates where slug='t-app') = '22222222-2222-2222-2222-222222222222');
insert into public.templates (slug, title, author_name, payload, status, is_sample, published_at)
  values ('t-preset', 'Preset', 'Eddie', '[{"type":"note"}]'::jsonb, 'pending', true, '1970-01-01');
select pg_temp.ok('a submission cannot pre-set the sample flag or publish date',
  (select not is_sample and published_at is null from public.templates where slug='t-preset'));
reset role;
update public.templates set status='published' where slug='t-preset';
select pg_temp.ok('publishing stamps the publish date at publish time',
  (select published_at > now() - interval '1 minute' from public.templates where slug='t-preset'));
delete from public.templates where slug in ('t-app', 't-preset');  -- keep the pending-cap count below exact
set role authenticated;
select set_config('request.jwt.claims', '', false);
set role anon;
select pg_temp.ok('pending row hidden from signed-out visitors (AE5)',
  (select count(*) from public.templates where slug='t-one') = 0);
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', false);
select pg_temp.throws('author cannot publish their own row',
  $$update public.templates set status='published' where slug='t-one'$$,
  'row-level security');
update public.templates set payload='[{"type":"note"}]'::jsonb where slug='t-one';
select pg_temp.ok('author can still edit a pending payload',
  (select jsonb_array_length(payload) from public.templates where slug='t-one') = 1);
reset role;
update public.templates set status='published' where slug='t-one';  -- moderator via dashboard (service role)
select pg_temp.ok('moderated publish stamps published_at',
  (select published_at is not null and status='published' from public.templates where slug='t-one'));
select set_config('request.jwt.claims', '', false);
set role anon;
select pg_temp.ok('published row readable signed out (AE5)',
  (select title from public.templates where slug='t-one') = 'First');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', false);
update public.templates set payload='[]'::jsonb where slug='t-one';
select pg_temp.ok('author update on a published row matches nothing (AE5)',
  (select jsonb_array_length(payload) from public.templates where slug='t-one') = 1);
reset role;
select pg_temp.throws('published payload is immutable (trigger)',
  $$update public.templates set payload='[]'::jsonb where slug='t-one'$$);
set role authenticated;
insert into public.templates (slug, title, author_user_id, author_name, payload)
  select 'cap-' || g, 'T', '22222222-2222-2222-2222-222222222222', 'Eddie', '[]'::jsonb from generate_series(1, 10) g;
select pg_temp.throws('per-author pending cap rejects the one past the limit',
  $$insert into public.templates (slug, title, author_user_id, author_name, payload)
    values ('cap-11', 'T', '22222222-2222-2222-2222-222222222222', 'Eddie', '[]'::jsonb)$$,
  'cap');
reset role;

-- A board with one live element can retain 3,999 tombstones, but no more.
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', false);
insert into public.board_elements (board_id, element_key, type, payload, deleted_at)
  select (select v from ctx where k='client_key_board')::uuid, 'retained' || g,
    'note', '{}'::jsonb, now() from generate_series(1, 3999) g;
select pg_temp.ok('stored-row cap counts tombstones without lowering the live cap',
  (select stored_element_count = 4000 and element_count = 1 from public.boards
    where id=(select v from ctx where k='client_key_board')::uuid));
select pg_temp.throws('the 4,001st stored row is rejected',
  $$insert into public.board_elements (board_id, element_key, type, payload, deleted_at)
    values ((select v from ctx where k='client_key_board')::uuid, 'retained4000', 'note', '{}'::jsonb, now())$$,
  'storage cap');
reset role;

-- ------------------------------------------------------------ AI toolbox: access, ledger, holds, tickets (plan 1.1, 1.2)
insert into public.tester_passes (id, pass_hash, label) values
  ('aaaaaaaa-0000-0000-0000-000000000001', encode(sha256(convert_to('pass-one','utf8')),'hex'), 'one'),
  ('aaaaaaaa-0000-0000-0000-000000000002', encode(sha256(convert_to('pass-two','utf8')),'hex'), 'two');

-- browser roles see and write nothing in the AI tables
do $$
declare t text; r text;
begin
  foreach r in array array['anon','authenticated'] loop
    foreach t in array array['tester_passes','credit_ledger','ai_holds','ai_usage','route_tickets',
                             'ops_flags','gate_blocks','limit_updates','rate_counters'] loop
      perform pg_temp.ok(r || ' has no privilege on ' || t,
        not has_table_privilege(r, 'public.' || t, 'select,insert,update,delete'));
    end loop;
  end loop;
end $$;
select pg_temp.ok('anon cannot run the ledger functions',
  not has_function_privilege('anon', 'public.ledger_place_hold(uuid,text,numeric)', 'execute')
  and not has_function_privilege('authenticated', 'public.ledger_settle(text,numeric)', 'execute')
  and not has_function_privilege('anon', 'public.ledger_adjust(uuid,numeric,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.ticket_take_attempt(text,uuid)', 'execute'));

select public.ledger_adjust('aaaaaaaa-0000-0000-0000-000000000001', 10, 'grant', 'k1');
select public.ledger_adjust('aaaaaaaa-0000-0000-0000-000000000001', 10, 'grant again', 'k1');
select pg_temp.ok('a retried grant with the same key is one grant',
  public.ai_balance('aaaaaaaa-0000-0000-0000-000000000001', false) = 10);

select pg_temp.throws('the ledger rejects update', $$update public.credit_ledger set amount = 99$$, 'append-only');
select pg_temp.throws('the ledger rejects delete', $$delete from public.credit_ledger$$, 'append-only');
select pg_temp.throws('duplicate stripe_event_id is rejected',
  $$insert into public.credit_ledger (person_id, reason, amount, stripe_event_id) select 'aaaaaaaa-0000-0000-0000-000000000002','paid',1,'evt_1' from generate_series(1,2)$$,
  'duplicate key');
select pg_temp.throws('duplicate refund_id is rejected',
  $$insert into public.credit_ledger (person_id, reason, amount, refund_id) select 'aaaaaaaa-0000-0000-0000-000000000002','refund',1,'re_1' from generate_series(1,2)$$,
  'duplicate key');

-- my_balance: only the pass holder's number
set role anon;
select pg_temp.ok('my_balance returns the caller''s own number', public.my_balance('pass-one') = 10);
select pg_temp.ok('my_balance with another pass returns that person''s number only', public.my_balance('pass-two') = 0);
select pg_temp.ok('my_balance with a wrong pass returns nothing', public.my_balance('nope') is null);
reset role;

-- holds: the second hold that would pass the balance fails; same request id twice is one hold
select public.ledger_place_hold('aaaaaaaa-0000-0000-0000-000000000001', 'r1', 6);
select public.ledger_place_hold('aaaaaaaa-0000-0000-0000-000000000001', 'r1', 6);
select pg_temp.ok('a retried hold is one hold',
  (select count(*) from public.ai_holds where request_id = 'r1') = 1);
select pg_temp.throws('a second hold past the balance fails',
  $$select public.ledger_place_hold('aaaaaaaa-0000-0000-0000-000000000001', 'r2', 5)$$, 'insufficient');
select pg_temp.throws('a hold for a person with no balance fails',
  $$select public.ledger_place_hold('aaaaaaaa-0000-0000-0000-000000000002', 'r3', 1)$$, 'insufficient');

-- settle: once only, real cost recorded
select public.ledger_settle('r1', 2.5);
select public.ledger_settle('r1', 2.5);
select pg_temp.ok('settling twice writes one spend row',
  (select count(*) from public.credit_ledger where request_id = 'r1') = 1);
select pg_temp.ok('balance is grants minus spend after settle',
  public.ai_balance('aaaaaaaa-0000-0000-0000-000000000001', true) = 7.5);

-- release returns the held amount
select public.ledger_place_hold('aaaaaaaa-0000-0000-0000-000000000001', 'r4', 7);
select pg_temp.ok('an open hold lowers the available balance',
  public.ai_balance('aaaaaaaa-0000-0000-0000-000000000001', true) = 0.5);
select public.ledger_release('r4');
select pg_temp.ok('release gives the amount back',
  public.ai_balance('aaaaaaaa-0000-0000-0000-000000000001', true) = 7.5);

-- settle over the hold: cost still recorded, flag written, person paused
select public.ledger_place_hold('aaaaaaaa-0000-0000-0000-000000000001', 'r5', 1);
select public.ledger_settle('r5', 1.5);
select pg_temp.ok('settle past the hold still records the real cost',
  (select amount from public.credit_ledger where request_id = 'r5') = 1.5);
select pg_temp.ok('settle past the hold writes a high flag and pauses the person',
  (select count(*) from public.ops_flags where severity = 'high' and cause = 'settle_over_hold:r5') = 1
  and (select paused from public.tester_passes where id = 'aaaaaaaa-0000-0000-0000-000000000001'));
select pg_temp.throws('a paused person cannot place a hold',
  $$select public.ledger_place_hold('aaaaaaaa-0000-0000-0000-000000000001', 'r6', 1)$$, 'paused');

-- tickets: two attempts, right person, not expired; one child
insert into public.route_tickets (id, person_id, ask_hash, expires_at) values
  ('t1', 'aaaaaaaa-0000-0000-0000-000000000002', 'h', now() + interval '5 minutes'),
  ('t2', 'aaaaaaaa-0000-0000-0000-000000000002', 'h', now() - interval '1 minute');
select pg_temp.ok('attempt 1 and 2 succeed in order',
  public.ticket_take_attempt('t1', 'aaaaaaaa-0000-0000-0000-000000000002') = 1
  and public.ticket_take_attempt('t1', 'aaaaaaaa-0000-0000-0000-000000000002') = 2);
select pg_temp.ok('attempt 3 is refused', public.ticket_take_attempt('t1', 'aaaaaaaa-0000-0000-0000-000000000002') is null);
select pg_temp.ok('wrong person is refused', public.ticket_take_attempt('t1', 'aaaaaaaa-0000-0000-0000-000000000001') is null);
select pg_temp.ok('an expired ticket is refused', public.ticket_take_attempt('t2', 'aaaaaaaa-0000-0000-0000-000000000002') is null);
select pg_temp.ok('the child slot is won once',
  public.ticket_take_child('t1', 'aaaaaaaa-0000-0000-0000-000000000002')
  and not public.ticket_take_child('t1', 'aaaaaaaa-0000-0000-0000-000000000002'));

-- ------------------------------------------------------------ final gate
-- Any failed assertion aborts the session; with psql -v ON_ERROR_STOP=1 the
-- exit code is non-zero, so CI cannot wave a red suite through.
do $$
declare v_fails int;
begin
  select count(*) into v_fails from pg_temp.test_results where not ok;
  if v_fails > 0 then
    raise warning '%', (select string_agg('FAIL: ' || name || ' -> ' || detail, E'\n' order by ord) from pg_temp.test_results where not ok);
    raise exception 'POLICY TESTS FAILED: % assertion(s)', v_fails;
  end if;
  raise info 'POLICY TESTS: ALL GREEN (%)', (select count(*) from pg_temp.test_results);
end $$;
