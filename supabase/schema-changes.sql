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

-- ─────────────────────────────────────────────────────────────────────────────
-- Feilrapportering ("rapporter feil pris / feil produkt") + admin-overstyringer
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Two tables and one rule. A visitor reports what is wrong with a product;
-- three reports on the same product FLAG it, and three that agree on the same
-- correction APPLY it. An admin (see the ml-admin Edge Function) reviews the
-- flagged rows and can edit, hide or restore any product by hand.
--
-- Corrections cannot live on the ml_offers row itself: the ingest owns that
-- table and rewrites it weekly — ml-ingest-offers DELETEs its whole source and
-- re-inserts it with fresh external_ids every Monday. So an override is keyed
-- on (store_id, product_name), which survives that, and is mirrored onto the
-- offer row (see ml_offer_apply_override below) rather than joined in.

create table if not exists public.ml_price_reports (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  kind          text not null,           -- 'pris' | 'produkt'
  store_id      text not null,           -- the reported variant …
  product_name  text not null,           -- … as it exists in ml_offers
  group_key     text,                    -- client group key, for the admin's deep link
  shown_price   numeric,                 -- what the site showed when it was reported
  correct_price numeric,                 -- kind='pris': what it should be
  correct_name  text,                    -- kind='produkt': what it should be called
  comment       text,
  reporter      text,                    -- client-side id (localStorage), for de-duping
  reporter_ip   text,                    -- server-side only; no insert grant
  status        text not null default 'ny',  -- ny | markert | behandlet | avvist
  applied_at    timestamptz,
  handled_at    timestamptz,
  constraint ml_price_reports_kind_ck     check (kind in ('pris','produkt')),
  constraint ml_price_reports_status_ck   check (status in ('ny','markert','behandlet','avvist')),
  constraint ml_price_reports_price_ck    check (correct_price is null or (correct_price > 0 and correct_price <= 100000)),
  constraint ml_price_reports_name_ck     check (correct_name is null or char_length(btrim(correct_name)) between 2 and 120),
  constraint ml_price_reports_comment_ck  check (comment is null or char_length(comment) <= 500),
  constraint ml_price_reports_reporter_ck check (reporter is null or char_length(reporter) <= 64),
  constraint ml_price_reports_payload_ck  check (
    (kind = 'pris'    and correct_price is not null) or
    (kind = 'produkt' and correct_name  is not null)
  )
);
create index if not exists ml_price_reports_target_idx  on public.ml_price_reports (store_id, product_name, status);
create index if not exists ml_price_reports_created_idx on public.ml_price_reports (created_at desc);

-- Anyone may report; nobody may read the reports back (they carry an IP) or set
-- their own status. Supabase's default privileges grant ALL on a new table in
-- `public` to anon, so the table-level grant is REVOKED first and only the
-- reporter-supplied columns are granted back — otherwise a scripted insert
-- could file itself as already 'behandlet', or forge reporter_ip.
-- (Linter 0024 rls_policy_always_true flags the insert policy, as it does the
-- one on ml_registrations: an open contribution endpoint is the point. What
-- bounds it is the CHECK constraints, the column-level grant, and the
-- rate-limiting trigger below — not a row predicate.)
alter table public.ml_price_reports enable row level security;
revoke all on public.ml_price_reports from anon, authenticated;
drop policy if exists ml_price_reports_insert on public.ml_price_reports;
create policy ml_price_reports_insert on public.ml_price_reports
  for insert to anon, authenticated with check (true);
grant insert (kind, store_id, product_name, group_key, shown_price, correct_price, correct_name, comment, reporter)
  on public.ml_price_reports to anon, authenticated;

create table if not exists public.ml_offer_overrides (
  store_id        text not null,
  product_name    text not null,         -- the name as the FEED writes it — the join key
  new_name        text,
  new_price       numeric,
  clear_pre_price boolean not null default false,   -- kill a bogus "før"-price
  hidden          boolean not null default false,   -- removed from the leksikon
  flagged         boolean not null default false,   -- 3+ reports: needs a look
  reports         int not null default 0,
  admin_locked    boolean not null default false,   -- set by a hand edit; community rules never overwrite it
  origin          text not null default 'community',
  note            text,
  auto_applied_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (store_id, product_name),
  constraint ml_offer_overrides_price_ck  check (new_price is null or (new_price > 0 and new_price <= 100000)),
  constraint ml_offer_overrides_name_ck   check (new_name is null or char_length(btrim(new_name)) between 2 and 120),
  constraint ml_offer_overrides_origin_ck check (origin in ('admin','community'))
);
-- Public reads it (nothing secret: it is what the leksikon shows), writes go
-- through the ml-admin function's service role only.
alter table public.ml_offer_overrides enable row level security;
revoke all on public.ml_offer_overrides from anon, authenticated;
drop policy if exists ml_offer_overrides_read on public.ml_offer_overrides;
create policy ml_offer_overrides_read on public.ml_offer_overrides
  for select to anon, authenticated using (true);
