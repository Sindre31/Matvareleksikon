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
- **Skann kvittering** `#/skann` — upload a photo (or use the phone camera)
  → **real OCR runs in the browser** (Tesseract.js, Norwegian model) →
  the parsed line items and detected store are pre-filled for review →
  submit **persists** the prices to Supabase and counts them toward the
  community total.

## Backend (Supabase)

Project `jiaxeedguivvhixychcg`, all objects prefixed `ml_` in the `public`
schema:

| Object | Purpose |
| --- | --- |
| `ml_stores` | Store metadata (name, chart colour/dash, locations) |
| `ml_products` | Catalogue (name, unit, category, seeded registration count) |
| `ml_monthly_prices` | 12 months × 4 stores × 18 products of monthly-average prices |
| `ml_registrations` | Append-only community contributions from the scan flow |
| `ml_total_regs()` | RPC: seeded baseline + real contributions |

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

The scan flow runs **real OCR entirely in the browser** with
[Tesseract.js](https://tesseract.projectnaptha.com/) (loaded on demand from a
CDN, Norwegian language model) — no backend, no API key, no per-scan cost.
The photo is downscaled on a canvas, recognized, and the text is parsed into
candidate `{ name, price }` line items (`parseReceiptText`), with the store
auto-detected from the header (`detectStore`). The parser is tuned against
real Norwegian grocery receipts: it strips the MVA-rate column that sits
between the item name and price (`… 15%  25,40`), skips weight/unit sub-lines
(`0,580kg x kr 49,90`), and drops summary/payment/membership rows
(`Sum`, `BANK`, the MVA table, `Trumf …`). Results are pre-filled into the
review step for the user to correct before saving. If OCR can't load or finds
nothing, it degrades gracefully to manual entry. A server-side OCR (e.g. a
cloud vision API in a Supabase Edge Function) would raise accuracy but adds a
key and cost; the client-side path keeps the app self-contained.

## Deployment

The Vercel project's build fetches the committed files from the public
GitHub repo into its output directory, so the deployment is self-contained.
Connect the repo to Vercel (Settings → Git) for automatic deploys on push.
