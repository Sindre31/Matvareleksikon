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

Static front end — no bundler. It talks to Supabase over the public REST API
(PostgREST) using the publishable/anon key, so it just needs to be served:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

The front page and everything you reach by clicking work that way. **Deep links
do not**: `/gruppe/melange-margarin` is served by the `rewrites` in
`vercel.json`, and `http.server` knows nothing about them, so loading one
directly 404s. Either click through from `/`, or use a server that falls back
to `index.html` for the app's paths — `npx vercel dev` reads `vercel.json` and
gets it right.

`node build.mjs` is the deploy-time step (Vercel runs it via `buildCommand`).
It prerenders the indexable product pages into `gruppe/` and rewrites
`sitemap.xml` from the live catalogue — see **SEO** below. It is optional
locally, it needs network access to Supabase, and it exits 0 with a warning
when it can't reach it. The output is gitignored.

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
| `build.mjs` | Deploy-time build: prerenders a static HTML page per indexable product group into `gruppe/` and regenerates `sitemap.xml` from the live catalogue |
| `nutrition.json` | Matvaretabellen, distilled — 2 121 foods × 36 nutrients, ~510 kB. Committed, fetched lazily by the product page. See **Næringsinnhold** below |
| `tools/build-nutrition.mjs` | Regenerates `nutrition.json` from Mattilsynet's open API. Run by hand when a new edition lands, not at deploy time |
| `robots.txt`, `sitemap.xml` | Crawler hints. The committed sitemap is a three-URL fallback; `build.mjs` overwrites it with every product worth indexing |
| `<key>.txt` | IndexNow ownership proof. Public by design — it must match `INDEXNOW_KEY` in `build.mjs` |
| `gruppe/` | Build output (gitignored) — one prerendered page per product group |
| `test/` | Unit tests (`node --test`): the pure price/grouping helpers, the "Ukas tilbud" selection, the cold-start offer paging, the on-demand photo loader, the client mirror of `ml_group_key`, the error-report validation, the IndexNow change-detection, and the Matvaretabellen matcher |
| `design/` | The imported Claude Design source, kept for provenance |

## Screens (each on its own URL)

