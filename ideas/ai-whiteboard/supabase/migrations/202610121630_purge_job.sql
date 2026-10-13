-- U3 tail: scheduled purge of old tombstones (KTD6). Hard-deleting a tombstone
-- is safe after every live client has had time to pull it; 30 days retention.
-- pg_cron is a hosted-Supabase extension; on a scratch Postgres this is a no-op
-- with a notice so local verification and `db reset` stay clean.
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron unavailable; tombstone purge not scheduled here (hosted project only)';
    return;
  end;
  perform cron.unschedule('purge-tombstones');
  perform cron.schedule('purge-tombstones', '17 4 * * *',
    $c$delete from public.board_elements where deleted_at is not null and deleted_at < now() - interval '30 days'$c$);
end $$;