grant select on public.ml_offer_overrides to anon, authenticated;

-- Validate, stamp and rate-limit an incoming report.
create or replace function public.ml_report_prepare() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  hdr  json := nullif(current_setting('request.headers', true), '')::json;
  ip   text;
  orig text;
begin
  ip := nullif(btrim(coalesce(
    hdr ->> 'cf-connecting-ip',
    hdr ->> 'x-real-ip',
    split_part(coalesce(hdr ->> 'x-forwarded-for', ''), ',', 1)
  )), '');

  new.reporter_ip := ip;
  new.status      := 'ny';
  new.applied_at  := null;
  new.handled_at  := null;

  new.store_id     := btrim(new.store_id);
  new.product_name := btrim(new.product_name);
  new.correct_name := nullif(regexp_replace(btrim(coalesce(new.correct_name, '')), '\s+', ' ', 'g'), '');
  new.comment      := nullif(btrim(coalesce(new.comment, '')), '');
  new.reporter     := nullif(btrim(coalesce(new.reporter, '')), '');
  if new.correct_price is not null then new.correct_price := round(new.correct_price, 2); end if;

  -- A report has to point at a row that exists. The client sends the product as
  -- the site DISPLAYS it, which is the override's new_name once one has been
  -- applied — map that back to the ml_offers row it overrides, so corrections
  -- keep accumulating on one key instead of forking after the first rename.
  if not exists (select 1 from ml_offers o
                  where o.store_id = new.store_id and o.product_name = new.product_name) then
    select ov.product_name into orig from ml_offer_overrides ov
      where ov.store_id = new.store_id and ov.new_name = new.product_name limit 1;
    if orig is null then
      raise exception 'Ukjent vare: % hos %', new.product_name, new.store_id
        using errcode = 'check_violation';
    end if;
    new.product_name := orig;
  end if;

  -- Same guard as the scan flow: the anon key is public, so a scripted flood
  -- must not be able to vote a fake price into the leksikon.
  if not ml_scan_allow('rep:GLOBAL', 500, 3600) then
    raise exception 'For mange rapporter akkurat nå. Prøv igjen om litt.'
      using errcode = 'check_violation';
  end if;
  if ip is not null and not ml_scan_allow('rep:' || ip, 20, 3600) then
    raise exception 'Du har sendt mange rapporter på kort tid. Prøv igjen senere.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

-- THE RULE. Three reports on the same product flag it; three that agree on the
-- SAME correction apply it, to the price and to the name alike. Agreement is
-- counted per reporter (the localStorage id, falling back to the IP), so one
-- person pressing the button three times is one report. A hand edit
-- (admin_locked) is never overwritten — the ON CONFLICT ... WHERE simply
-- matches no row, and the reports stay open for the admin instead.
create or replace function public.ml_report_apply() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  win   interval := interval '180 days';
  total int;
  agree int;
  n     int;
