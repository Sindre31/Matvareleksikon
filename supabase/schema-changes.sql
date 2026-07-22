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
