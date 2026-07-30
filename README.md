# Prisboka — Matvareleksikon med pristrender

A community-sourced grocery-price encyclopedia for the Norwegian chains
Rema 1000, Kiwi and Meny. Search a product, see what it costs per
store, where the price is heading, and contribute new prices by "scanning"
a receipt.

This repository is the runnable implementation of the Claude Design
prototype [`Matvareleksikon.dc.html`](https://claude.ai/design/p/d6005f67-13a3-49c0-8738-55a4696310a9),
built on the **Industry** design system and backed by a live **Supabase**
database.

**Live:** https://prisboka.no (`www.prisboka.no` redirecter dit; også nåbar
på `matvareleksikon.vercel.app`)

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
| `index.html` | App shell — design system, social/OG meta, canonical, JSON-LD, PWA manifest, favicon |
| `styles.css` | The **Industry** design system (tokens + components). Source of truth for the look. |
| `app.js` | The application: data loading from Supabase, price/trend math, routing, and the three screens, rendered dependency-free |
| `sw.js` | Service worker — caches the app shell for offline use (Supabase requests stay network-only) |
| `manifest.webmanifest` | PWA manifest (installable; standalone display, icons, theme) |
| `favicon.svg` | Blueprint-mark favicon |
| `icon-192.png`, `icon-512.png` | PWA/app icons (rasterised from the favicon) |
| `og.png` | 1200×630 social preview card |
| `robots.txt`, `sitemap.xml` | Crawler hints (single canonical URL — the app is hash-routed) |
| `design/` | The imported Claude Design source, kept for provenance |

## Screens (deep-linkable)

- **Leksikon (home)** `#/` — hero + live search, **"Ukas beste tilbud"** (the
  biggest real markdowns this week), and the product grid. Search is
  **relevance-ranked** (`searchRank`): the closest product floats to the top —
  a name that *is* the query or a compound *ending* in it ("helmelk", "lettmelk"
  for "melk") outranks one that starts with it ("melkesjokolade") or only
  mentions it as an ingredient ("havregrøt **med** melk"), shortest name first.
  Each card leads with
  the **cheapest price per litre/kilo/piece** (the pack price shown beneath),
  so items compare on unit price by default. Products are grouped generically
  (`group_key`) so store-specific items compare; cards are marked **"På tilbud"**.
  Filter by store, **sort** (tilbud først / billigst / dyrest / navn), and
  choose the price to lead with: **per kg/l** (jamførpris) or **enhetspris**
  (the pack price) — the toggle drives both the card display and the
  billigst/dyrest sort. Every card carries a **star** to add the item to the
  shopping list. The top bar shows how fresh the data is ("sist oppdatert" =
  the latest recorded price point).