begin
  select count(distinct coalesce(p.reporter, 'ip:' || p.reporter_ip, 'row:' || p.id::text))
    into total
    from ml_price_reports p
   where p.store_id = new.store_id and p.product_name = new.product_name
     and p.status in ('ny', 'markert') and p.created_at > now() - win;

  if total >= 3 then
    insert into ml_offer_overrides (store_id, product_name, flagged, reports, origin)
      values (new.store_id, new.product_name, true, total, 'community')
    on conflict (store_id, product_name) do update
      set flagged = true,
          reports = greatest(ml_offer_overrides.reports, excluded.reports),
          updated_at = now();
    update ml_price_reports p set status = 'markert'
     where p.store_id = new.store_id and p.product_name = new.product_name and p.status = 'ny';
  end if;

  if new.kind = 'pris' and new.correct_price is not null then
    select count(distinct coalesce(p.reporter, 'ip:' || p.reporter_ip, 'row:' || p.id::text))
      into agree
      from ml_price_reports p
     where p.store_id = new.store_id and p.product_name = new.product_name
       and p.kind = 'pris' and p.status in ('ny', 'markert')
       and p.created_at > now() - win
       and round(p.correct_price, 2) = new.correct_price;
    if agree >= 3 then
      insert into ml_offer_overrides (store_id, product_name, new_price, origin, reports, flagged, auto_applied_at, note)
        values (new.store_id, new.product_name, new.correct_price, 'community', agree, true, now(),
                'Automatisk rettet: ' || agree || ' rapporter med samme pris')
      on conflict (store_id, product_name) do update
        set new_price = excluded.new_price, auto_applied_at = now(), flagged = true,
            reports = greatest(ml_offer_overrides.reports, excluded.reports),
            note = excluded.note, updated_at = now()
        where ml_offer_overrides.admin_locked = false;
      get diagnostics n = row_count;
      if n > 0 then
        update ml_price_reports p
           set status = 'behandlet', applied_at = now(), handled_at = now()
         where p.store_id = new.store_id and p.product_name = new.product_name
           and p.kind = 'pris' and p.status in ('ny', 'markert')
           and round(p.correct_price, 2) = new.correct_price;
      end if;
    end if;
  end if;

  if new.kind = 'produkt' and new.correct_name is not null then
    select count(distinct coalesce(p.reporter, 'ip:' || p.reporter_ip, 'row:' || p.id::text))
      into agree
      from ml_price_reports p
     where p.store_id = new.store_id and p.product_name = new.product_name
       and p.kind = 'produkt' and p.status in ('ny', 'markert')
       and p.created_at > now() - win
       and lower(p.correct_name) = lower(new.correct_name);
    if agree >= 3 then
      insert into ml_offer_overrides (store_id, product_name, new_name, origin, reports, flagged, auto_applied_at, note)
        values (new.store_id, new.product_name, new.correct_name, 'community', agree, true, now(),
                'Automatisk rettet: ' || agree || ' rapporter med samme navn')
      on conflict (store_id, product_name) do update
        set new_name = excluded.new_name, auto_applied_at = now(), flagged = true,
            reports = greatest(ml_offer_overrides.reports, excluded.reports),
            note = excluded.note, updated_at = now()
        where ml_offer_overrides.admin_locked = false;
      get diagnostics n = row_count;
      if n > 0 then
        update ml_price_reports p
           set status = 'behandlet', applied_at = now(), handled_at = now()
         where p.store_id = new.store_id and p.product_name = new.product_name
           and p.kind = 'produkt' and p.status in ('ny', 'markert')
           and lower(p.correct_name) = lower(new.correct_name);
      end if;
    end if;
  end if;

  return null;
end;
$fn$;

create or replace function public.ml_override_touch() returns trigger
language plpgsql set search_path = public, pg_temp as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists ml_report_prepare_trg on public.ml_price_reports;
create trigger ml_report_prepare_trg before insert on public.ml_price_reports
  for each row execute function public.ml_report_prepare();
drop trigger if exists ml_report_apply_trg on public.ml_price_reports;
create trigger ml_report_apply_trg after insert on public.ml_price_reports
  for each row execute function public.ml_report_apply();
drop trigger if exists ml_override_touch_trg on public.ml_offer_overrides;
create trigger ml_override_touch_trg before update on public.ml_offer_overrides
  for each row execute function public.ml_override_touch();

revoke execute on function public.ml_report_prepare() from anon, authenticated, public;
revoke execute on function public.ml_report_apply()   from anon, authenticated, public;
revoke execute on function public.ml_override_touch() from anon, authenticated, public;

-- Why the override is MIRRORED onto ml_offers instead of joined into the view:
-- ml_catalog is the boot payload, paged 50 × 1000 rows with
-- order=fetched_at.desc,external_id — an index scan on ml_offers_fetched_idx
-- (27 ms for the deepest page). Adding `left join ml_offer_overrides` made the
-- planner hash-join the whole table and sort 41 000 rows to disk instead:
-- measured 1 115 ms for that same page, on every one of ~50 pages. The override
-- table stays the source of truth; its values ride along on the offer row so
-- ml_catalog stays a single-table projection.
alter table public.ml_offers
  add column if not exists ov_name      text,
  add column if not exists ov_price     numeric,
  add column if not exists ov_clear_pre boolean not null default false,
  add column if not exists ov_hidden    boolean not null default false;

-- Every write to an offer row re-reads its override, so a re-ingested row comes
-- back corrected. Idempotent by construction: ml_override_sync() dirties the
-- row, this fires BEFORE UPDATE, and both read the same override row.
create or replace function public.ml_offer_apply_override() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare ov public.ml_offer_overrides%rowtype;
begin
  select * into ov from public.ml_offer_overrides
   where store_id = new.store_id and product_name = new.product_name;
  new.ov_name      := ov.new_name;
  new.ov_price     := ov.new_price;
  new.ov_clear_pre := coalesce(ov.clear_pre_price, false);
  new.ov_hidden    := coalesce(ov.hidden, false);
  return new;
