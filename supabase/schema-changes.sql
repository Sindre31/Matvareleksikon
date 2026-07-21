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