- **Handleliste** `#/liste` — the products you've starred, kept in
  `localStorage` (no account). An entry is `<group key>@<size id>[*<qty>]`: adding a
  product **asks which pack size** you buy (a one-size product skips the
  dialog), and every price below — the row, the per-store sum, the "billigst"
  tag — is *that* size, so the comparison holds like for like. `@alle` means
  "any size" and is what a list saved before sizes existed reads as.
  The size on each row is a button — **change it** and the item keeps its slot
  in the list (`swapEntry`), so a size change never reshuffles the order.
  Each row carries a **quantity** (− N +) that counts through the per-store
  totals, the "handle alt billigst" figure and the basket chart. It rides along
  as the `*N` suffix, left off entirely at 1, so it survives saving, dragging
  and sharing without any of those needing to know about it; a list saved or
  shared before quantities existed reads as one of each. Changing the size
  keeps the count, and changing the count keeps the row's slot.
  Order is the shopper's own: **drag the ⠿ grip** (pointer events, so touch
  works) or move a row with the arrow keys; the order is saved. Price view is
  **per kg/l** (jamførpris) or **enhetspris**, plus a **"bare med kg/l-pris"**
  filter that hides items whose pack states no amount (they still count in the
  per-store totals). Below that,
  **what the whole list costs in each store** — the per-store total plus a
  coverage badge ("har N av M"), ranked by coverage then price, with the
  "handle alt billigst" total spelled out. **Click a store** to expand the
  products behind its sum: each listed item at that store's own price, tagged
  "billigst"/"tilbud" where it applies, and a "fører ikke" line naming what the
  store is missing. Last, **"Handleliste prishistorikk"** charts what the whole
  basket would have cost at each measurement date — **one line per chain**
  (`listStoreSeries`), which is the same basket section 02 prices today. A line
  uses only that chain's own recorded prices and only the points recorded for
  the size each entry is pinned to; nothing is summed across chains or across
  sizes, since that produces a number nobody can shop at. Only dates where a
  chain has a price for *every* item count (a partial basket reads as a price
  drop that never happened), prices carry forward between observations, and a
  chain that never has the whole list is named as left out rather than drawn
  short. **Pack sizes are the catch**: `ml_price_history` keeps one row per
  (group, store, day) — that day's cheapest pack — so which size got recorded
  varies by store and by date, and demanding an exact match made a chain whose
  cheapest pack is never the pinned size vanish from the chart entirely (a list
  pinned to 1 l lettmelk drew no Kiwi line, while section 02 above it had Kiwi
  as the cheapest chain). A store with *any* exact-size measurement still uses
  only those, so an odd week recorded in another pack carries the last real
  price forward; only a store that never once recorded the pinned size falls
  back to **scaling** the measurement to it, labelled both in the caption and
  beside the headline. The representative row is the chain's **best value**
  that day: all four ingests now pick the lowest price per litre/kilo/piece,
  not the lowest sticker price (`betterHistoryRow`). It used to be the cheapest
  pack, which is what created the bias — Kiwi's lettmelk was recorded at 13,10
  for the half-litre (26,20/l) while its 1,75 l sat at 16,46/l, so the series
  read as an expensive chain. The unit price comes from the source where it
  publishes one and otherwise from the size in the product name; Kassalapp
  reports it for every Meny row and for **none** of Kiwi's, so the name parse is
  what makes the rule bite for the chain the bug was reported against. Litres
  are never compared against kilos — that falls back to the pack price. Note
  that this changes what the stored series means, so points recorded before
  2026-07-28 are still cheapest-pack and sit discontinuously under the newer
  ones.
  Purely client-side. **"Del liste"**
  copies a URL that encodes the entries after the hash (`#/liste?d=…`); opening
  it shows a preview + import banner, so a list travels between phone and PC
  without an account (it never silently overwrites the visitor's own list).
- **Produktgruppe** `#/gruppe/:key` — a generic product and **where it's sold**:
  the store variants ("REMA 1000 Tacosaus Medium", "Meny Tacosaus Medium" …) with
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
  The page carries **filters and a sort** — by chain, by pack **size**, and
  billigst / størst pakning / butikk A–Å — and a **price-history chart right
  here**, no click-through needed. Both filters drive the chart: the chain
  filter picks the lines, the size filter keeps only the points recorded for
  that pack. That works because `ml_price_history` keeps the `product_name`
  each point was recorded from, so a point's own size is knowable (`rowSizeId`)
  — necessary, since the ingest stores only the **cheapest** row per (group,
  store, day), so which size a weekly point represents can change from week to
  week. **Per kg/l** therefore divides by *that row's* size, never by the pack
  the store sells today; points with no stated size are dropped and the caption
  says so.
  The group and variant pages each carry a **"Kopier lenke"** button (the URLs
  are already shareable) and the shopping-list star.
- **Produktside (variant)** `#/vare/:key/:store` — one store's product with, when
  the store carries it in several sizes, a **"Størrelser"** list (every size,
  sorted by price per litre/kilo, cheapest-per-unit highlighted); a **price
  history** chart with each chain in its **brand colour** (Rema blue, Kiwi green,
  Meny bordeaux, Oda purple, Extra red — from `ml_stores`); and a
  **"Registreringer"** list of every recorded price point (store, price, date),
  each tagged with its **source** — **"Offisiell"** (chain/feed price) vs.
  **"Skannet"** (community-contributed from a receipt, and so more likely to
  carry a stray error) — so a single bad scan is easy to spot on the chart.
  When a product is on offer, the ingest functions automatically
  record its before-price as *last week's* price point, so the chart shows the
  markdown from the first time the offer is seen.
- **Skann kvittering** `#/skann` — upload a photo, use the phone camera, or
  **drag-and-drop / paste** an image → the image is sent to a **Supabase Edge
  Function that runs Google Gemini vision** → the parsed line items and detected store are pre-filled for
  review (pick the chain and confirm the **receipt date**) → submit **persists**
  the prices to Supabase. A trigger then feeds each scanned line into the
  **leksikon** (`ml_offers`, `source=scan`) and the **price history**
  (`ml_price_history`, dated to the receipt), so contributed prices show up in
  the catalogue and on the product's chart — weight items keep their kr/kg. The
  confirmation screen links each contributed line back to the matching product
  in the leksikon.
- **Om** `#/om` — what Prisboka is, **sources** (tilbudsaviser and receipt
  scans) with a note on the coverage threshold, an independence disclaimer,
  and a **privacy** note (no accounts/tracking; the shopping list is local-only;
  receipt images go to Google Gemini and aren't stored; only the IP is kept
  briefly for rate limiting). A site footer links to it from every screen.
  Note that the *ingest* still runs Kassalapp, ngdata and Oda — the Om copy
  names the two the site presents itself by, not every feed behind it.

## Backend (Supabase)

Project `jiaxeedguivvhixychcg`, all objects prefixed `ml_` in the `public`
schema:

| Object | Purpose |
| --- | --- |
| `ml_offers` | **The leksikon's data**: real prices — weekly offers from eTilbudsavis/Tjek (`source=etilbudsavis`, with validity), shelf prices from Kassalapp across the chains (`source=kassalapp`), and the authoritative Meny assortment from NorgesGruppen's ngdata API (`source=ngdata`), and Oda's online-store prices (`source=oda`) — store, product, price, before-price, image, and a `group_key` for cross-store grouping. The front end dedupes to the cheapest row per (group, store), so overlapping Meny sources collapse to one card. |
| `ml_price_history` | One real price point per (`group_key`, store, day), appended weekly by the ingest functions. Carries a **`source`** (`official` vs `scan`) so the variant's Registreringer table can flag community-scanned points. When an offer carries a before-price, that before-price is also back-filled as the previous week's point (non-offer, insert-if-absent) → the variant price-history chart |
| `ml_stores` | Store metadata (name, chart colour/dash, locations) |
| `ml_registrations` | Append-only community contributions from the scan flow (item, price, store, **receipt date**, and structured unit/quantity for weight items). A trigger propagates each into `ml_offers` and `ml_price_history` |
| `ml_scan_allow()` | RPC: per-IP rate limit for the receipt-scan function |
| `ml_scan_rate` | Backing table for the rate limiter |

The leksikon is built entirely from **real prices** (`ml_offers`); the app
groups store-specific products by `group_key` for comparison. (The earlier
synthetic `ml_products` / `ml_monthly_prices` / `ml_total_regs()` objects are
retained but no longer used by the app.)

Kassalapp derives a before-price from the product's `price_history`, which
occasionally holds junk-high outliers (wrong unit/size) that would look like a
90% markdown (e.g. Lutefisk 29,90 "fra" 299). The ingest caps the implied
markdown at 50% — bigger "discounts" are treated as data noise, not offers.
Offer weekday validity ("man–fre", "helg"), when a flyer states it in its
description, is parsed into `offer_days` (Tjek has no structured field for it, so
coverage is sparse — most offers only carry a full date range).

**Row Level Security** is enabled on every table: anyone may *read* the
catalogue and *insert* a registration (validated by CHECK constraints); no
updates or deletes are exposed to the public key. Offer/history writes happen
only via the ingest Edge Function's service-role key.

**Insert rate limiting.** Because the anon key is public and `ml_registrations`
allows anonymous insert, a `BEFORE INSERT` trigger (`ml_reg_ratelimit`) throttles
direct/scripted floods so a shared link can't pollute the leksikon: a spoof-proof
**global cap** (1500 rows/hour) plus a best-effort **per-IP cap** (200 rows/hour,
skipped when the IP is unknown so it never over-blocks). It reuses the scan
limiter (`ml_scan_allow` / `ml_scan_rate`) under a `reg:` key namespace, and fires
after `ml_reg_filter` so dropped pant/emballasje lines don't count.

## Implementation notes

**Accessibility & empty states.** Clickable cards and table rows are exposed as
keyboard-operable buttons (`role="button"`, `tabindex`, Enter/Space) with
descriptive `aria-label`s; the store filter is an `aria-pressed` button group.
Every screen has a real empty/error state: a distinct message for no-search-hits
vs. an empty store filter vs. an empty catalogue, a "fant ikke varen" view for a
dead product deep link, and a boot-failure screen with a retry button.

**Store coverage threshold — which chains the leksikon shows.** A chain only
belongs in a price comparison once it carries enough of the catalogue to be
compared: a store on a fraction of the products is worse than no store, because
its filter chip empties the grid and "hva koster lista i hver butikk" quotes a
total based on a couple of items. `coveredStores()` counts each store's usable
prices (expired offers and junk rows excluded) and `applyCatalog` hides every
chain under **`MIN_STORE_PRICES` (1500)** — from the grid, the filter chips, the
group/variant pages, the list totals, the history chart and Registreringer:

| Store | Valid prices | Shown |
| --- | ---: | --- |
| Meny | 40 551 | yes |
| Kiwi | 5 785 | yes |
| Rema 1000 | 1 869 | yes |
| Oda | 1 237 | no — below the bar |
| Coop Extra | 120 | no — and no route past it |

For **Coop Extra** the cause is the source, not the ingest: **Coop publishes no
shelf prices anywhere.** There is no Coop dagligvare-nettbutikk, coop.no and
api.coop.no serve CMS content only (the kundeavis is published as images), and
Kassalapp — which supplies the thousands of Rema/Kiwi/Meny shelf prices —
carries Coop only as *store locations*, not products, because it reads the
chains' web shops. Extra's one machine-readable source is the weekly kundeavis
on Tjek/eTilbudsavis, and that is already fully harvested: Tjek holds **120
unique Extra offers** this week and we ingest all 120. Coop's other chains are
*not* a substitute: comparing this week's flyers, Coop Prix/Mega/Marked/Obs
share only 2–19 lines with Extra's, mostly at different prices, so
`ml-ingest-kassalapp` maps **only** Coop Extra to `extra`.

Nothing is hardcoded to a chain and the ingest keeps collecting for the hidden
stores, so one reappears by itself the week it clears the bar — including via
receipt scans: the scan picker deliberately lists **every** chain, so a receipt
from a hidden store is filed under that store and counts towards its coverage
instead of being mis-attributed to a visible one.

**Cross-store grouping.** Products are grouped by a key computed **client-side**
from the name (fold Norwegian letters, strip sizes/units/%/house-brands and
single-letter house tokens, then **sort the remaining words** so word order
doesn't matter — "knuste tomater" == "tomater knuste"). This merges ~50 % more
products across stores than the raw server key, without re-ingesting. Each offer
keeps its own server `group_key`, so a merged group loads its price history by
the **set** of server keys it contains.

**Category-aware grouping.** Some products must group by *variety*, not brand.
Raw mince (`kjøttdeig` / `karbonadedeig`) is keyed by **meat type** — svin,
storfe (the default when unstated), kylling, kalkun, lam, laks, or *blandet* for
a mix — so pork, beef and karbonade land in **distinct** groups while brand,
fat %, salt/water wording and pack size are ignored (`minceKey` in `app.js`). A
guard keeps pizzas, sauces, ready meals and veg imitations that merely mention
"kjøttdeig" out of those groups. Branded products stay split by brand where the
brand *is* the product (Santa Maria vs. Old El Paso tacosaus), while the chains'
own-brand tacosaus collapses together — national brand words are kept, house
brands stripped. Recognised categories get a friendly title via `canonLabel`.

**SEO & PWA.** `index.html` carries a canonical link and JSON-LD (`WebSite` +
`Organization`); `robots.txt` points crawlers at `sitemap.xml`. Because the app
is hash-routed there is a single crawlable URL, so the sitemap lists only the
root. The site is an installable PWA: `manifest.webmanifest` + a service worker
(`sw.js`) that caches the app shell for offline use with a stale-while-revalidate
strategy (a deploy is picked up on the next load), while every cross-origin
Supabase request stays network-only so prices are never served stale.

**Cold-start, offline data & egress.** The catalogue is ~6 MB, so re-downloading
it on every visit is slow on mobile and burns Supabase egress. It is snapshotted
into the **Cache Storage API** (`prisboka-catalog-v1` — the big offers blob, which
would blow the ~5 MB `localStorage` cap) with a small meta record in
`localStorage` (`prisboka_catalog_meta_v2`: timestamp, the tiny stores list,
freshness stamp). Boot:
- **Within `CATALOG_TTL` (12 h)** a return visit trusts the snapshot and makes
  **zero network calls** — instant paint, no egress. Data refreshes weekly, so a
  few hours stale is fine.
- **Older than the TTL** it still paints instantly, then revalidates in the
  background (stale-while-revalidate) and rewrites the snapshot.
- **No Cache API** (insecure context) → always revalidate, as before.

A transient empty or failed fetch never blanks out a good snapshot, and offline
the app stays fully usable (the service worker serves the shell, the snapshot the
data). The service worker's cache cleanup preserves `prisboka-catalog-*` — it only
prunes its own old shell caches — so it never wipes the freshly written snapshot.
Only the columns the client reads are fetched (dropped the unused `valid_from` /
offer-level `source`).

**CI.** `.github/workflows/ci.yml` runs on every push: `node --check` on the
front end, `node --test` for the unit tests, and `deno check` on each Supabase
Edge Function.

**Tests.** `test/grouping.test.js` covers the pure price/grouping helpers — the
hardest, most regression-prone logic: `parseAmount`/`baseAmount` (comparable
per-litre/kilo/piece amounts, incl. multipacks), `ckey` (word-order- and
house-brand-independent cross-store grouping), `minceKey`/`canonLabel`
(category-aware mince keying), and `pctOff`/`normUnit`/`cleanName`. It also
covers the two aggregations the leksikon is actually built on: `buildGroups`
(cross-store folding, cheapest-per-unit store representative, the withheld
"billigst per X" claim when a store lacks a size, offer flags, and expired-offer
filtering) and `searchRank` (exact-match wins, compound-ending beats prefix,
`med`-ingredient demotion, shorter-name tie-break). They use Node's built-in
test runner — no dependencies, no build step:

```bash
node --test
```

`app.js` only runs its browser bootstrap when `window`/`document` exist, so the
tests `require('./app.js')` to reach the helpers it exports under Node.

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
  (`ml_scan_allow` RPC, 30/hour) **and a global daily cap** (500 scans/day,
  checked only for a valid request about to hit Gemini) so a shared link can't
  run up the vision-API bill, plus size and MIME checks.
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
  secret; no-ops without it) — the widest source for **Rema and Kiwi**, which
  otherwise only appear via weekly flyers. **Accumulate-by-default**: every run
  adds/updates rows (upsert on `external_id`) and appends a daily
  `ml_price_history` point, so historical prices and offers are preserved — it
  never deletes unless called with `{deleteFirst:true}`. Supports a weekly search
  refresh (`{}`) and a **full-catalogue bulk sweep** (`{bulk:true}`). Kassalapp
  rate-limits to ~60 req/min per token ("1 kall per sekund"), so the bulk sweep
  runs **sequentially and self-chains**: one invocation pages a range until its
  ~115 s time budget, then fires the next range itself (`autochain`, on by
  default) until a short page marks the end of the catalogue (~2450 pages).
  Only one invocation ever calls the API at a time, so no 429s silently drop
  pages, and there's no hard page cap to keep in sync as the catalogue grows.

  The sweep is **checkpointed** (`ml_sweep_state`) and supervised by a second
  cron. It has to be: `dispatchNext` is fire-and-forget, so an invocation killed
  on the platform wall-clock before it fires the next range ends the whole run
  silently — the chained calls don't even reach the function logs. Running it
  end to end on 2026-07-28 proved the failure: the chain died at **77 %** of the
  catalogue and reported success. Now each range writes its position *before*
  dispatching the next link, `{restart:true}` starts a sweep, `{resume:true}`
  continues one, and `ml-ingest-kassalapp-resume` fires the latter every 10
  minutes. It no-ops while the chain is alive (checkpoint younger than 4 min, so
  two invocations never page at once) and once the sweep is finished. A broken
  link now costs 10 minutes instead of the rest of the catalogue.

  **Verified end to end** (2026-07-28, after the fix): 2437 pages to page 2444
  in 52 minutes, `finished_at` set, and **100,0 % coverage** — every one of the
  42 578 Kassalapp product groups (Meny 35 475, Kiwi 5 379, Rema 1 724) got a
  price point that day. The watchdog logged `chain still active` on every tick
  during the run and `sweep already finished` after, without ever interfering.

  **Pacing** is the interval between request *starts*, not a sleep after each
  one. The two are not the same: the fetch itself takes ~1.6 s, so adding a flat
  1.1 s sleep on top paced the sweep at ~2.9 s/page — ~21 req/min, a third of
  what the token allows, and a 90-page range only got through **41 pages** per
  invocation. Sleeping only the remainder took the same range to **72 pages**
  (measured: 1617 ms/page, 37 req/min, 0 skipped), so the full sweep is ~34
  chained invocations instead of ~60. Each run reports `pagesRead`, `msPerPage`
  and `reqPerMin`, so a slowdown at the source shows up instead of silently
  halving coverage. The sweep is now bound by Kassalapp's own response time
  rather than by our sleep; going faster would need concurrent requests, which
  would break both the one-call-at-a-time invariant and their stated 1 call/s.
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

### Web Analytics

`index.html` loads Vercel Web Analytics from
`/_vercel/insights/script.js`. That route doesn't exist in this repo — Vercel's
edge serves it (and the `/_vercel/insights/view` beacon) only after **Analytics
→ Enable** is switched on for the project in the dashboard; until then the tag
is a harmless 404. Both paths are same-origin, so the `script-src 'self'` /
`connect-src 'self'` CSP in `vercel.json` needs no exception, and `sw.js`
deliberately skips `/_vercel/*` so the tracker is never served from the shell
cache.

**The app reports its own page views.** The tracker fires a view only when the
`pathname` changes — reading its source, hash-only navigation is explicitly
skipped, and it listens to `pushState`/`popstate` but never `hashchange`. This
app changes nothing but the hash, so left to itself the tracker would report a
single `/` per visit and no screen would ever appear. Hence
`data-disable-auto-track` on the script tag and `trackView()` in `app.js`,
which fires on load and on every `hashchange`:

| Screen | `path` | `route` |
| --- | --- | --- |
| `#/` and anything unrecognised | `/` | `/` |
| `#/gruppe/melk-lett` | `/gruppe/melk-lett` | `/gruppe/[gruppe]` |
| `#/vare/melk-lett/kiwi` | `/vare/melk-lett/kiwi` | `/vare/[gruppe]/[butikk]` |
| `#/skann`, `#/om`, `#/liste` | `/skann`, `/om`, `/liste` | same |

`route` is what keeps the dashboard readable: every product would otherwise be
its own row, and the panel keeps only the top handful before bucketing the rest
into "Others". Both fields are documented Web Analytics dimensions
(`requestPath`, `route`), and both travel as ordinary page views to
`/_vercel/insights/view` — these are *not*
[custom events](https://vercel.com/docs/analytics/custom-events), so no paid
plan is involved. The `window.va` queue that Vercel's snippet puts inline lives
in `app.js` instead, for the same reason the service worker registration does:
an inline `<script>` would cost the CSP `'unsafe-inline'`.

Two details in `app.js` that look optional and are not:

- **The `beforeSend` hook strips the hash from the reported URL.** The tracker
  builds that URL from `location.href`, so the hash rides along even when
  `path` is set — and on `#/liste?d=…` the hash *is* the visitor's shopping
  list. The screen is what gets reported, never its contents. The query string
  is deliberately left alone, since that is where `utm_*` lives.
- **The view is reported before `boot()`,** not once the catalogue is ready. A
  visit where the data never loads is still a visit, and is the one you would
  most want to see in the dashboard.

`trackView` derives the screen from `parseHash`, the same function the router
uses, so an unrecognised URL collapses to `/` exactly the way the router treats
it, and the two can't drift apart. A deep link to a group that no longer exists
reports `/gruppe/<key>` and then `/` when the router bounces it home — two
views, which is what the visitor actually experienced.

### Domain

The canonical origin is **`https://prisboka.no`** — the apex, not `www`.
That one hostname is what the `<link rel="canonical">`, the Open Graph
`og:url` and `og:image`, the JSON-LD `@id`s, `sitemap.xml` and the `Sitemap:`
line in `robots.txt` all point at, so all of them move together when the
domain does.

The apex costs a hardcoded `A` record where `www` could have been a `CNAME`
that follows Vercel's IPs, so watch the Domains panel if Vercel ever changes
that address. Worth knowing before reconsidering: the two are separate
origins, and the app's shopping list (`localStorage`) and offer catalogue
(Cache Storage) are per-origin, so moving the canonical host drops every
user's saved list and orphans the scope of any installed PWA.

Attaching it takes two sides, neither of which lives in this repo:

**1. Vercel** (project `prisboka-matvareleksikon` → Settings → Domains) — add
both `prisboka.no` and `www.prisboka.no`, make `prisboka.no` the production
domain, and set `www.prisboka.no` to redirect (301) to it.

**2. DNS at the registrar** — `prisboka.no` is registered outside Vercel, so
the records are set wherever the nameservers point (today: a Norwegian
registrar, not Vercel DNS):

| Name | Type | Value |
| --- | --- | --- |
| `@` | `A` | `216.198.79.1` |
| `www` | `CNAME` | `<project>.vercel-dns-<nnn>.com` |

Vercel shows the exact apex `A` value and the per-project `www` `CNAME` target
in the Domains panel when the domain is added — use the values it prints there
rather than these, which are only the current defaults. Certificates are issued
automatically once the records resolve; expect a few minutes, and up to a
couple of hours if the old records were cached with a long TTL.

`www` → apex is handled twice over, deliberately: Vercel redirects it at the
edge because the domain is attached as a redirect, and `vercel.json` carries a
308 `redirects` rule keyed on the `www.prisboka.no` host so the behaviour is in
version control either way. The rule only fires for requests that already
arrived at that hostname, so it is inert until DNS exists.

**Both halves must point the same way**, and getting this wrong takes the site
down rather than merely serving the wrong hostname. A `vercel.json` rule
pointing back at the host Vercel is redirecting *from* is an infinite
redirect — and it has happened here: the edge sent `www` → apex while the
deployment still sent apex → `www`, so every request to `prisboka.no` bounced
until the browser gave up with `ERR_TOO_MANY_REDIRECTS`. The front page hid it
(`/` alone did not match the rule and answered `200`), but `styles.css`,
`app.js` and every deep link looped, which renders as a blank page rather than
an obvious redirect error. So when the production domain changes in the
dashboard, the `has` host and `destination` in `vercel.json` change with it in
the same breath — and verify with a path that is *not* `/`:

```sh
curl -sI https://prisboka.no/styles.css        # expect 200, not 3xx
curl -sI https://www.prisboka.no/styles.css    # expect 301/308 → apex
```

Every host rule uses `source: "/(.*)"` with `destination: ".../$1"`, not
`/:path*`. The named-segment form does not match the bare root: while the loop
above was live, `prisboka.no/styles.css` redirected but `prisboka.no/` answered
`200`. That gap is what made the outage look like a styling bug instead of a
redirect one, and for the `.vercel.app` host the root is the URL that actually
competes in search listings — so the regex form, which does match the empty
path, is the one to use.

`matvareleksikon.vercel.app` is the project's own Vercel-assigned hostname and
serves the same deployment, so it competed with `prisboka.no` for the same
search listings. It gets the same 308 → apex treatment via a second `redirects`
entry keyed on that host.

Preview deployments are unaffected: their hostnames carry a
`-git-<branch>-<team>` infix (`prisboka-matvareleksikon-git-…vercel.app`), so
they never match the `matvareleksikon.vercel.app` host — worth re-checking if
the project is ever renamed, since a rule that swallowed preview hosts would
redirect every preview to production and make previews impossible to review.

**Response headers** are set in `vercel.json` for every path:

| Header | Value / why |
| --- | --- |
| `Content-Security-Policy` | `script-src 'self'` (no inline script — the service worker is registered from `app.js`, not from a `<script>` block in the HTML), `connect-src` limited to this project's Supabase host, `img-src https:` because product photos are hotlinked from the chains' CDNs, `style-src 'unsafe-inline'` because the UI is built with style attributes, `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` (older browsers; `frame-ancestors` covers the rest) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` — third-party image CDNs see the origin, not the path |
| `Permissions-Policy` | everything off except `camera=(self)`, which the receipt-scan `<input capture>` needs |
| `Cross-Origin-Opener-Policy` | `same-origin` |

The CSP was verified in a headless Chromium against the real app (front page,
liste, skann, om, and a group page) with the header applied as Vercel serves
it: zero violations, service worker registered, JSON-LD intact, fonts and
stylesheet applied. Note that a strict `script-src` also blocks Vercel's
preview-comment toolbar on preview deployments; production is unaffected.

**Stale-data signal.** The ingest runs weekly, so a newest price point older
than `STALE_AFTER_DAYS` (10) means a run was missed — an expired token, a
source that changed shape, a stopped cron. The top bar then reads "… · kan
være utdatert" in the accent colour, with the age in the tooltip. Serving last
month's prices as if they were today's is the one failure a price comparison
must not hide.

**Database hardening.** `supabase/schema-changes.sql` records the linter fixes
applied before going public: `search_path` pinned on every `ml_` function, and
`EXECUTE` revoked from `anon`/`authenticated` on the three trigger functions
that were also reachable as REST RPC endpoints (verified: `/rest/v1/rpc/…` now
404s, while an anonymous insert into `ml_registrations` still propagates into
`ml_offers` and `ml_price_history`). `ml_scan_rate` deliberately keeps RLS on
with no policies — it is the rate limiter's own table, reached only through
`SECURITY DEFINER` functions.

**Operating caveats.**

- **Kassalapp's free tier is non-commercial** ("Ingen kommersiell bruk"; the
  commercial tier is kr 750/month). Prisboka is a free hobby project with no
  ads, which is what that tier allows — adding advertising or any paid feature
  would require the commercial plan. Their rate limit is 60 calls/minute, which
  the sweep respects — it measures 37 req/min, held down by Kassalapp's own
  response time rather than by our pacing floor.
- **Product images are hotlinked** from the chains' CDNs. Kassalapp states it
  does not own the rights to them ("Bilder kan være beskyttet av opphavsrett"),
  so treat a takedown request as expected maintenance rather than a surprise.
- **Egress.** A cold visit downloads the whole catalogue (~6 MB uncompressed,
  far less over the wire), which is why the 12 h snapshot cache exists. Watch
  Supabase egress if traffic grows; the lever is the TTL and the column list in
  `OFFER_COLS`.
- **The cron jobs are scheduled and active** (`select jobname, schedule, active
  from cron.job`), and the `pg_net` → Edge Function path is proven by the 200s
  in `net._http_response`. `cron.job_run_details` is empty only because the
  jobs were scheduled after the most recent Monday.