end;
$fn$;

-- The other direction: editing or deleting an override pushes it onto the rows
-- it covers (there can be several — one product name can arrive from two feeds).
create or replace function public.ml_override_sync() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update public.ml_offers o set ov_name = null
     where o.store_id = old.store_id and o.product_name = old.product_name;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    update public.ml_offers o set ov_name = null
     where o.store_id = new.store_id and o.product_name = new.product_name;
  end if;
  return null;
end;
$fn$;
comment on function public.ml_override_sync() is
  'Sets ov_name = null only to dirty the row: ml_offer_apply_override() runs '
  'BEFORE UPDATE and refills every ov_* column from ml_offer_overrides.';

drop trigger if exists ml_offer_apply_override_trg on public.ml_offers;
create trigger ml_offer_apply_override_trg before insert or update on public.ml_offers
  for each row execute function public.ml_offer_apply_override();
drop trigger if exists ml_override_sync_trg on public.ml_offer_overrides;
create trigger ml_override_sync_trg after insert or update or delete on public.ml_offer_overrides
  for each row execute function public.ml_override_sync();

revoke execute on function public.ml_offer_apply_override() from anon, authenticated, public;
revoke execute on function public.ml_override_sync()        from anon, authenticated, public;

-- Both public views now read the corrected values. A hidden product drops out
-- of the leksikon entirely (and out of the photo lookup, so nothing reserves a
-- frame for it); a renamed one re-groups, since group_key is derived from the
-- name — client-side by mlGroupKey(), and here by its SQL mirror.
create or replace view public.ml_catalog
with (security_invoker = on) as
select
  o.external_id,      -- not selected by the client, but it breaks ties in the paging order
  o.store_id,
  coalesce(o.ov_name, o.product_name) as product_name,
  case when o.ov_name is not null then public.ml_group_key(o.ov_name) else o.group_key end as group_key,
  coalesce(o.ov_price, o.price)::numeric(10,2) as price,
  (case when o.ov_clear_pre then null else o.pre_price end)::numeric(10,2) as pre_price,
  o.unit,
  -- A corrected pack price makes the feed's own kr/l stale: scale it with the
  -- correction rather than quote a unit price that no longer divides out.
  case when o.ov_price is not null and o.unit_price is not null and o.price > 0
       then round(o.unit_price * (o.ov_price / o.price), 4)
       else o.unit_price end as unit_price,
  o.unit_price_unit,
  o.offer_days, o.valid_until,
  (o.image_url is not null and o.group_key is not null) as has_image,
  o.fetched_at        -- ordered by, never selected
from public.ml_offers o
where not o.ov_hidden;

create or replace view public.ml_group_images
with (security_invoker = on) as
select
  o.external_id,   -- ordered by, not selected: ties resolve as they do in the catalogue
  case when o.ov_name is not null then public.ml_group_key(o.ov_name) else o.group_key end as group_key,
  o.store_id,
  coalesce(o.ov_name, o.product_name) as product_name,
  o.unit,
  case when o.ov_price is not null and o.unit_price is not null and o.price > 0
       then round(o.unit_price * (o.ov_price / o.price), 4)
       else o.unit_price end as unit_price,
  o.unit_price_unit,
  coalesce(o.ov_price, o.price)::numeric(10,2) as price,
  o.image_url
from public.ml_offers o
where o.image_url is not null
  and o.group_key is not null
  and not o.ov_hidden;

grant select on public.ml_catalog      to anon, authenticated;
grant select on public.ml_group_images to anon, authenticated;

