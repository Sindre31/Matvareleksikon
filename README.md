# Prisboka — Matvareleksikon med pristrender

A community-sourced grocery-price encyclopedia for the Norwegian chains
Rema 1000, Kiwi, Extra and Meny. Search a product, see what it costs per
store, where the price is heading, and contribute new prices by "scanning"
a receipt.

This repository is the runnable implementation of the Claude Design
prototype [`Matvareleksikon.dc.html`](https://claude.ai/design/p/d6005f67-13a3-49c0-8738-55a4696310a9),
built on the **Industry** design system.

## Run it

It's a static site — no build step, no dependencies.

```bash
# any static file server, e.g.
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly (`file://`) also works; the only thing that
needs a network is the Google Fonts import in `styles.css` (Barlow / Barlow
Condensed), which falls back to `system-ui` offline.

## What's here

| File | Role |
| --- | --- |
| `index.html` | App shell — loads the design system and the app |
| `styles.css` | The **Industry** design system (tokens + components). Source of truth for the look; do not hard-code values it already carries. |
| `app.js` | The application: data model, price/trend math, and the three screens, rendered dependency-free |
| `design/` | The imported Claude Design source, kept for provenance |
| `design/Matvareleksikon.dc.html` | The original `.dc.html` prototype (the spec) |
| `design/support.js` | The `dc-runtime` the prototype ran on |
| `design/_ds/…/` | The Industry design-system bundle as imported |

## Screens

- **Leksikon (home)** — hero + live search, the month's largest price
  moves (up / down, hidden while searching), category filters, and the
  full product grid.
- **Produktside** — per-store prices with the cheapest flagged, and a
  12-month price-trend line chart per store. A 6/12-month toggle exposes
  the prototype's `chartMonths` option.
- **Skann kvittering** — the contribution flow: upload or (simulated)
  camera → reading progress → editable line items with store/place → done,
  which adds the prices to the running total.

## Implementation notes

The prototype's `Component` (a React-based `DCLogic` class rendered by the
`dc-runtime`) is ported to plain JavaScript in `app.js`. The state shape,
the `STORES` / `PRODUCTS` data, and the `priceAt()` / `chartFor()` /
`scanReceipt()` computations are reproduced 1:1, so the numbers match the
design exactly. Rendering is a small SVG-aware hyperscript with full
re-render on state change and focus/selection preservation for the text
inputs. All prices are deterministic mock data (no backend).
