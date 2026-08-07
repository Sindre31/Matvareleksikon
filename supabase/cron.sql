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
    body := jsonb_build_object('bulk', true, 'restart', true, 'pages', 90, 'deleteFirst', false, 'autochain', true),
    timeout_milliseconds := 170000
  );
  $cmd$
);

-- Watchdog for the sweep above. dispatchNext is fire-and-forget: an invocation
-- killed on the platform wall-clock before it fires the next range ends the
-- whole chain silently, with nothing in the logs. Measured 2026-07-28: the
-- chain died at 77 % of the catalogue and reported success. Every 10 minutes
-- this resumes the sweep from ml_sweep_state.next_page. It no-ops while the
-- chain is alive (checkpoint younger than 4 min) and once the sweep is
-- finished — the resume branch returns before it touches the Kassalapp API, so
-- an idle tick is one primary-key read of ml_sweep_state and nothing else.
--
-- WHEN, and why not around the clock: the sweep starts Monday 04:10 UTC and
-- finished 04:57 on 2026-08-03, so outside Monday morning there is by
-- definition nothing to resume. Ticking all week was ~1 000 invocations for the
-- ~5 that can do any work. The cost was never money (4 300/month against a
-- 500 000 free tier) — it was that 50 of the 55 lines in the function log were
-- no-ops, which is exactly where a real failure would hide. Monday 04:00–09:59
-- gives the watchdog a six-hour window over a 47-minute sweep and costs 36
-- ticks a week.
--
-- The trade: a sweep started by hand on another day runs without a watchdog
-- behind it. Widen the hour range, or re-run {resume:true} yourself, if that
-- ever matters.
select cron.schedule(
  'ml-ingest-kassalapp-resume',
  '*/10 4-9 * * 1',
  $cmd$
  select net.http_post(
    url := 'https://jiaxeedguivvhixychcg.supabase.co/functions/v1/ml-ingest-kassalapp',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := jsonb_build_object('bulk', true, 'resume', true, 'pages', 90, 'deleteFirst', false, 'autochain', true),
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

-- Real Oda (oda.com) shelf prices via Oda's public product search API
-- (keyless), 30 min after the offers job. Oda is a single online store → 'oda'.
--
-- Like the Kassalapp sweep this SELF-CHAINS: one trigger starts at the first
-- search term and each invocation dispatches the next range when its time
-- budget runs out. It has to. The term list is swept with paging now instead of
-- keeping page 1 and moving on, which is what took Oda from 1 237 products to
-- 4 913 — but that is 274 requests at ~1 s each, three or four times what one
-- invocation's wall clock allows. {restart:true} also wipes last week's oda
-- rows once, at the head of the chain; the links after it accumulate.
select cron.schedule(
  'ml-ingest-oda-weekly',
  '30 4 * * 1',
  $cmd$
  select net.http_post(
    url := 'https://jiaxeedguivvhixychcg.supabase.co/functions/v1/ml-ingest-oda',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := jsonb_build_object('restart', true, 'autochain', true),
    timeout_milliseconds := 170000
  );
  $cmd$
);

-- Watchdog for the Oda chain, same bargain as the Kassalapp one above:
-- dispatchNext is fire-and-forget, so a link killed on the wall-clock before it
-- fires the next range ends the sweep silently. Every 10 minutes this resumes
-- from ml_sweep_state.next_page (a TERM index for this sweep). It no-ops while
-- the chain is alive (checkpoint younger than 4 min) and once the sweep is
-- finished, so an idle tick is one primary-key read and nothing else.
--
-- The window matters more here than it does for Kassalapp. Kassalapp
-- accumulates and never deletes, so a dead chain leaves last week's prices
-- standing; this sweep deletes at restart, so a chain that dies at 40 % leaves
-- Oda at 40 % of its catalogue until something resumes it. The sweep itself is
-- ~4 minutes, so 04:00-09:59 Monday is a six-hour window over it — but a sweep
-- started by hand on another day runs without a watchdog behind it. Widen the
-- hours, or re-run {resume:true} yourself, if that ever matters.
select cron.schedule(
  'ml-ingest-oda-resume',
  '*/10 4-9 * * 1',
  $cmd$
  select net.http_post(
    url := 'https://jiaxeedguivvhixychcg.supabase.co/functions/v1/ml-ingest-oda',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := jsonb_build_object('resume', true, 'autochain', true),
    timeout_milliseconds := 170000
  );
  $cmd$
);

-- Inspect:   select jobid, jobname, schedule, active from cron.job;
-- Run log:   select * from cron.job_run_details order by start_time desc limit 10;
-- HTTP resp: select id, status_code, content from net._http_response order by id desc limit 5;
-- Remove:    select cron.unschedule('ml-ingest-offers-weekly');