-- The admin's own API. The ml-admin Edge Function reaches the database through
-- these functions and never through PostgREST filter strings: product names are
-- full of commas, dots and parentheses ("Birra Moretti 0,33l flaske"), all of
-- which PostgREST reads as filter syntax. Arguments are typed, so there is
-- nothing to quote and nothing to escape. Service role only.
create or replace function public.ml_admin_search(p_q text default null, p_store text default null, p_limit int default 60)
returns table (
  store_id text, product_name text, display_name text, price numeric, pre_price numeric,
  sources text, row_count int, image_url text,
  ov_name text, ov_price numeric, clear_pre_price boolean, hidden boolean,
  flagged boolean, admin_locked boolean, note text, origin text, open_reports bigint
)
language sql stable set search_path = public, pg_temp as $fn$
  with hit as (
    select o.store_id, o.product_name,
           min(o.price) as price,
           min(o.pre_price) as pre_price,
           string_agg(distinct o.source, ', ') as sources,
           count(*)::int as row_count,
           (array_agg(o.image_url) filter (where o.image_url is not null))[1] as image_url
      from ml_offers o
     where (p_store is null or o.store_id = p_store)
       and (p_q is null or btrim(p_q) = '' or o.product_name ilike '%' || btrim(p_q) || '%')
     group by o.store_id, o.product_name
     order by (o.product_name ilike btrim(coalesce(p_q, '')) || '%') desc,
              length(o.product_name), o.product_name
     limit greatest(1, least(coalesce(p_limit, 60), 200))
  )
  select h.store_id, h.product_name,
         coalesce(ov.new_name, h.product_name) as display_name,
         h.price, h.pre_price, h.sources, h.row_count, h.image_url,
         ov.new_name, ov.new_price, coalesce(ov.clear_pre_price, false), coalesce(ov.hidden, false),
         coalesce(ov.flagged, false), coalesce(ov.admin_locked, false), ov.note, ov.origin,
         (select count(*) from ml_price_reports r
           where r.store_id = h.store_id and r.product_name = h.product_name
             and r.status in ('ny', 'markert'))
    from hit h
    left join ml_offer_overrides ov
      on ov.store_id = h.store_id and ov.product_name = h.product_name
   order by (ov.flagged is true) desc, h.product_name;
$fn$;

-- Every product the admin has touched, or that the community has flagged.
create or replace function public.ml_admin_overrides(p_limit int default 200)
returns table (
  store_id text, product_name text, display_name text, price numeric, current_price numeric,
  new_name text, new_price numeric, clear_pre_price boolean, hidden boolean, flagged boolean,
  admin_locked boolean, origin text, note text, reports int, auto_applied_at timestamptz,
  updated_at timestamptz, open_reports bigint
)
language sql stable set search_path = public, pg_temp as $fn$
  select ov.store_id, ov.product_name,
         coalesce(ov.new_name, ov.product_name),
         (select min(o.price) from ml_offers o
           where o.store_id = ov.store_id and o.product_name = ov.product_name) as price,
         (select min(coalesce(o.ov_price, o.price)) from ml_offers o
           where o.store_id = ov.store_id and o.product_name = ov.product_name) as current_price,
         ov.new_name, ov.new_price, ov.clear_pre_price, ov.hidden, ov.flagged,
         ov.admin_locked, ov.origin, ov.note, ov.reports, ov.auto_applied_at, ov.updated_at,
         (select count(*) from ml_price_reports r
           where r.store_id = ov.store_id and r.product_name = ov.product_name
             and r.status in ('ny', 'markert'))
    from ml_offer_overrides ov
   order by ov.flagged desc, ov.updated_at desc
   limit greatest(1, least(coalesce(p_limit, 200), 500));
$fn$;

-- The report queue. `agree` is how many DISTINCT reporters back this exact
-- correction — the number the rule counts to three, so the admin sees how close
-- a report is to applying itself.
create or replace function public.ml_admin_reports(p_status text default 'open', p_limit int default 200)
returns table (
  id uuid, created_at timestamptz, kind text, store_id text, product_name text, display_name text,
  group_key text, shown_price numeric, current_price numeric, correct_price numeric, correct_name text,
  comment text, status text, agree bigint, open_reports bigint,
  ov_name text, ov_price numeric, hidden boolean, flagged boolean, admin_locked boolean
)
language sql stable set search_path = public, pg_temp as $fn$
  select r.id, r.created_at, r.kind, r.store_id, r.product_name,
         coalesce(ov.new_name, r.product_name),
         r.group_key, r.shown_price,
         (select min(coalesce(o.ov_price, o.price)) from ml_offers o
           where o.store_id = r.store_id and o.product_name = r.product_name),
         r.correct_price, r.correct_name, r.comment, r.status,
         (select count(distinct coalesce(p.reporter, 'ip:' || p.reporter_ip, 'row:' || p.id::text))
            from ml_price_reports p
           where p.store_id = r.store_id and p.product_name = r.product_name
             and p.kind = r.kind and p.status in ('ny', 'markert')
             and p.created_at > now() - interval '180 days'
             and ((r.kind = 'pris'    and round(p.correct_price, 2) = round(r.correct_price, 2))
               or (r.kind = 'produkt' and lower(p.correct_name) = lower(r.correct_name)))),
         (select count(*) from ml_price_reports p2
           where p2.store_id = r.store_id and p2.product_name = r.product_name
             and p2.status in ('ny', 'markert')),
         ov.new_name, ov.new_price, coalesce(ov.hidden, false),
         coalesce(ov.flagged, false), coalesce(ov.admin_locked, false)
    from ml_price_reports r
    left join ml_offer_overrides ov
      on ov.store_id = r.store_id and ov.product_name = r.product_name
   where case
           when p_status is null or p_status = 'alle'  then true
           when p_status = 'open'                      then r.status in ('ny', 'markert')
           else r.status = p_status
         end
   order by r.created_at desc
   limit greatest(1, least(coalesce(p_limit, 200), 500));
