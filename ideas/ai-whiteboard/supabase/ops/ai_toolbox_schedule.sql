-- AI Magic Toolbox: run the cleanup job every 10 minutes and the reconciler once a day (build plan 1.12).
-- NOT a migration: run it by hand in the hosted project's SQL editor, once, after the functions are deployed.
-- Before running: replace <project-ref> (2 places), turn on the pg_cron and pg_net extensions (Database > Extensions), and store the
-- cron secret in Vault once:  select vault.create_secret('<the AI_CRON_SECRET value>', 'ai_cron_secret');
-- The secret is read from Vault at run time, so it never sits in this file or in the cron table.

select cron.unschedule(jobname) from cron.job where jobname in ('ai-toolbox-cleanup', 'ai-toolbox-reconcile');

select cron.schedule('ai-toolbox-cleanup', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/cleanup',
    headers := jsonb_build_object('content-type', 'application/json',
      'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ai_cron_secret')),
    body := '{}'::jsonb)
$$);

select cron.schedule('ai-toolbox-reconcile', '17 5 * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/reconcile',
    headers := jsonb_build_object('content-type', 'application/json',
      'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'ai_cron_secret')),
    body := '{}'::jsonb)
$$);
