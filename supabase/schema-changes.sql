-- Applied to project jiaxeedguivvhixychcg. Reproduced here for provenance.
-- Incremental schema/data changes made after the initial ml_* setup.

-- Price-history chart: draw each chain in its brand colour.
update ml_stores set color = c.col from (values
  ('rema','#1553A6'),  -- Rema 1000 blue
  ('kiwi','#3DA935'),  -- Kiwi green
  ('extra','#E4032C'), -- Coop Extra red
  ('meny','#8B1D41'),  -- Meny bordeaux
  ('oda','#6C4CA6')    -- Oda purple
) as c(id, col) where ml_stores.id = c.id;

-- Native per-unit price from the sources that expose it (Oda gross_unit_price,
-- ngdata comparePricePerUnit), so price-per-litre/kilo comparison works even
-- when the product name omits the pack size. unit_price_unit holds its
-- dimension (l/kg/stk); populated by ml-ingest-oda and ml-ingest-ngdata.
alter table ml_offers add column if not exists unit_price numeric;
alter table ml_offers add column if not exists unit_price_unit text;

-- Scanned receipt contributions feed the leksikon + price history.
-- ml_registrations gains structured weight fields; a SECURITY DEFINER trigger
-- propagates each new registration into ml_offers (source='scan', so it shows in
-- the leksikon) and ml_price_history (the chart), computing group_key and a
-- per-unit price for weight/count items. See the
-- scan_contributions_feed_leksikon migration for the full ml_group_key() and
-- ml_reg_propagate() definitions.
alter table ml_registrations add column if not exists unit text;
alter table ml_registrations add column if not exists quantity numeric;
alter table ml_registrations add column if not exists line_total numeric;
grant insert (unit, quantity, line_total) on ml_registrations to anon, authenticated;
-- trigger: ml_reg_propagate_trg AFTER INSERT ON ml_registrations → upserts
-- ml_offers(external_id='scan:'||store||':'||slug) and ml_price_history.

-- Offer weekday validity ("man–fre", "helg") parsed from Tjek descriptions
-- (rare, but real) by ml-ingest-offers; and a guard against fake Kassalapp
-- "offers" whose implied markdown exceeds 50% (price_history outliers).
alter table ml_offers add column if not exists offer_days text;
-- one-time cleanup (the function now caps markdown at 50% going forward):
update ml_offers set pre_price = null, offer_text = null
where source = 'kassalapp' and pre_price is not null and pre_price > price * 2;