$fn$;

-- A hand edit. It locks the product against the community rule (an admin has
-- looked at it; three strangers should not undo that) and answers whatever
-- reports were open on it.
create or replace function public.ml_admin_save(
  p_store text, p_name text, p_new_name text default null, p_new_price numeric default null,
  p_clear_pre boolean default false, p_hidden boolean default false, p_note text default null)
returns void language plpgsql volatile set search_path = public, pg_temp as $fn$
begin
  if not exists (select 1 from ml_offers o where o.store_id = p_store and o.product_name = p_name) then
    raise exception 'Ukjent vare: % hos %', p_name, p_store using errcode = 'no_data_found';
  end if;
  insert into ml_offer_overrides (store_id, product_name, new_name, new_price, clear_pre_price,
                                  hidden, note, origin, admin_locked, flagged)
    values (p_store, p_name,
            nullif(regexp_replace(btrim(coalesce(p_new_name, '')), '\s+', ' ', 'g'), ''),
            p_new_price, coalesce(p_clear_pre, false), coalesce(p_hidden, false),
            nullif(btrim(coalesce(p_note, '')), ''), 'admin', true, false)
  on conflict (store_id, product_name) do update
    set new_name = excluded.new_name, new_price = excluded.new_price,
        clear_pre_price = excluded.clear_pre_price, hidden = excluded.hidden,
        note = excluded.note, origin = 'admin', admin_locked = true, flagged = false,
        auto_applied_at = null, updated_at = now();
  update ml_price_reports set status = 'behandlet', handled_at = now()
   where store_id = p_store and product_name = p_name and status in ('ny', 'markert');
end;
$fn$;

-- Back to whatever the feed says, community rule included: the override row is
-- gone, so the next report starts counting from one again.
create or replace function public.ml_admin_reset(p_store text, p_name text)
returns void language sql volatile set search_path = public, pg_temp as $fn$
  delete from ml_offer_overrides where store_id = p_store and product_name = p_name;
$fn$;

create or replace function public.ml_admin_set_report(p_id uuid, p_status text)
returns void language sql volatile set search_path = public, pg_temp as $fn$
  update ml_price_reports
     set status = p_status,
         handled_at = case when p_status in ('behandlet', 'avvist') then now() else null end
   where id = p_id and p_status in ('ny', 'markert', 'behandlet', 'avvist');
$fn$;

-- "Bruk denne" on a single report: apply that one correction as a hand edit,
-- without waiting for two more people to agree.
create or replace function public.ml_admin_apply_report(p_id uuid)
returns void language plpgsql volatile set search_path = public, pg_temp as $fn$
declare r ml_price_reports%rowtype;
begin
  select * into r from ml_price_reports where id = p_id;
  if not found then raise exception 'Ukjent rapport' using errcode = 'no_data_found'; end if;
  if r.kind = 'pris' then
    perform ml_admin_save(r.store_id, r.product_name,
      (select ov.new_name from ml_offer_overrides ov
        where ov.store_id = r.store_id and ov.product_name = r.product_name),
      r.correct_price, false, false, 'Godkjent rapport ' || to_char(r.created_at, 'DD.MM.YYYY'));
  else
    perform ml_admin_save(r.store_id, r.product_name, r.correct_name,
      (select ov.new_price from ml_offer_overrides ov
        where ov.store_id = r.store_id and ov.product_name = r.product_name),
      false, false, 'Godkjent rapport ' || to_char(r.created_at, 'DD.MM.YYYY'));
  end if;
  update ml_price_reports set status = 'behandlet', applied_at = now(), handled_at = now() where id = p_id;
end;
$fn$;

