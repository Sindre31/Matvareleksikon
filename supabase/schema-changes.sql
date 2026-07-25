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
