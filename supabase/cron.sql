-- Weekly refresh of tilbudsaviser (offers) + product images.
-- Runs the ml-ingest-offers Edge Function every Monday at 04:00 UTC
-- (= 06:00 Europe/Oslo in summer / 05:00 in winter; pg_cron schedules are UTC).
--
-- Applied to project jiaxeedguivvhixychcg. Reproduced here for provenance.
-- The anon JWT below is a public key; the function only needs a valid JWT to
-- pass the platform gate, then does its own work with the injected service role.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'ml-ingest-offers-weekly',
  '0 4 * * 1',
  $cmd$
  select net.http_post(
    url := 'https://jiaxeedguivvhixychcg.supabase.co/functions/v1/ml-ingest-offers',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SUPABASE_ANON_KEY>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cmd$
);

-- Inspect:   select jobid, jobname, schedule, active from cron.job;
-- Run log:   select * from cron.job_run_details order by start_time desc limit 10;
-- HTTP resp: select id, status_code, content from net._http_response order by id desc limit 5;
-- Remove:    select cron.unschedule('ml-ingest-offers-weekly');