-- The counters behind the tab labels. open_feedback was appended later; a
-- CREATE OR REPLACE cannot widen a function's return type, so that migration
-- dropped this first. Callers read the row by name, so appending is safe.
drop function if exists public.ml_admin_stats();
create or replace function public.ml_admin_stats()
returns table (open_reports bigint, flagged bigint, overrides bigint, hidden bigint, products bigint, open_feedback bigint)
language sql stable set search_path = public, pg_temp as $fn$
  -- Aliased throughout: `flagged`/`hidden` are also OUT parameter names here,
  -- and an unqualified reference to one is ambiguous.
  select (select count(*) from ml_price_reports r where r.status in ('ny', 'markert')),
         (select count(*) from ml_offer_overrides v where v.flagged),
         (select count(*) from ml_offer_overrides v),
         (select count(*) from ml_offer_overrides v where v.hidden),
         (select count(*) from ml_offers o),
         (select count(*) from ml_feedback f where f.status = 'ny');
$fn$;

-- The tilbakemelding queue. Same shape as ml_admin_reports: typed arguments,
-- service_role only, called by the ml-admin Edge Function.
--
-- sender_ip is deliberately NOT returned. It exists to rate-limit, not to
-- identify, and the queue does not need it to be useful. What the admin does
-- need is whether a message is one of many from the same person, so a flood is
-- visible without the address being on screen: `from_sender` counts the
-- messages sharing this sender id (falling back to the IP) — the same coalesce
-- ml_report_apply uses to count agreement.
create or replace function public.ml_admin_feedback(p_status text default 'open', p_limit int default 200)
returns table (
  id uuid, created_at timestamptz, kind text, message text, email text,
  path text, status text, handled_at timestamptz, from_sender bigint
)
language sql stable set search_path = public, pg_temp as $fn$
  select f.id, f.created_at, f.kind, f.message, f.email,
         f.path, f.status, f.handled_at,
         (select count(*) from ml_feedback f2
           where coalesce(f2.sender, 'ip:' || f2.sender_ip, 'row:' || f2.id::text)
               = coalesce(f.sender, 'ip:' || f.sender_ip, 'row:' || f.id::text))
    from ml_feedback f
   where case
           when p_status is null or p_status = 'alle' then true
           when p_status = 'open'                     then f.status = 'ny'
           else f.status = p_status
         end
   order by f.created_at desc
   limit greatest(1, least(coalesce(p_limit, 200), 500));
$fn$;

create or replace function public.ml_admin_set_feedback(p_id uuid, p_status text)
returns void language sql volatile set search_path = public, pg_temp as $fn$
  update ml_feedback
     set status = p_status,
         handled_at = case when p_status in ('behandlet', 'avvist') then now() else null end
   where id = p_id and p_status in ('ny', 'behandlet', 'avvist');
$fn$;

