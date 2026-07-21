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

- **Leksikon (home)** `#/` — hero + live search, the month's largest price
  moves (up / down), category filters, and the full product grid.
- **Produktside** `#/produkt/:id` — per-store prices with the cheapest
  flagged, and a price-trend line chart per store with a 6/12-month toggle
  (the prototype's `chartMonths` option).
- **Tilbud** `#/tilbud` — this week's active offers from the chains'
  tilbudsaviser, with product images, before-prices and validity dates,
  filterable by store.
- **Skann kvittering** `#/skann` — upload a photo (or use the phone camera)
  → the image is sent to a **Supabase Edge Function that runs Google Gemini
  vision** → the parsed line items and detected store are pre-filled for
  review → submit **persists** the prices to Supabase and counts them toward
  the community total.

## Backend (Supabase)

Project `jiaxeedguivvhixychcg`, all objects prefixed `ml_` in the `public`
schema:

| Object | Purpose |
| --- | --- |
| `ml_stores` | Store metadata (name, chart colour/dash, locations) |
| `ml_products` | Catalogue (name, unit, category, seeded registration count) |
| `ml_monthly_prices` | 12 months × 4 stores × 18 products of monthly-average prices |
| `ml_registrations` | Append-only community contributions from the scan flow |
| `ml_offers` | Tilbudsaviser (weekly offers) ingested from eTilbudsavis/Tjek, with images and validity dates |
| `ml_products.image_url` | A representative photo per product (from offer images) |
| `ml_total_regs()` | RPC: seeded baseline + real contributions |
| `ml_scan_allow()` | RPC: per-IP rate limit for the receipt-scan function |

**Row Level Security** is enabled on every table: anyone may *read* the
catalogue/prices and *insert* a registration (validated by table CHECK
constraints); no updates or deletes are exposed to the public key. The
monthly prices were seeded with the prototype's original price formula, so
the numbers match the design exactly (e.g. total `5 801 priser` at launch).

## Implementation notes

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

Optional: `GEMINI_MODEL` (default `gemini-2.0-flash`). Until the secret is set
the function returns a clear "AI-tjenesten er ikke konfigurert" message.

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
one.) A `pg_cron` schedule or a GitHub Action could keep it fresh, as
`billigkurv` does.

## Deployment

The Vercel project's build fetches the committed files from the public
GitHub repo into its output directory, so the deployment is self-contained.
Connect the repo to Vercel (Settings → Git) for automatic deploys on push.
