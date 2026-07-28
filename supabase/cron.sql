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

-- Real shelf prices via Kassalapp, 10 min after the offers job (needs the
-- KASSALAPP_TOKEN secret; the function no-ops without it).
-- Sweeps the WHOLE catalogue every week in accumulate mode (deleteFirst:false),
-- so every product's price is refreshed weekly and nothing is deleted. Kassalapp
-- caps requests at ~60/min per token, so the sweep must be SEQUENTIAL: one
-- net.http_post starts the sweep at page 1, and the edge function self-chains to
-- the next page range until a short page marks the end of the catalogue (~2450
-- pages, ~72 per invocation as measured — the 115 s time budget ends a range,
-- not the `pages` argument). This keeps exactly one invocation calling the API
-- at a time (no 429s dropping pages) and needs no hard page cap.
select cron.schedule(
  'ml-ingest-kassalapp-weekly',
  '10 4 * * 1',
  $cmd$
  select net.http_post(
    url := 'https://jiaxeedguivvhixychcg.supabase.co/functions/v1/ml-ingest-kassalapp',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := jsonb_build_object('bulk', true, 'startPage', 1, 'pages', 90, 'deleteFirst', false, 'autochain', true),
    timeout_milliseconds := 170000
  );
  $cmd$
);

-- Real Meny shelf prices via NorgesGruppen's public ngdata API (keyless),
-- 20 min after the offers job. Complements Kassalapp with the authoritative
-- Meny assortment + product images.
select cron.schedule(
  'ml-ingest-ngdata-weekly',
  '20 4 * * 1',
  $cmd$
  select net.http_post(
    url := 'https://jiaxeedguivvhixychcg.supabase.co/functions/v1/ml-ingest-ngdata',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 170000
  );
  $cmd$
);

-- Real Oda (oda.com) shelf prices via Oda's public search API (keyless),
-- 30 min after the offers job. Oda is a single online store → 'oda'.
select cron.schedule(
  'ml-ingest-oda-weekly',
  '30 4 * * 1',
  $cmd$
  select net.http_post(
    url := 'https://jiaxeedguivvhixychcg.supabase.co/functions/v1/ml-ingest-oda',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{}'::jsonb,
    timeout_milliseconds := 170000
  );
  $cmd$
);

-- Inspect:   select jobid, jobname, schedule, active from cron.job;
-- Run log:   select * from cron.job_run_details order by start_time desc limit 10;
-- HTTP resp: select id, status_code, content from net._http_response order by id desc limit 5;
-- Remove:    select cron.unschedule('ml-ingest-offers-weekly');