revoke execute on function public.ml_admin_search(text, text, int)                             from anon, authenticated, public;
revoke execute on function public.ml_admin_overrides(int)                                      from anon, authenticated, public;
revoke execute on function public.ml_admin_reports(text, int)                                  from anon, authenticated, public;
revoke execute on function public.ml_admin_save(text, text, text, numeric, boolean, boolean, text) from anon, authenticated, public;
revoke execute on function public.ml_admin_reset(text, text)                                   from anon, authenticated, public;
revoke execute on function public.ml_admin_set_report(uuid, text)                              from anon, authenticated, public;
revoke execute on function public.ml_admin_apply_report(uuid)                                  from anon, authenticated, public;
revoke execute on function public.ml_admin_stats()                                             from anon, authenticated, public;
revoke execute on function public.ml_admin_feedback(text, int)                                 from anon, authenticated, public;
revoke execute on function public.ml_admin_set_feedback(uuid, text)                            from anon, authenticated, public;
grant execute on function public.ml_admin_search(text, text, int)                              to service_role;
grant execute on function public.ml_admin_overrides(int)                                       to service_role;
grant execute on function public.ml_admin_reports(text, int)                                   to service_role;
grant execute on function public.ml_admin_save(text, text, text, numeric, boolean, boolean, text)  to service_role;
grant execute on function public.ml_admin_reset(text, text)                                    to service_role;
grant execute on function public.ml_admin_set_report(uuid, text)                               to service_role;
grant execute on function public.ml_admin_apply_report(uuid)                                   to service_role;
grant execute on function public.ml_admin_stats()                                              to service_role;
grant execute on function public.ml_admin_feedback(text, int)                                  to service_role;
grant execute on function public.ml_admin_set_feedback(uuid, text)                             to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Tilbakemelding ("Gi tilbakemelding"-knappen nederst til høyre)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Deliberately separate from ml_price_reports. A report is a structured
-- correction to one product, and three reports that agree apply themselves to
-- the public catalogue — that path has to stay as narrow as it is. This is the
-- other half: prose about the site itself ("søket finner ikke rugmel", "grafen
-- er rar på mobil"), which nothing can act on automatically and which a person
-- reads. Nothing here touches ml_offers.
--
-- Written straight from the browser with the publishable key, so it copies the
-- ml_price_reports security shape exactly: insert-only RLS, a table-level
-- REVOKE followed by a column grant covering only the visitor-supplied
-- columns — otherwise a scripted insert could file itself as already
-- 'behandlet', or forge sender_ip — and a SECURITY DEFINER trigger that stamps
-- the IP and rate-limits. There is no read grant: it is read in the SQL editor.
-- (Linter 0024 rls_policy_always_true flags the insert policy for the same
-- reason it flags the one on ml_price_reports: an open contribution endpoint is
-- the point, and what bounds it is the CHECKs, the column grant and the
-- trigger — not a row predicate.)
create table if not exists public.ml_feedback (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind       text not null default 'annet',   -- ros | feil | onske | annet
  message    text not null,
  email      text,                            -- optional: only if they want an answer
  path       text,                            -- the screen they were on (pathname only:
                                              -- the shopping list lives in the fragment
                                              -- so it is never sent anywhere)
  sender     text,                            -- client id (localStorage), for de-duping
  sender_ip  text,                            -- server-side only; no insert grant
  status     text not null default 'ny',      -- ny | behandlet | avvist
  handled_at timestamptz,
  constraint ml_feedback_kind_ck    check (kind in ('ros','feil','onske','annet')),
  constraint ml_feedback_status_ck  check (status in ('ny','behandlet','avvist')),
  constraint ml_feedback_message_ck check (char_length(btrim(message)) between 2 and 2000),
  constraint ml_feedback_email_ck   check (email is null or (char_length(email) between 3 and 254 and position('@' in email) > 1)),
  constraint ml_feedback_path_ck    check (path is null or char_length(path) <= 512),
  constraint ml_feedback_sender_ck  check (sender is null or char_length(sender) <= 64)
);
create index if not exists ml_feedback_created_idx on public.ml_feedback (created_at desc);
create index if not exists ml_feedback_status_idx  on public.ml_feedback (status, created_at desc);

alter table public.ml_feedback enable row level security;
revoke all on public.ml_feedback from anon, authenticated;
drop policy if exists ml_feedback_insert on public.ml_feedback;
create policy ml_feedback_insert on public.ml_feedback
  for insert to anon, authenticated with check (true);
grant insert (kind, message, email, path, sender) on public.ml_feedback to anon, authenticated;

-- Stamp, normalise and rate-limit. Same reasoning as ml_report_prepare: the
-- anon key is public, so an open write endpoint needs a ceiling that does not
-- depend on the client. Reuses ml_scan_allow under an 'fb:' key namespace.
create or replace function public.ml_feedback_prepare() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  hdr json := nullif(current_setting('request.headers', true), '')::json;
  ip  text;
begin
  ip := nullif(btrim(coalesce(
    hdr ->> 'cf-connecting-ip',
    hdr ->> 'x-real-ip',
    split_part(coalesce(hdr ->> 'x-forwarded-for', ''), ',', 1)
  )), '');

  new.sender_ip  := ip;
  new.status     := 'ny';
  new.handled_at := null;

  new.message := btrim(new.message);
  new.email   := nullif(lower(btrim(coalesce(new.email, ''))), '');
  new.path    := nullif(btrim(coalesce(new.path, '')), '');
  new.sender  := nullif(btrim(coalesce(new.sender, '')), '');

  if not ml_scan_allow('fb:GLOBAL', 300, 3600) then
    raise exception 'For mange tilbakemeldinger akkurat nå. Prøv igjen om litt.'
      using errcode = 'check_violation';
  end if;
  -- Skipped when the IP is unknown, so it never over-blocks a whole NAT.
  if ip is not null and not ml_scan_allow('fb:' || ip, 10, 3600) then
    raise exception 'Du har sendt mange tilbakemeldinger på kort tid. Prøv igjen senere.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

-- Firing a trigger does not check EXECUTE, so revoking it closes the function
-- as a REST RPC endpoint for the public anon key (linter 0028/0029) while an
-- anon insert still runs it.
revoke all on function public.ml_feedback_prepare() from anon, authenticated, public;

drop trigger if exists ml_feedback_prepare_trg on public.ml_feedback;
create trigger ml_feedback_prepare_trg
  before insert on public.ml_feedback
  for each row execute function public.ml_feedback_prepare();

-- Reading it back (SQL editor):
--   select created_at, kind, message, email, path from ml_feedback
--    where status = 'ny' order by created_at desc;
--   update ml_feedback set status = 'behandlet', handled_at = now() where id = '…';