-- Filter receipt accounting/deposit lines (pant, "tast pant", "utgående salg av
-- emb") out of the community data. ml_is_nonproduct(text) recognises them
-- precisely without catching real products (Libero/Pampers "Pants" = diapers,
-- juice "+Pant", "Pantesekk", "...emballasje" in a name). A BEFORE INSERT trigger
-- (ml_reg_filter) drops such lines from ml_registrations, ml_reg_propagate skips
-- them too, and existing rows were deleted from ml_offers/ml_price_history/
-- ml_registrations. The receipt-scan prompt also excludes them explicitly.

-- Price-point provenance: label each ml_price_history row so the front end can
-- distinguish community receipt scans (which one bad scan could skew) from the
-- official chain/feed prices. Existing rows default to 'official'; the ones a
-- scan produced are backfilled to 'scan' (best-effort match on the
-- registration's computed group_key / store / observed date). Going forward
-- ml_reg_propagate stamps its history point 'scan' and keeps that label only
-- while the scanned price is the one being kept (least()).
alter table ml_price_history add column if not exists source text;
update ml_price_history set source = 'official' where source is null;
update ml_price_history h set source = 'scan'
  from ml_registrations r
  where ml_group_key(r.item_name) = h.group_key
    and r.store_id = h.store_id
    and coalesce(r.observed_at, r.created_at::date) = h.observed_at;
-- ml_reg_propagate() now inserts ...ml_price_history(..., source) values (..., 'scan')
-- on conflict do update set price = least(...),
--   source = case when excluded.price <= existing.price then 'scan' else existing.source end;
-- (Official ingest rows leave source null → shown as "Offisiell" client-side.)

-- Rate-limit anon inserts into ml_registrations, so a shared public link can't
-- be scripted to flood the leksikon with fake prices via the REST endpoint
-- (the receipt-scan Edge Function is per-IP limited, but a direct insert wasn't).
-- ml_reg_ratelimit() (SECURITY DEFINER, BEFORE INSERT, fires after ml_reg_filter)
-- reuses ml_scan_allow + ml_scan_rate under a 'reg:' key namespace:
--   * global cap (spoof-proof): 1500 rows/hour ('reg:GLOBAL')
--   * per-IP cap (best effort, skipped when the IP is unknown so it never
--     over-blocks): 200 rows/hour ('reg:'||ip). IP from request.headers
--     (cf-connecting-ip / x-real-ip / first x-forwarded-for). Verified the IP is
--     captured on the anon PostgREST path.

-- Production hardening ahead of going public (Supabase database linter):
--   * 0011 function_search_path_mutable — pin search_path on the remaining
--     ml_ functions, so a role-local search_path can't redirect an unqualified
--     reference inside them.
--   * 0028/0029 anon|authenticated_security_definer_function_executable — the
--     trigger functions were also reachable as REST RPC endpoints for the
--     public anon key. Firing a trigger does not check EXECUTE, so revoking it
--     closes /rest/v1/rpc/... (verified: now 404) while an anon insert into
--     ml_registrations still propagates into ml_offers + ml_price_history.
-- ml_scan_rate keeps RLS on with no policies on purpose: it is the rate
-- limiter's own table, reachable only through the SECURITY DEFINER functions,
-- so deny-all to anon/authenticated is the intended state (linter 0008, INFO).
alter function public.ml_group_key(text)     set search_path = public, pg_temp;
alter function public.ml_is_nonproduct(text) set search_path = public, pg_temp;
alter function public.ml_reg_filter()        set search_path = public, pg_temp;
revoke execute on function public.ml_reg_filter()    from anon, authenticated, public;
revoke execute on function public.ml_reg_propagate() from anon, authenticated, public;
revoke execute on function public.ml_reg_ratelimit() from anon, authenticated, public;

-- Sweep checkpoint. The Kassalapp catalogue sweep is ~40 self-chained edge
-- function invocations, and dispatchNext is fire-and-forget: an invocation
-- killed on the platform wall-clock before it fires the next range ends the run
-- silently — no retry, and the chained calls don't even show up in the function
-- logs. Measured 2026-07-28: a full sweep died at 77 % of the catalogue and
-- still reported success. Persisting the next page turns the unrecoverable
-- chain into a resumable job that the ml-ingest-kassalapp-resume cron picks up.
create table if not exists ml_sweep_state (
  name        text primary key,
  next_page   int         not null default 1,
  pages_done  int         not null default 0,
  started_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  finished_at timestamptz,
  last_note   text
);
alter table ml_sweep_state enable row level security;  -- service-role only, no policies
insert into ml_sweep_state (name) values ('kassalapp') on conflict (name) do nothing;

-- Cold-start payload split into two views, so the boot download stops carrying
-- the product photos. image_url was 498 kB of the 1697 kB gzipped catalogue
-- (29 %) and cannot be compressed away — gzip already collapses the shared host
-- prefix and the rest is EAN entropy, so hand-packing the URLs into a compact
-- token was measured at 0.8 % and thrown away again. It can only be MOVED, and
-- a screen shows at most 58 products (CAP 50 + 8 offer cards) against ~47 700
-- photos, so the URLs are now fetched per screen.
--
-- Both views are security_invoker, so the querying role's RLS on ml_offers
-- still applies: anon reads through ml_offers_read exactly as it did against
-- the table.
--
-- ml_catalog — what boot pages through (order=external_id, 1000 rows at a time).
-- has_image lets the client reserve a product's image frame before the URL
-- lands, so nothing shifts when photos arrive, and no empty frame appears on
-- the 1 830 products that have no photo. It requires group_key as well, since a
-- photo that ml_group_images cannot be keyed by would reserve a frame that
-- never fills.
create or replace view public.ml_catalog
with (security_invoker = on) as
select
  o.external_id,      -- not selected by the client, but it pages with order=external_id
  o.store_id, o.product_name, o.group_key,
  o.price, o.pre_price, o.unit, o.unit_price, o.unit_price_unit,
  o.offer_days, o.valid_until,
  (o.image_url is not null and o.group_key is not null) as has_image
from public.ml_offers o;

-- ml_group_images — the photos, fetched per screen with group_key=in.(...).
-- Deliberately a plain projection, not DISTINCT ON: a DISTINCT ON view cannot
-- have the client's filter pushed into it, and Postgres materialised all 42 474
-- distinct rows before semi-joining — 108 ms to return 58 rows, on every screen.
-- As a projection the filter reaches ml_offers_group_idx: 1.7 ms.
--
-- Every column the client needs to rank packs the way the CATALOGUE ranks them
-- rides along. That matters: the client reads a pack's size out of its NAME
-- ("...400g Sætre") and only falls back to the unit_price column. One product
-- can arrive from two feeds under the same name and price with different photos
-- (kassalapp .../large.jpg, ngdata .../medium.png for one EAN) where only one
-- feed fills unit_price; ranking on that column alone returned the other pack's
-- photo for 209 of 37 703 groups. external_id is ordered by, never selected, so
-- equal ranks resolve to the same row the catalogue's own reduce keeps.
--
-- Verified against the full catalogue: rebuilding all 37 703 groups and 43 193
-- variants through the lookup reproduces the photo the inline column gave, for
-- every one, with no frame-reservation mismatches.
create or replace view public.ml_group_images
with (security_invoker = on) as
select
  o.external_id,   -- ordered by, not selected: ties resolve as they do in the catalogue
  o.group_key, o.store_id, o.product_name,
  o.unit, o.unit_price, o.unit_price_unit, o.price,
  o.image_url
from public.ml_offers o
where o.image_url is not null
  and o.group_key is not null;

grant select on public.ml_catalog      to anon, authenticated;
grant select on public.ml_group_images to anon, authenticated;

-- group_key dropped from the client payload. It is a pure IMMUTABLE function of
-- product_name, so shipping it too cost 372 kB of the 1208 kB gzipped catalogue
-- (31 %) for a value the client can derive; mlGroupKey() in app.js now does.
--
-- This makes ml_group_key a contract across two languages, and a silent one:
-- group_key is what the price-history and photo lookups join on, so a change on
-- one side alone makes them return nothing rather than fail. The warning lives
-- on the function itself so it surfaces in \df+ and the dashboard, not only
-- here. test/group-key.test.js pins the JS against 164 (name -> key) pairs
-- captured from this function; regenerate that fixture whenever it changes, and
-- expect existing shopping lists (keyed on the current scheme) to shift.
comment on function public.ml_group_key(text) is
  'MIRRORED CLIENT-SIDE: mlGroupKey() in app.js reimplements this exactly, and '
  'the catalogue no longer ships group_key. Changing this function WITHOUT '
  'changing app.js breaks the price-history and photo lookups silently — they '
  'key on group_key and will simply return nothing. test/group-key.test.js pins '
  'the JS against 164 (product_name -> group_key) pairs captured from this '
  'function; regenerate that fixture whenever this changes. Note also that '
  'existing shopping lists are keyed on the current scheme and will shift.';

-- The leksikon defaults to "Nyeste først", which needs a recency signal the
-- catalogue payload doesn't carry. fetched_at is exactly that, for free:
-- it defaults to now() on INSERT and NO ingest function ever sends it, so an
-- upsert on external_id leaves it alone. It marks when a product first entered
-- the leksikon, not the last time a feed re-saw it. (Keep it that way — an
-- ingest that starts writing fetched_at turns the default sort into "whatever
-- ran last".)
--
-- It is exposed on ml_catalog to ORDER BY, never selected. A timestamp per row
-- would add ~1 MB to a ~1.2 MB payload for something the row ORDER already
-- says: boot pages with order=fetched_at.desc,external_id and a group's
-- position in the catalogue is its recency rank (buildGroups → addedRank).
-- external_id is unique, so the order is total and offset paging stays stable
-- across the client's six parallel lanes.
create or replace view public.ml_catalog
with (security_invoker = on) as
select
  o.external_id,      -- not selected by the client, but it breaks ties in the paging order
  o.store_id, o.product_name, o.group_key,
  o.price, o.pre_price, o.unit, o.unit_price, o.unit_price_unit,
  o.offer_days, o.valid_until,
  (o.image_url is not null and o.group_key is not null) as has_image,
  o.fetched_at        -- ordered by, never selected
from public.ml_offers o;

-- Without this every one of the ~50 boot pages sorts all 49 603 rows on disk
-- (external merge, ~105 ms a page). With it they are index scans, as
-- order=external_id was: 27 ms for the deepest page (offset 40 000) against
-- 33 ms for the old order, measured warm on the production catalogue.
create index if not exists ml_offers_fetched_idx
  on public.ml_offers (fetched_at desc, external_id);
