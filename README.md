# Prisboka — Matvareleksikon med pristrender

A community-sourced grocery-price encyclopedia for the Norwegian chains
Rema 1000, Kiwi, Extra and Meny. Search a product, see what it costs per
store, where the price is heading, and contribute new prices by "scanning"
a receipt.

This repository is the runnable implementation of the Claude Design
prototype [`Matvareleksikon.dc.html`](https://claude.ai/design/p/d6005f67-13a3-49c0-8738-55a4696310a9),
built on the **Industry** design system and backed by a live **Supabase**
database.

**Live:** https://prisboka-matvareleksikon.vercel.app

## Run it

Static front end — no build step, no bundler. It talks to Supabase over the
public REST API (PostgREST) using the publishable/anon key, so it just needs
to be served:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## What's here

| File | Role |
| --- | --- |
| `index.html` | App shell — design system, social/OG meta, favicon |
| `styles.css` | The **Industry** design system (tokens + components). Source of truth for the look. |
| `app.js` | The application: data loading from Supabase, price/trend math, routing, and the three screens, rendered dependency-free |
| `favicon.svg` | Blueprint-mark favicon |
| `og.png` | 1200×630 social preview card |
| `design/` | The imported Claude Design source, kept for provenance |

## Screens (deep-linkable)

- **Leksikon (home)** `#/` — hero + live search, **"Ukas beste tilbud"** (the
  biggest real markdowns this week), and the product grid. Each card leads with
  the **cheapest price per litre/kilo/piece** (the pack price shown beneath),
  so items compare on unit price by default. Products are grouped generically
  (`group_key`) so store-specific items compare; cards are marked **"På tilbud"**.
  Filter by store.
- **Produktgruppe** `#/gruppe/:key` — a generic product and **where it's sold**:
  the store variants ("REMA 1000 Tacosaus Medium", "Coop Extra Tacosaus" …) with
  prices, before-prices and validity, **ranked by price per litre/kilo** (a
  store showing its cheapest-per-unit size; "N størrelser" hints there are more,
  listed on the product page). Each row shows the **price per litre/kilo/piece**,
  and when *every* store is size-comparable the "cheapest" headline is that unit
  price — so a small carton no longer looks cheaper than a big one.
  The size comes from the product name, or from the source's own unit price
  (`unit_price` column) — Meny (ngdata `comparePricePerUnit`), Oda
  (`gross_unit_price`), and offer catalogues (Tjek `quantity`). Each store's
  **representative** variant is its **cheapest per unit**, not its cheapest pack,
  so a small carton can't masquerade as the best deal.
- **Produktside (variant)** `#/vare/:key/:store` — one store's product with, when
  the store carries it in several sizes, a **"Størrelser"** list (every size,
  sorted by price per litre/kilo, cheapest-per-unit highlighted); a **price
  history** chart with each chain in its **brand colour** (Rema blue, Kiwi green,
  Extra red, Meny bordeaux, Oda purple — from `ml_stores`); and a
  **"Registreringer"** list of every recorded price point (store, price, date). When a product is on offer, the ingest functions automatically
  record its before-price as *last week's* price point, so the chart shows the
  markdown from the first time the offer is seen.
- **Skann kvittering** `#/skann` — upload a photo, use the phone camera, or
  **drag-and-drop / paste** an image → the image is sent to a **Supabase Edge
  Function that runs Google Gemini vision** → the parsed line items and detected store are pre-filled for
  review (pick the chain and confirm the **receipt date**) → submit **persists**
  the prices to Supabase. A trigger then feeds each scanned line into the
  **leksikon** (`ml_offers`, `source=scan`) and the **price history**
  (`ml_price_history`, dated to the receipt), so contributed prices show up in
  the catalogue and on the product's chart — weight items keep their kr/kg.

## Backend (Supabase)

Project `jiaxeedguivvhixychcg`, all objects prefixed `ml_` in the `public`
schema:

| Object | Purpose |
| --- | --- |
| `ml_offers` | **The leksikon's data**: real prices — weekly offers from eTilbudsavis/Tjek (`source=etilbudsavis`, with validity), shelf prices from Kassalapp across the chains (`source=kassalapp`), and the authoritative Meny assortment from NorgesGruppen's ngdata API (`source=ngdata`), and Oda's online-store prices (`source=oda`) — store, product, price, before-price, image, and a `group_key` for cross-store grouping. The front end dedupes to the cheapest row per (group, store), so overlapping Meny sources collapse to one card. |
| `ml_price_history` | One real price point per (`group_key`, store, day), appended weekly by the ingest functions. When an offer carries a before-price, that before-price is also back-filled as the previous week's point (non-offer, insert-if-absent) → the variant price-history chart |
| `ml_stores` | Store metadata (name, chart colour/dash, locations) |
| `ml_registrations` | Append-only community contributions from the scan flow (item, price, store, **receipt date**, and structured unit/quantity for weight items). A trigger propagates each into `ml_offers` and `ml_price_history` |
| `ml_scan_allow()` | RPC: per-IP rate limit for the receipt-scan function |
| `ml_scan_rate` | Backing table for the rate limiter |

The leksikon is built entirely from **real prices** (`ml_offers`); the app
groups store-specific products by `group_key` for comparison. (The earlier
synthetic `ml_products` / `ml_monthly_prices` / `ml_total_regs()` objects are
retained but no longer used by the app.)

**Row Level Security** is enabled on every table: anyone may *read* the
catalogue and *insert* a registration (validated by CHECK constraints); no
updates or deletes are exposed to the public key. Offer/history writes happen
only via the ingest Edge Function's service-role key.

## Implementation notes

**Accessibility & empty states.** Clickable cards and table rows are exposed as
keyboard-operable buttons (`role="button"`, `tabindex`, Enter/Space) with
descriptive `aria-label`s; the store filter is an `aria-pressed` button group.
Every screen has a real empty/error state: a distinct message for no-search-hits
vs. an empty store filter vs. an empty catalogue, a "fant ikke varen" view for a
dead product deep link, and a boot-failure screen with a retry button.

**Cross-store grouping.** Products are grouped by a key computed **client-side**
from the name (fold Norwegian letters, strip sizes/units/%/house-brands, then
**sort the remaining words** so word order doesn't matter — "knuste tomater" ==
"tomater knuste"). This merges ~50 % more products across stores than the raw
server key, without re-ingesting. Each offer keeps its own server `group_key`, so
a merged group loads its price history by the **set** of server keys it contains.

**CI.** `.github/workflows/ci.yml` runs on every push: `node --check` on the
front end and `deno check` on each Supabase Edge Function.

The prototype's React-based `DCLogic` component is ported to plain
JavaScript. The rendering and the `chartFor()` / price-change / cheapest-per
computations mirror the original; only the data source changed from a
synthetic in-browser formula to the seeded Supabase tables. Rendering is a
small SVG-aware hyperscript with full re-render on state change and
focus/selection preservation for text inputs. Screens are hash-routed for
shareable URLs and working back/forward.

### Receipt OCR

The scan flow uses **server-side OCR with Google Gemini vision**, via the
`ml-receipt-scan` **Supabase Edge Function** (`supabase/functions/ml-receipt-scan/`).
This mirrors the approach proven in the author's
[`billigkurv`](https://github.com/sindre31/billigkurv) project: the photo is
downscaled to a JPEG in the browser and POSTed to the function, which sends it
to Gemini with a Norwegian receipt prompt and returns clean line items. Key
properties:

- **The Gemini API key never reaches the browser** — it lives as a Supabase
  secret and is only read server-side.
- Weight/quantity items are normalized to a **canonical unit price** (e.g.
  18,68 kr for 0,750 kg → 24,90 kr/kg), and pant/rabatt/mva/total/payment
  lines are excluded — handled by the prompt + a `normalizeItem` step.
- The store is mapped onto Prisboka's four chains and pre-selected.
- The endpoint is public but self-protecting: **per-IP rate limiting**
  (`ml_scan_allow` RPC, 30/hour) plus size and MIME checks.
- If Gemini is unavailable or finds nothing, the flow degrades to manual entry.

**Required secret.** Set a Gemini API key ([aistudio.google.com/apikey](https://aistudio.google.com/apikey))
as an Edge Function secret named `GEMINI_API_KEY`:

```bash
supabase secrets set GEMINI_API_KEY=your-key --project-ref jiaxeedguivvhixychcg
# or: Supabase dashboard → Project Settings → Edge Functions → Secrets
```

Optional: `GEMINI_MODEL` (default `gemini-flash-latest` — a stable alias that
tracks a current Gemini Flash vision model; older pinned ids like
`gemini-2.0-flash` may be quota-limited or `gemini-2.5-flash` deprecated for
new keys). Until the secret is set the function returns a clear
"AI-tjenesten er ikke konfigurert" message.

### Tilbudsaviser & product images

Weekly offers come from the **public Tjek / eTilbudsavis API** (no key), the
same source as `billigkurv`. The `ml-ingest-offers` Edge Function
(`supabase/functions/ml-ingest-offers/`) sweeps the Rema/Kiwi dealer
catalogues and searches broader terms, maps offers onto the four chains, and
writes them into `ml_offers` (via the injected service-role key). As a bonus,
it fills `ml_products.image_url` with a representative photo per product from
the offer images. Re-run it any time to refresh (it replaces the
`etilbudsavis` rows):

```bash
curl -X POST https://<project>.supabase.co/functions/v1/ml-ingest-offers \
  -H "Authorization: Bearer <anon-key>"
```

(The function sends a browser `User-Agent`; Tjek blocks cloud egress without
one.) A `pg_cron` schedule keeps it fresh (see `supabase/cron.sql`).

### Shelf prices (Kassalapp + ngdata)

Weekly offers only cover what's discounted this week, so the bulk of the
leksikon is **everyday shelf prices**, ingested by two more Edge Functions
(both use the shared `group_key` scheme so they compare in the same product
group as the offers):

- **`ml-ingest-kassalapp`** — cross-chain shelf prices from the
  [Kassalapp API](https://kassal.app) (requires the `KASSALAPP_TOKEN`
  secret; no-ops without it). **Accumulate-by-default**: every run adds/updates
  rows (upsert on `external_id`) and appends a daily `ml_price_history` point, so
  historical prices and offers are preserved — it never deletes unless called
  with `{deleteFirst:true}`. Supports a weekly search refresh (`{}`) and a
  one-time bulk sweep of the whole catalogue (`{bulk:true,startPage,pages}`).
- **`ml-ingest-ngdata`** — the authoritative Meny assortment (with product
  images) from NorgesGruppen's public **ngdata** API (keyless, browser
  `User-Agent`), the same source `billigkurv` uses for Meny/Spar.
- **`ml-ingest-oda`** — [Oda](https://oda.com) (the online supermarket,
  formerly Kolonial.no) via its public search API (keyless), with product
  images. Oda is a single online store → the `oda` chain.

All run weekly via `pg_cron` (offers 04:00, Kassalapp 04:10, ngdata 04:20,
Oda 04:30 UTC every Monday = ~06:00–06:30 Oslo). See `supabase/cron.sql`.

## Deployment

The Vercel project's build fetches the committed files from the public
GitHub repo into its output directory, so the deployment is self-contained.
Connect the repo to Vercel (Settings → Git) for automatic deploys on push.