- **Leksikon (home)** `/` — hero + live search, **"Ukas tilbud"**, and the
  product grid. The offer row is picked the way a tilbudsavis fills its front
  page (`pickWeeklyOffers`), in three tiers: a **real tilbudsavis offer** first
  (only that feed dates its offers, so a `valid_until` marks one — everything
  else is an offer *inferred* from a price history, and a junk-high history
  value reads as a markdown: the ingest caps the implied cut at 50 %, and
  **1 018 of Meny's 2 211 "offers" sit at exactly −50 %**); then the
  categories a household buys every week (ost, kjøttdeig, kaffe, kylling …);
  then the deepest cut *inside* a category. One card per product, at most two
  per category, and whatever is left fills the remaining slots, so a week with
  no tilbudsavis data still gets a row. Category terms are matched against the
  group key with compound-aware rules — 5+ letters match anywhere in a word
  (`kyllingfilet`, `orretfilet`), 4 letters only as the compound head
  (`havrebrod` is bread, `melkesjokolade` is *not* milk, `chocolate` is not
  cola), 1–3 whole-word only — and baby food and pet food are held out of the
  staples, so "Pasta&laks 1-3år" does not headline as fish. Ranking on markdown
  alone filled the row with whatever obscure line a chain dumped that week.
  Search is
  **relevance-ranked** (`searchRank`): the closest product floats to the top —
  a name that *is* the query or a compound *ending* in it ("helmelk", "lettmelk"
  for "melk") outranks one that starts with it ("melkesjokolade") or only
  mentions it as an ingredient ("havregrøt **med** melk"), shortest name first.
  Each card leads with
  the **pack price** (enhetspris — the number on the shelf label), with the
  price per litre/kilo/piece beneath. Products are grouped generically
  (`group_key`) so store-specific items compare; cards are marked **"På tilbud"**.
  The grid opens on **"Nyeste først"** — what entered the leksikon most
  recently, first. That order costs nothing to ship: the catalogue is paged
  `order=fetched_at.desc,external_id`, and a group's position in it *is* its
  recency rank (`addedRank`, set in `buildGroups` from the first row that
  creates the group). `fetched_at` is a first-seen stamp — it defaults to
  `now()` on insert and no ingest ever writes it, so a weekly re-upsert leaves
  it alone. Filter by store, **sort** (nyeste / tilbud først / billigst /
  dyrest / navn — searching turns the first slot into **"Beste treff"**,
  relevance-ranked), and choose the price to lead with: **enhetspris** (the
  pack price) or **per kg/l** (jamførpris) — the toggle drives both the card
  display and the billigst/dyrest sort. Every card carries a **star** to add the item to the
  shopping list. The top bar shows how fresh the data is ("sist oppdatert" =
  the latest recorded price point). On a phone it fits on one line: the
  Handleliste label collapses to a **cart glyph** (with the item count as a
  badge) and moves last, and the two items that don't fit drop out — "Om" is in
  the footer of every screen, and "Skann kvittering" is where "Bidra med priser"
  already leads. The freshness stamp drops to its own row under a **rule**, and
  the menu type **scales with the viewport** (`clamp()`, 21/15 px from ~390 px
  up, easing to 17/13 at 320) so the row stays one line down to the narrowest
  phones instead of wrapping the cart onto a line of its own.
- **Handleliste** `/liste` — the products you've starred, kept in
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
  copies a URL that encodes the entries after the hash (`/liste#d=…`); opening
  it shows a preview + import banner, so a list travels between phone and PC
  without an account (it never silently overwrites the visitor's own list).
- **Kategori** `/kategori/:slug` — the page for "hva koster egg": the cheapest
  in each chain across the whole category, then every product in it ranked by
  price per kilo or litre, each linking to its own group page. Regroups
  nothing — see **Category pages** below.
- **Produktgruppe** `/gruppe/:slug` — a generic product and **where it's sold**:
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
  Under the chart, **"03 · Næringsinnhold"** — energy and the ten declaration
  lines per 100 g (or per one of the food's own household portions: *1 glass
  (190 g)*, *1 skive*), with vitamins and minerals a click away. The numbers
  come from **Matvaretabellen**, they describe a *generic* food rather than
  this pack, and the section says so and names and links the food it matched.
  It is absent — not empty — for the ~80 % of the leksikon Mattilsynet's table
  does not cover. See **Næringsinnhold** below.
  The group and variant pages each carry a **"Kopier lenke"** button (the URLs
  are already shareable) and the shopping-list star.
- **Produktside (variant)** `/vare/:slug/:butikk` — one store's product with, when
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
- **Skann kvittering** `/skann` — upload a photo, use the phone camera, or
  **drag-and-drop / paste** an image → the image is sent to a **Supabase Edge
  Function that runs Google Gemini vision** → the parsed line items and detected store are shown for
  review (pick the chain and confirm the **receipt date**) → submit **persists**
  the prices to Supabase. The scanned **name and price are read-only**: a
  contributor removes a misread line with ✕, but cannot retype it, so a made-up
  price can't be entered by hand into a public catalogue. There is no manual
  entry — a scan that fails or finds nothing returns to the upload screen with
  an error instead of an empty row to type into. A trigger then feeds each scanned line into the
  **leksikon** (`ml_offers`, `source=scan`) and the **price history**
  (`ml_price_history`, dated to the receipt), so contributed prices show up in
  the catalogue and on the product's chart — weight items keep their kr/kg. The
  confirmation screen links each contributed line back to the matching product
  in the leksikon.
- **Rapporter feil** — not a screen but a dialog, reachable from every product:
  a **"⚠ Rapporter feil"** button on the variant page and a ⚠ on each row of the
  group page's "Selges hos" table. Two kinds, because those are the two the
  leksikon can act on: **feil pris** (write the price on the shelf) or **feil
  produkt** (write what the item is actually called), plus an optional comment.
  Reports are anonymous, keyed to the variant they were filed from, and the
  dialog refuses a "correction" that equals what is already shown.
  **Three reports on the same product flag it** for review; **three that agree
  on exactly the same price — or the same name — apply it by themselves**, and
  the leksikon shows the corrected value from that moment. Agreement is counted
  per reporter (a random id in `localStorage`, falling back to the IP), so one
  person pressing the button three times is one report, and a product an admin
  has edited by hand is never overwritten by the rule. See `ml_report_apply` in
  `supabase/schema-changes.sql`.
- **Gi tilbakemelding** — a floating button in the bottom-right corner of every
  screen (glyph-only below 560 px; absent from `/admin`), opening a dialog with
  a **kind** — *noe er feil / ønske / ros / annet* — a **message**, and an
  **optional e-mail**, for anyone who wants an answer. It exists because
  "Rapporter feil" deliberately doesn't take free text: that path applies
  itself to the public catalogue and has to stay narrow, so everything *about
  the site* ("søket finner ikke rugmel", "grafen er rar på mobil") had nowhere
  to go but the footer's `mailto:`, which is a dead end on a phone. Messages
  land in `ml_feedback` and are **read by a person** — nothing here is applied
  automatically and nothing touches `ml_offers`. Only the visitor's `pathname`
  is recorded, never the URL fragment: the shopping list lives there precisely
  so it is never sent anywhere.
- **Admin** `/admin` — the password-protected back office. Unlisted: no link in
  the nav or the footer. Four tabs — the **report queue** (approve a
  correction with "Bruk denne", or reject it), the **tilbakemelding queue**,
  **product search** across the whole catalogue, and **the products that have
  been changed**. The tilbakemelding queue is free text and changes nothing by
  itself: filter by uleste/behandlet/avvist, mark a message handled or rejected,
  and — when the sender left an e-mail — "Svar" opens a draft in your own mail
  client with the message quoted (the server sends no mail). The sender's IP is
  never shown; a repeat sender surfaces as an "N fra samme avsender" badge
  instead. Editing a
  product sets its name and price, kills a bogus "førpris", or **removes** it
  from the leksikon (a reversible hide — "Tilbakestill" puts the chain's own
  data back). Edits are stored per (butikk, kjedens produktnavn) in
  `ml_offer_overrides`, so they **survive the weekly ingest**, which rewrites
  `ml_offers` wholesale. The password lives as a Supabase secret and is checked
  in the `ml-admin` Edge Function, never in the browser — see below.
- **Om** `/om` — what Prisboka is, **sources** (tilbudsaviser and receipt
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
| `ml_price_reports` | Append-only community **error reports** (`kind` = `pris`/`produkt`, the reported variant, the proposed correction, an optional comment). Anyone may insert; nobody may read them back (they carry an IP) or set their own `status`. `ml_report_prepare` validates and rate-limits on the way in, `ml_report_apply` runs the three-report rule |
| `ml_feedback` | Append-only free-text **tilbakemeldinger** from the floating button (`kind` = `ros`/`feil`/`onske`/`annet`, the message, an optional e-mail, the `pathname` they were on). Same security shape as `ml_price_reports` — insert-only for the anon key, a column grant covering only the five visitor-supplied fields, no read grant, and `ml_feedback_prepare` stamps the IP and rate-limits (300/h globally, 10/h per IP). Read it in the SQL editor: `select created_at, kind, message, email, path from ml_feedback where status = 'ny' order by created_at desc;` |
| `ml_offer_overrides` | The corrections themselves, keyed on (`store_id`, the **chain's** `product_name`): new name, new price, "drop the før-price", hidden, plus `flagged`/`admin_locked`/`origin`. Public-readable, service-role-writable |
| `ml_admin_*()` | The admin API — `search`, `overrides`, `reports`, `feedback`, `save`, `reset`, `set_report`, `apply_report`, `set_feedback`, `stats`. Typed arguments, `service_role`-only, called by the `ml-admin` Edge Function (product names and free text are full of commas and dots, which PostgREST reads as filter syntax) |

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
after `ml_reg_filter` so dropped pant/emballasje lines don't count. Error reports
reuse it once more under `rep:` (500/hour globally, 20/hour per IP).

**Corrections ride on the offer row, they don't join to it.** `ml_offer_overrides`
is the source of truth — it must be, since `ml-ingest-offers` DELETEs and
re-inserts its whole source every Monday, so an edit written into `ml_offers`
would not survive the week. But `ml_catalog` is the boot payload, paged 50 × 1000
rows with `order=fetched_at.desc,external_id`, and adding a `left join` to it
made the planner hash-join the whole table and sort 41 000 rows to disk:
**1 115 ms** for the deepest page against 27 ms as an index scan, on every page.
So the override's values are mirrored onto the offer row (`ov_name`, `ov_price`,
`ov_clear_pre`, `ov_hidden`) by a pair of triggers — one that re-reads the
override on every write to `ml_offers` (so a re-ingested row comes back
corrected), one that pushes an edited override onto the rows it covers — and the
views stay single-table projections. Measured after the change: **38 ms** warm
for that same page.

A corrected name re-groups the product, since `group_key` is derived from the
name (`ml_group_key` server-side, `mlGroupKey()` client-side); a corrected price
scales the feed's own `unit_price` with it, rather than quoting a kr/l that no
longer divides out. A hidden product leaves `ml_catalog` **and** `ml_group_images`,
so nothing reserves a photo frame for a product that isn't there.

**The admin password** is the `ADMIN_PASSWORD` secret on the `ml-admin` Edge
Function — set it before the panel can be used:

```bash
supabase secrets set ADMIN_PASSWORD='…' --project-ref jiaxeedguivvhixychcg
# or: Dashboard → Project settings → Edge Functions → Secrets
```

Without it the function refuses every request, login included — there is no
default password. Checking the password in `app.js` would guard nothing: the key
the browser holds is *publishable*, and it is RLS, not the front end, that makes
the catalogue read-only to it. So the password is compared server-side in
constant time, a successful login returns a **signed, expiring token** (HMAC-SHA256,
key derived from the password — changing the password invalidates every
outstanding session, 12 h otherwise), failed logins are rate-limited per IP, and
the service-role key that performs the edits never leaves the server. The token
lives in `sessionStorage`, so closing the tab logs out.

## Implementation notes

**Accessibility & empty states.** Clickable cards and table rows are exposed as
keyboard-operable buttons (`role="button"`, `tabindex`, Enter/Space) with
descriptive `aria-label`s; the store filter is an `aria-pressed` button group.
Every screen has a real empty/error state: a distinct message for no-search-hits
vs. an empty store filter vs. an empty catalogue, a "fant ikke varen" view for a
dead product deep link, and a boot-failure screen with a retry button.

**Category pages — the words people actually search.** Groups are keyed on a
product's whole name, so `Smør Økologisk 250g Røros` keys to
`okologisk roros smor`. There is no group called `smor`, because no product is
named simply "Smør". Of 24 everyday staples checked, **9 had a page and 12 had
no group at all** — no landing page for "hva koster egg", "smørpris",
"potetpris", among the most-searched grocery queries in Norway.

A category (`/kategori/egg`) **regroups nothing**. It is a view over the groups
that already exist, so every like-for-like comparison underneath is untouched;
the page gathers them, ranks them and links onward. That linking is half the
point: ~5 000 product pages reachable only by paging through the catalogue are
orphans, and internal links are most of what tells a crawler which pages matter.
The category list sits on the front page and on every category page.

Matching is **anchored to the head of the name**, not to the name anywhere.
`mlGroupKey` keeps word order (`ckey` sorts alphabetically and drops
one-letter words, so `m/` is gone by then), and the term must land in the first
two tokens:

| name | key | verdict |
| --- | --- | --- |
| `Helmelk 1,75l Tine` | `helmelk` | melk ✓ |
| `Havregrøt m/Melk 50g Axa` | `havregrot m melk` | ✗ it is porridge |
| `Melange margarin u/melk` | `melange margarin u melk` | ✗ it is margarine |
| `Firkløver m/Kaffe Freia` | `firklover m kaffe` | ✗ it is chocolate |

The second token counts because `mlGroupKey` strips only the chains and a few
big brands — `Kims Potetgull`, `Wasa Knekkebrød` and `Dolmio Pastasaus` all
lead with a brand it does not know. That window is also what let a pastry onto
the egg page (`Wienerbrød egg&rosin`), so it **closes when the first token is
itself a product**: `CATEGORY_NOT_HEAD` lists the prepared dishes and baked
goods that are named for what fills them. Expect to extend it; it is the same
kind of list as `MINCE_DISQUALIFY` and wants the same treatment.

`CATEGORIES` is **ordered, and the order matters** exactly as in `POPULAR`: the
first match wins, so a composite claims its groups before the ingredient it is
named for. `pastasaus` leads with a word containing `pasta`, so the sauce must
come first or the pasta page fills with jars of sauce. Two further guards: a
per-category `not`, and `CATEGORY_NONFOOD` for napkins printed with coffee cups
and bread bags.

Ranking is by price per kg/l **within the category's dominant unit**. Some
categories mix dimensions — yoghurt has both kg and stk — and putting 16,20/stk
above 27,00/kg is two scales in one column, not a ranking; the rest keep their
place below, on pack price.

`build.mjs` prerenders every category that has products (an empty page is worse
than no page, and it is the one a search would land on) and puts them in the
sitemap **above** the product pages: one category answers a whole query rather
than a single product.

**Unit price — two estimates, and a disagreement is a fault report.** The price
per kg/l is derived twice: parsed from the product name, and read off the
source's own field. On the 10 800 catalogue rows where both exist in the same
dimension **they agree within 2 % on 97 %** of them, which is what makes the
remainder worth reading rather than averaging.

Past a factor of **3** the pack keeps its shelf price and claims **no** price
per kilo, because one estimate is wrong and nothing in the data says which:

| | name says | source says | wrong one |
| --- | ---: | ---: | --- |
| `Ostekake m/Pasjonsfrukt 380g` | 210,30/kg | 210 263/kg | source, by 1000 |
| `Leverpostei Kuvert, 22g x 70stk` | 20 009/kg | 285,80/kg | name |
| `Coca-Cola Zero 0,33lx20bx Brett` | 421,20/l | 21,10/l | name |

The factor is 3 because **below it the disagreements are not faults.** They are
drained weight against total weight, which is how canned goods are labelled:
`Agurker Hele 580g Nora` is 63,60/kg by the jar and 136,70/kg by what you eat,
and both numbers are true. 262 of the 297 disagreements sit under 3 and are
that; the 35 above it are broken. A jar cannot be much more than two-thirds
liquid, so 3 is where the physical explanation runs out — the number is not a
taste setting.

`parseAmount` also learned the **count-after-size** multipack spelling
(`22g x 70stk`, `0,33lx20bx`, `175gx2stk`; 64 rows). It only read the
count-first form, so a 70-cup box of leverpostei was priced as one 22 g cup.
Requiring the `x` immediately after the unit is what keeps the rule tight.

Still open: a row whose **price basis** differs from the size its name states,
with no source figure to check it against — `Kyllingfilet Spyd Sweet Chili 1kg`
at 14 kr, `Kaffemelk 3,5% 100x10ml Kuvert` at 2,10. Both parse correctly and
both have `unit_price` null, so there is no second opinion to disagree with.
That is an implausible *price*, the tail of the same problem `MIN_PRICE_NOK`
addresses, and it wants a different instrument — peer comparison inside a
group, or a per-category band — rather than a guess bolted onto this one.

**Price floor — what counts as a price at all.** Meny's feed carries
**placeholder** prices for goods it has no real figure for, and they are not
rare noise but a systematic pattern: counter and deli items (`Husets Pizza`
0,10, `Barracuda Filet pr Kg` 2,00, `Sau hel og Halv pr Kg` 2,00), free
municipal waste bags at 0,01 (Kiwi has those too), gift cards, cutlery packs.
**101 catalogue rows sat at or below 2 kr and not one was a real grocery
price.** One of them — `Kjøttdeig Av Storfe Øko pr Kg` at 0,80 — was enough to
drag a product's whole price chart to the floor, on a page built to be found
in search.

`MIN_PRICE_NOK` is **2**, and the number is where it is because the data put it
there: the first genuine prices appear just above, at 2,40–2,99 (taco spice
sachets, loose potatoes, marsipan), so a floor at 3 would have taken ~15 real
products with it. It removes 91 groups, 89 variants and 3 of the ~5 000
indexable pages — every one of them a placeholder or a non-food item.

The floor cannot key on `pr Kg` or `Husets` instead: plenty of counter rows
carry a true per-kilo price (`Kjøttdeig Av Storfe pr Kg` at 225). The price
itself is the only thing that separates a placeholder from a measurement.

It is applied in **both places on purpose**. The four `ml-ingest-*` Edge
Functions drop such rows on the way in, and since each deletes its own
`source=` rows before re-inserting, the catalogue cleans itself on the next
weekly run. But `ml_price_history` is **append-only** — a placeholder recorded
once would define that product's chart forever — so `app.js` applies the same
floor when it reads the catalogue, the product history and the shopping-list
history. Change `MIN_PRICE_NOK` in all five files together.

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
| Oda | 1 244 → 4 735 | was below the bar; see below |
| Coop Extra | 120 | no — and no route past it |

**Oda** was below the bar for want of paging, not for want of a source. The
ingest called Oda's `/search/mixed/` once per term and kept what page 1 held —
33 items of mixed types, so roughly 20 products a term — 1 244 rows in
`ml_offers`, measured 2026-08-07.
Reading the products-only `/search/` endpoint and paging it to the end of each
term yields **4 913 unique products** over the same 56 terms. A full live sweep
on 2026-08-07 ran its 274 requests in **137 s** and produced **4 735 rows** —
the difference is products sold out or priced below `MIN_PRICE_NOK`. Every row
carried a unit price, 4 734 of 4 735 carried an image, and **91** were on a real
markdown (median 30 % off) where the old ingest found none at all. That is three
times over the threshold, and it makes Oda the second-best-covered chain.

**What it does not buy.** Oda is still mostly its own catalogue rather than a
column in someone else's comparison. Sampling 118 of the sweep's 4 601
`group_key`s against `ml_offers`, **9 (7.6 %)** matched a group another chain
already carries. That is not a regression — it is what this scheme does across
differently-named catalogues, and it is a slight improvement on where Oda sits
today:

| Store | Groups | Shared with another chain |
| --- | ---: | ---: |
| Meny | 35 552 | 13.9 % |
| Kiwi | 5 496 | 88.9 % |
| Rema 1000 | 1 798 | 9.0 % |
| Oda (today) | 1 232 | 6.3 % |
| Coop Extra | 142 | 15.5 % |

Kiwi's 88.9 % is the outlier for a dull reason: Kiwi and Meny both come from
Kassalapp and so share its naming. Scaled up, the sweep takes Oda from 77
cross-store groups to roughly 350 — a real gain, but the honest headline is
"Oda's prices are now visible at all", not "everything now compares".

The row count above is a live measurement of the ingest, taken without writing
to the database. Re-measure `ml_offers` itself after the first scheduled sweep.

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

**SEO.** Every screen has a real path (`/gruppe/melange-margarin`), not a
fragment. This is load-bearing rather than cosmetic: a `#` is not part of the
URL a crawler stores, requests or ranks, so while the products lived in the hash
the entire leksikon was **one** indexable document — the front page — and no
amount of content could change that. Three things had to be true together, and
each was separately fatal:

1. **Its own URL.** `/gruppe/:slug` and `/vare/:slug/:butikk`, served by the
   `rewrites` in `vercel.json`. The slug is the group key with spaces as
   hyphens — `ml_group_key` folds a name down to `[a-z0-9 ]`, so that mapping is
   total and reversible with no lookup table (asserted over the frozen fixture
   in `test/urls.test.js`). Pre-move `#/gruppe/…` links are translated in place
   by `legacyHashPath` on boot, so what has already been shared still lands.
2. **Links a crawler can follow.** Product cards and store rows are real
   `<a href>` elements now. They were `<div>`s with click handlers, which a
   crawler cannot follow at all — so even once the paths existed, nothing on the
   site would have led to them.
3. **Content that survives without a full boot.** The app fetches the whole
   catalogue (~50 requests) before it can draw one product, which is more than a
   crawler's renderer will wait for. `build.mjs` therefore prerenders the
   indexable groups to static HTML — name, price per chain, links, `Product` /
   `AggregateOffer` JSON-LD — and the app boots over the top and replaces it
   (`render()` clears `#app`), so visitors still get live prices.

`setMeta()` rewrites the title, description, canonical and OG/Twitter pair on
every route, because pages sharing those get folded together as duplicates —
which would have undone (1). A `/vare/…` screen **canonicalises to its group**:
it is one chain's slice of a page the group already covers in full, and
splitting the ranking signal four ways over near-identical text helps nobody.

`build.mjs` prerenders and lists the groups **at least two chains carry**
(~4 900 of ~36 700). Those answer the question the site exists for — who has
this cheapest — while the ~32 000 single-store groups stay crawlable on their
own paths but are kept out of the sitemap: submitting them from a young domain
spends crawl budget on the site's weakest pages. `MIN_STORES` moves that line.
The build is **fail-soft** — no network, no Supabase, a shape change — it warns,
exits 0, and leaves the committed fallback sitemap in place, because a price
site that cannot deploy when its database blinks is worse off than one serving
last week's prerender.

**IndexNow.** A sitemap is an invitation; IndexNow is a push, and it is how Bing
— and ChatGPT Search, which reads Bing's index — hears about a price change in
hours rather than days. The last thing `build.mjs` does is submit the URLs that
actually moved.

*Actually moved* is the whole design. Prices refresh weekly
(`supabase/cron.sql`, Monday 04:00 UTC) while the build runs on every push, so
submitting all ~4 900 URLs each time would be mostly "nothing changed" pings and
eventually a `429`. So each page gets a **fingerprint of the answer it gives** —
the name and every chain's price, store-sorted — not of the bytes it ships;
hashing the HTML would mark all ~4 900 pages dirty the moment anyone touched the
shell in `index.html`. The fingerprints are written to `indexnow-manifest.txt`
alongside the pages, and the next build reads the previous copy **off the live
site**, since Vercel builds from a fresh clone and nothing else survives.

Three outcomes, deliberately different: a `404` on that manifest means the first
run and everything is new, so everything is submitted; a network failure means
we do not know what changed, and the safe answer is to submit nothing; anything
else is a normal diff.

The manifest is a **receipt, not a log** — it is written only when the ping went
through, or when there was nothing to send. Writing it after a skipped ping is
the one mistake that makes the whole thing quietly stop working: the next build
would diff against a baseline Bing never received, conclude nothing changed, and
lose the submission for good. Leaving no manifest instead makes the next
production build see a `404`, treat it as a first run, and send the lot. That is
also what covers the chicken-and-egg on the very first deploy — the key file is
a static asset that ships *with* the deploy, so it is not servable while that
deploy's build is still running, and the build checks it is live before pinging.

Only `VERCEL_ENV=production` pings at all — a preview build renders the same URLs
from the same catalogue, and letting it submit would tell Bing production changed
when nothing shipped. The ping is wrapped so it can never fail a deploy: the
pages are already written and served by then.

Rotating the key means changing `INDEXNOW_KEY` and renaming `<key>.txt` in one
commit — they are two halves of the same proof of ownership.

**Expect the first ping on a new key to come back `403`, and do not go looking
for a bug.** `403` is "invalid key", but the key file being live is not the same
as Bing having fetched it: the build's own `keyIsLive()` check passes while the
submission is still rejected, because the two look at it from different ends.
Measured when this shipped — the key went live at 08:30, the build submitted
4 948 URLs at 08:37 and got `403`, and the identical request returned `200` four
minutes later. Nothing was wrong and nothing needed fixing.

This is the case the receipt rule above exists for. The rejected ping wrote no
manifest, which left the next production build looking at a `404` and sending
the whole set again — so the recovery is automatic and the right move is to wait
for the next deploy. Had the manifest been written anyway, those ~4 900 URLs
would have been lost for good behind one line in a build log.

Asset URLs in `index.html` must stay **root-relative**: on `/gruppe/helmelk` a
bare `app.js` resolves to `/gruppe/app.js`, which falls through to the SPA
rewrite and returns the HTML shell as JavaScript.

The rewrites in `vercel.json` point at **`/`, not `/index.html`** — and that is
not a stylistic choice. `cleanUrls: true` turns `/index.html` into a 308
redirect to `/`, so it is not a servable path; a rewrite whose destination is a
redirect cannot resolve, and Vercel answers **404**. Shipped with
`/index.html` this was silent in every local check and in the unit tests —
`/gruppe/…` still worked in production because the *prerendered files* were
being served straight off the filesystem, which happens before rewrites are
consulted. What it actually broke was every path with no file behind it:
`/liste`, `/om`, `/skann`, all `/vare/…`, and every single-store group. If a
deep link 404s after a routing change, check this line first — and check it
against a path that is **not** prerendered, since a prerendered one will pass
whether the rewrites work or not.

**PWA.** The site is an installable PWA: `manifest.webmanifest` + a service worker
(`sw.js`) that caches the app shell for offline use with a stale-while-revalidate
strategy (a deploy is picked up on the next load), while every cross-origin
Supabase request stays network-only so prices are never served stale.

**Cold-start, offline data & egress.** The catalogue is ~49 500 offer rows —
~16 MB of JSON, ~2 MB over the wire once gzipped — so re-downloading it on every
visit is slow on mobile and burns Supabase egress. It is snapshotted
into the **Cache Storage API** (`prisboka-catalog-v4` — the big offers blob, which
would blow the ~5 MB `localStorage` cap) with a small meta record in
`localStorage` (`prisboka_catalog_meta_v5`: timestamp, the tiny stores list,
freshness stamp). The snapshot version is bumped whenever the rows' **shape or
order** changes — v4 because the row order became data (newest-first is what
"Nyeste først" sorts on), v3 because `image_url` gave way to `has_image`. Boot:
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

**Paging the catalogue in parallel.** PostgREST caps a response at 1000 rows, so
the catalogue takes ~50 requests. They used to be *chained* — each page waited
for the one before it, making a cold start ~50 serialised round trips of pure
latency before anything could paint. Now the first page doubles as a count probe
(`Prefer: count=exact` → `Content-Range: 0-999/49584`, which Supabase exposes to
the browser via `Access-Control-Expose-Headers`), and the remaining ~49 pages go
out `OFFER_LANES` (6) at a time. Same bytes, a fraction of the wall clock:
measured against the live API, 16 s → 6 s even on a fast datacentre link, and the
gap widens the worse the round-trip time gets. If the count header is ever
missing the old serial paging still runs as a fallback, and because rows can be
appended between the count and the last page, a final full page triggers a
mop-up rather than being trusted as the end.

**Product photos load per screen.** `image_url` was 498 kB of the 1697 kB
gzipped catalogue — 29 % of the cold start — and it cannot be compressed away:
gzip already collapses the shared `bilder.ngdata.no` prefix, and what remains is
EAN entropy. (Hand-packing the URLs into a compact token was built, measured at
**0.8 %**, and thrown away again.) So the bytes are *moved* rather than shrunk.
A screen shows at most 58 products against ~47 700 photos, so boot pages through
the **`ml_catalog`** view — the catalogue minus the photos — and the URLs come
from **`ml_group_images`** for the groups on screen, one round trip per render
(chunked 40 group keys at a time). Boot drops **1697 kB → 1208 kB (−29 %)**.

**`group_key` is derived, not shipped.** With the photos gone, the payload was
`product_name` (42 %), `group_key` (31 %) and `price` (14 %) — measured by
dropping one column at a time and re-reading the gzipped stream, not by adding
up raw bytes, which is a different and misleading number. `group_key` is
`ml_group_key(product_name)`: a pure `IMMUTABLE` text transform. So 372 kB of
every cold start was spent shipping something the client can compute.
`mlGroupKey()` in `app.js` computes it. Boot drops another **1208 kB → 837 kB
(−31 %)**, and **1710 kB → 837 kB (−51 %)** since the beginning.

That buys the payload at the cost of an invariant across two languages, and a
quiet one: `group_key` is what the price-history and photo lookups join on, so
if the SQL and the JS drift the lookups return nothing rather than fail. Three
things hold it together:

- **`test/group-key.test.js`** pins the JS against 164 `(product_name →
  group_key)` pairs captured verbatim from the database — the SQL function's own
  output, not this code's — chosen to cover every rule: each unit token, each
  brand word, percentages, Norwegian letters, punctuation, bare digits, decimal
  commas, spacing. Rules the catalogue happens not to contain (`hg`, `kop`,
  `x-tra`, `anglamark`, `synnove`) are pinned by hand so they cannot rot unused.
- **The warning lives on the SQL function itself** (`comment on function`), so
  it surfaces in `\df+` and in the dashboard for whoever edits it next, rather
  than only in this file.
- Verified across the whole catalogue: rebuilding all **37 703 groups** from
  rows with the column stripped produces the identical set of `serverKeys` for
  every group — 0 missing, 0 added, 0 differing.

The `o.group_key ||` arm in `buildVariant` is not dead code: a snapshot written
before the column was dropped still carries one, so honouring it keeps those
visits identical instead of forcing the 12 h cache to be invalidated.

Two things measured and *not* done:

- **Filtering out rows the client discards.** There are none — the five chains'
  rows are all wanted (meny 40 555, kiwi 5 783, rema 1 868, oda 1 246,
  extra 132), so nothing is downloaded and thrown away. Those counts are the
  snapshot this measurement was taken against; `oda` in particular grows about
  fourfold once the rewritten ingest sweeps, so the payload figures quoted here
  are a floor. The conclusion is unchanged — the extra rows are ones the client
  wants — but re-measure the sizes before quoting them again.
- **Brotli.** Supabase serves it, and it would take 1208 kB → 1128 kB (7 %). But
  when a browser offers `br, gzip` the server picks gzip, and `fetch()` cannot
  override `Accept-Encoding` — it is a forbidden header name. Not reachable from
  the client.

Three things keep that invisible:
- **`has_image` travels with the row**, so the image frame is reserved before
  the URL lands. Nothing shifts when photos arrive, and the 1 830 products with
  no photo still get no frame — as before.
- **The lookup ranks packs exactly as the catalogue does**, reading a pack's
  size out of its *name* and only then falling back to the `unit_price` column.
  That is not pedantry: one product can arrive from two feeds under the same
  name and price with different photos (kassalapp `…/large.jpg`, ngdata
  `…/medium.png` for one EAN) where only one feed fills `unit_price`. Ranking on
  the column alone showed the other pack's photo for 209 of 37 703 groups.
- **Photos seen once are kept in `localStorage`**, so a return visit paints them
  immediately and they survive offline. The cap bounds what is *persisted*, never
  the live map — trimming the map itself blanked photos on screens that were
  showing them.

Verified against the full catalogue rather than a sample: rebuilding all 37 703
groups and 43 193 variants through the lookup reproduces the photo the inline
column gave, for every single one, with zero frame-reservation mismatches. (A
1000-row slice cannot show this — the photo lookup spans the whole table while
the slice does not, so a slice reports differences that do not exist in the app.)

**Connection warm-up.** `index.html` `preconnect`s to Supabase and the two Google
Fonts origins, so those DNS + TLS handshakes overlap the HTML parse instead of
following it. The font stylesheet is also `<link>`ed from the head even though
`styles.css` `@import`s it — the design system owns that file, and an `@import`
can only be discovered *after* `styles.css` has downloaded and parsed, so linking
it starts the identical request a round trip earlier (the browser coalesces the
two). `vercel.json` gives `app.js` / `styles.css` / the manifest
`max-age=0, stale-while-revalidate=86400`: the filenames are unhashed so they
must not be cached outright, but Vercel's default `must-revalidate` made every
load pay a blocking conditional request per asset. Now the browser paints from
cache and revalidates behind it.

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
focus/selection preservation for text inputs. Screens are **path-routed**
(History API) so every product is its own URL — shareable, crawlable, and
working with back/forward.

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
- If Gemini is unavailable or finds nothing, the flow returns to the upload
  screen with an error — there is no hand-typed fallback (see above).

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

### Næringsinnhold (Matvaretabellen)

**Where it comes from.** Mattilsynet publishes the Norwegian food composition
table as open data at `https://www.matvaretabellen.no/api/` — 2 121 foods, ~100
measured constituents each, **13,6 MB of JSON**, revised about once a year.
`tools/build-nutrition.mjs` fetches it, throws away what a price site cannot
use (the ~60 individual fatty acids, LanguaL codes, latin names, per-value
source ids) and writes `nutrition.json`: 2 121 foods × 36 nutrients, one food
per line, **510 kB** — ~120 kB gzipped over the wire.

That file is **committed, not built at deploy time**. The table moves yearly
while this repo deploys several times a week, a committed copy makes the tests
hermetic, and a line-per-food layout means a regeneration shows up in review as
*"salt in kjøttdeig went from 1,1 to 0,9"* rather than as one 510 kB line.
Regenerating is the update path:

```bash
node tools/build-nutrition.mjs --dry   # print the diff, write nothing
node tools/build-nutrition.mjs         # rewrite nutrition.json
```

Attribution is not optional — Mattilsynet requires a visible source line — so
the citation travels *inside* the payload (`source`) and the product page
prints it verbatim: **Matvaretabellen 2026. Mattilsynet. www.matvaretabellen.no**.

The app fetches `/nutrition.json` **once, lazily**, on the first product page a
visit opens; the service worker then caches it like any other same-origin asset
(stale-while-revalidate), so it is free on every later visit and works offline.
Nothing on the front page, the list or the category pages pays for it.

**Joining two datasets that share no key.** The leksikon holds ~37 500 branded
packs (*"Kyllingfilet Naturell 800g Prior"*); Matvaretabellen holds 2 121
generic foods (*"Kylling, filet, uten skinn, rå"*). No EAN, id or key joins
them — only the names. So `matchNutrition` is a heuristic, and it is built to
be **right or silent**: a shopper reading a nutrition table has no way to tell
a good match from a confident-looking wrong one.

1. **The head gate.** The first word of a Matvaretabellen name is what the food
   *is*; everything after the first comma only qualifies it. If the product
   name does not carry that word, this is not that food — however many
   qualifiers happen to line up. The compound rules are the ones `POPULAR`
   already matches categories with, for the same reason: Norwegian puts the
   meaning in the **tail** of a compound, so `lettmelk` is milk and
   `melkesjokolade` is not. The one exception is the shape a Norwegian product
   name actually uses — `kyllingfilet` for *"Kylling, filet"* — and it counts
   only when **both** halves of the compound are that food's own words, which
   is exactly what keeps `melkesjokolade` off the milk entry.
2. **Scoring.** A qualifier that lands is worth more than one that misses
   costs, or the table's most precisely described foods could never win. A miss
   in the head segment costs double (*"Fløtegratinerte poteter"* is not
   poteter) and an unmatched **preparation** costs triple — someone buying a
   fillet wants the raw numbers, not the pan-fried ones. Ties go to raw over
   cooked, generic over branded, bought over home-made, then the shortest name.
3. **Coverage.** Half of what the product says has to be explained by the food.
   Matvaretabellen has a mango and *"Jordan mango mint tannkrem"* says "mango",
   but a toothpaste is not a mango.
4. **A floor.** `MIN_SCORE = 12`, calibrated against the 5 075 groups at least
   two chains carry. The band just underneath is where a box of Carlsberg wants
   to be *"Dessert-topping på boks"* and a halogen bulb wants to be a *pære*.

**963 of the 4 926 prerendered product pages** (~20 %) clear all four. The rest
get no section at all, which is the correct answer for a table that does not
contain branded snacks, soft drinks or washing-up brushes. `test/nutrition.test.js`
pins both directions — the matches that must land, and the six near-misses that
must not — against the committed `nutrition.json`, so a regeneration that broke
either is caught by `node --test`.

**On the page,** the match is always **named and linked** to its page on
matvaretabellen.no, above a note that the numbers are a generic food and not
this pack's own declaration. A value the table never analysed for that food
prints as **"–"**, never as 0 — they are not the same claim. The same matcher
runs in `build.mjs`, so the prerendered HTML carries the table too (*"hvor mye
protein er det i kyllingfilet"* is a query, and an answer that only exists
after 500 kB has downloaded is one no crawler waits for) and the static page
names the same food the live one does. Nutrition is deliberately **outside**
`groupFingerprint`: a new edition of the table would otherwise re-submit ~5 000
URLs to IndexNow because a vitamin figure moved, which is the firehose the
manifest exists to prevent.

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
  formerly Kolonial.no) via its public product search API (keyless), with
  product images. Oda is a single online store → the `oda` chain. It
  **self-chains** like the Kassalapp sweep, checkpointing a term index in
  `ml_sweep_state` under `name='oda'`, because paging every term is 274
  requests — measured at 137 s end to end, which one invocation's 95 s budget
  does not hold. Two links in practice, not the three or four first estimated
  from a slower sample.

  Four things the rewrite fixed, each of which had been losing rows or
  inventing them:

  - **Paging.** `/search/mixed/` returned 33 items of mixed types (categories
    and recipes among them) and the ingest kept page 1. `/search/?q=` is
    products-only, reports `total_hits`, and pages 40 at a time: 1 244 → 4 735 rows
    products. Two limits found by probing and respected in the code: page 50
    answers **422** (so ~1 960 products is the ceiling for any one query), and
    `filters=`/`category=` are accepted and silently **ignored** — there is no
    category listing endpoint, so a term list is the only way in.
  - **Identity.** Oda's `full_name` does not state the pack size — it lives in
    `name_extra` — so "Tine Lettmelk 1% fett" is *both* the 1 l and the 1,75 l
    carton. The old `external_id` was a slug of that name: 106 slugs collided
    and **117 products were silently dropped**. The row now keys on Oda's own
    numeric `id`, which is unique across all 4 913.
  - **The size in the name.** Only the bare size token from `name_extra` is
    appended ("… 1,75 l"), never the whole field. `name_extra` also carries
    purchase limits ("Maks 10 per kunde") and hedges ("ca."), and folding those
    in moved the `group_key` of **301 of 4 913** products — Pepsi Max, Solo,
    Grandiosa, Norvegia among them — which would have unpicked exactly the
    popular lines from every other chain's rows in their group. Appending the
    size alone is invisible to `group_key`, which strips sizes: measured 0 keys
    changed, and 0 duplicate names left.
  - **Before-prices.** The old comment said Oda exposes none. It exposes three
    kinds and only one is a markdown: `price_discount` (130 seen, 110 quoting a
    genuinely higher `undiscounted_gross_price`) against `fixed_price_bundle`
    (60) and `mix_and_match` (54), which quote undiscounted **equal to** the
    shelf price because the saving needs three in the basket. Only
    `price_discount` becomes a `pre_price`, so Oda offers now chart and badge
    like the other chains' without inventing a drop that never happened.

  It also stops sending a copied Chrome `User-Agent`. oda.com/robots.txt asks
  crawlers in so many words for a UA carrying "bot", a program name and a
  contact, and for exponential backoff honouring `Retry-After` on 429/5xx —
  both of which the function now does.

  **Measured and not done: sweeping Oda's own category taxonomy.** Oda's
  sitemap publishes all 814 categories, and searching their names does reach
  further — 100 of them took the union to 6 392 of the ~7 214 products Oda
  will admit to. It cost **2 393 requests for 1 479 new products** (0.6 per
  request, against the curated terms' 17.9), because category names are broad
  and each one pages 24 deep into the same goods the last one found. The tail
  it buys is also largely not food: the taxonomy includes `barneboker`,
  `pocket`, `quiz-og-sudoku`, `spill-og-puslespill` and `blomster-og-planter`.
  Thirty times the requests for a worse catalogue, so the term list stays
  curated.

All run weekly via `pg_cron` (offers 04:00, Kassalapp 04:10, ngdata 04:20,
Oda 04:30 UTC every Monday = ~06:00–06:30 Oslo), and both self-chaining sweeps
have a `*/10 4-9 * * 1` watchdog behind them. See `supabase/cron.sql`.

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
`pathname` changes, and it listens to `pushState`/`popstate` but never
`hashchange`. Before the screens moved onto real paths that meant it saw
*nothing* — the app changed only the hash, so a whole visit was one `/`. Now
that navigation is `pushState`, the tracker would in fact follow along on its
own; auto-tracking stays off anyway, for two reasons that outlast the routing
change. `route` (the pattern a screen belongs to) is ours to attach and the
tracker knows nothing about it, and `/liste#d=…` moves without touching the
pathname, so the tracker would miss it. `data-disable-auto-track` on the script
tag plus `trackView()` in `app.js` keeps one reporter rather than two racing:

| Screen | `path` | `route` |
| --- | --- | --- |
| `/` and anything unrecognised | `/` | `/` |
| `/gruppe/melk-lett` | `/gruppe/melk-lett` | `/gruppe/[gruppe]` |
| `/vare/melk-lett/kiwi` | `/vare/melk-lett/kiwi` | `/vare/[gruppe]/[butikk]` |
| `/skann`, `/om`, `/liste` | `/skann`, `/om`, `/liste` | same |

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
  `path` is set — and on `/liste#d=…` the hash *is* the visitor's shopping
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

**2. DNS** — `prisboka.no` is registered outside Vercel, but its nameservers now
point at **Vercel DNS** (`ns1.vercel-dns.com` / `ns2.vercel-dns.com`, verified
against two public resolvers), so the records live in Vercel's DNS panel rather
than at the registrar:

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

### Support email

`support@prisboka.no` — shown in the footer ("Kontakt") and in section 04 of the
Om page, and duplicated in `index.html`'s JSON-LD `Organization.email`. It is
defined once as `SUPPORT_EMAIL` in `app.js`; change all three together.

The address is **forwarding-only**: mail sent to it lands in a personal inbox,
and nothing is hosted at the domain. Two consequences worth keeping in mind:

- **You cannot reply *as* `support@prisboka.no`** on a free forwarding tier —
  sending requires an SMTP relay, which is the paid part of every one of these
  services. A reply will come from whatever inbox the mail forwarded into,
  unless that is set up separately. The Om page therefore promises a response,
  not a response *from this address*.
- **Forwarding breaks SPF for the original sender.** That is inherent to
  forwarding, not a misconfiguration; the SPF record below covers it for mail
  the forwarder re-sends.

**DNS.** The nameservers are Vercel's, so the records live in Vercel's DNS panel
— not at the registrar, and not in `vercel.json` (which only sets HTTP headers
and redirects; it cannot express DNS).

Forwarding runs on **[ImprovMX](https://improvmx.com)** (free tier: 1 domain,
25 aliases, forwarding only). These are the records in place, verified live:

| Name | Type | Priority | Value |
| --- | --- | --- | --- |
| `@` | `MX` | 10 | `mx1.improvmx.com` |
| `@` | `MX` | 20 | `mx2.improvmx.com` |
| `@` | `TXT` | — | `v=spf1 include:spf.improvmx.com ~all` |

The priorities differ on purpose: `mx1` is primary and `mx2` the backup, so they
are not interchangeable the way equal-priority peers would be.

**Exactly one SPF record.** More than one `v=spf1` TXT on a domain is a
permanent error under RFC 7208 and disables SPF evaluation entirely rather than
merging the two — so a second forwarding provider cannot simply be added
alongside. Switching providers means replacing the MX *and* the SPF record
together, which is what happened here: an earlier Forward Email setup
(`mx1`/`mx2.forwardemail.net` plus its own `v=spf1 … -all` and a
`forward-email=` routing record) was removed rather than left in place. Note
also that ImprovMX ends its SPF in `~all` (softfail) where Forward Email used
`-all` (hardfail); that is each provider's own recommended value, not a setting
to normalise.

The free tier's **one-domain limit** is worth re-checking after any change — if
that slot previously held a different domain, pointing it at `prisboka.no` may
have taken forwarding away from the other one.

Verify:

```bash
dig +short MX prisboka.no          # expect mx1 (10) and mx2 (20) improvmx.com
dig +short TXT prisboka.no         # expect exactly ONE v=spf1 line
```

Then send a real message to `support@prisboka.no` and confirm it arrives — the
records resolving is not proof that delivery works.

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
- **Egress.** A cold visit downloads the whole catalogue (~16 MB uncompressed,
  ~840 kB gzipped over the wire since the photos and group_key moved out), which is why the
  12 h snapshot cache exists. Watch Supabase egress if traffic grows; the lever
  is the TTL and the column list in `OFFER_COLS` / the `ml_catalog` view.
- **The cron jobs are scheduled and active** (`select jobname, schedule, active
  from cron.job`), and the `pg_net` → Edge Function path is proven by the 200s
  in `net._http_response`. `cron.job_run_details` is empty only because the
  jobs were scheduled after the most recent Monday.
