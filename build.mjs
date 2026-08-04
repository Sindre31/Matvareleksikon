/*
 * Prisboka build step — prerendered product pages and a real sitemap.
 *
 * Why this exists at all: the app fetches the whole catalogue (≈50 requests,
 * a few MB) before it can draw a single product. A browser happily waits for
 * that; a crawler's renderer does not, and a page whose content arrives only
 * after fifty round trips is a page that gets indexed as an empty shell — if
 * it gets indexed at all. So the pages worth finding are written out as static
 * HTML with the product name, the price in every chain and the links already
 * in the markup. The app boots over the top and replaces it (render() clears
 * #app), so a visitor still gets the live, interactive version and prices that
 * are never staler than the network.
 *
 * Which pages: the groups at least two chains carry. Those are the ones that
 * answer the question the site exists for ("who has this cheapest?") and the
 * ones people search for. The ~34 000 single-store groups stay crawlable on
 * their own paths but are left out of both the prerender and the sitemap —
 * submitting 39 000 near-empty pages from a young domain buys crawl budget
 * spent on the weakest thing the site has. Change MIN_STORES to widen it.
 *
 * Fail-soft by design: no network, no Supabase, a shape change in the API —
 * the build logs it and exits 0 with the committed sitemap left in place. A
 * price site that cannot deploy because its database blinked is worse off than
 * one serving last week's prerender.
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const app = require('./app.js');

const ORIGIN = 'https://prisboka.no';
const SUPABASE_URL = 'https://jiaxeedguivvhixychcg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_trP_tgjyaPU-2eJ7n9JX4w_Q7kIvDPC';
// Same columns app.js asks for, so the build groups products exactly the way
// the running site does — a prerendered page that disagreed with the app it
// hands over to would be worse than no prerender.
const COLS = 'store_id,product_name,price,pre_price,unit,unit_price,unit_price_unit,offer_days,valid_until,has_image';
const PAGE = 1000;         // PostgREST caps a response at 1000 rows
const MIN_STORES = 2;      // prerender + sitemap threshold
const OUT = path.dirname(new URL(import.meta.url).pathname);

const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

async function sb(pathAndQuery) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${pathAndQuery}`, { headers });
  if (!res.ok) throw new Error(`${pathAndQuery} → ${res.status}`);
  return res.json();
}

async function fetchCatalogue() {
  const stores = await sb('/ml_stores?select=*&order=sort_order');
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await sb(`/ml_catalog?select=${COLS}&order=fetched_at.desc,external_id&limit=${PAGE}&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return { stores, rows };
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Norwegian price formatting, matching what the app renders.
const nf = (n) => Number(n).toFixed(2).replace('.', ',').replace(/,00$/, ',-');

function cheapest(g) {
  return g.variants.reduce((a, b) => (b.price < a.price ? b : a));
}

function pageMeta(g) {
  const best = cheapest(g);
  return {
    title: `${g.name} — pris i butikkene | Prisboka`,
    desc: `Hva koster ${g.name.toLowerCase()}? Billigst nå ${nf(best.price)} hos ${best.storeName}. `
      + `Sammenlign ${g.storeCount} butikker, se prishistorikk og pris per kg/l.`,
    canonical: `${ORIGIN}${app.groupPath(g.key)}`
  };
}

// Product/AggregateOffer — the same shape app.js publishes once it has data,
// written into the HTML so it is readable without running any JavaScript.
function productLd(g) {
  const prices = g.variants.map((v) => v.price).filter((p) => Number.isFinite(p) && p > 0);
  const url = `${ORIGIN}${app.groupPath(g.key)}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': `${url}#product`,
    name: g.name,
    url,
    category: 'Dagligvarer',
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'NOK',
      lowPrice: Math.min(...prices),
      highPrice: Math.max(...prices),
      offerCount: g.variants.length,
      offers: g.variants.map((v) => ({
        '@type': 'Offer',
        name: v.rawName,
        price: v.price,
        priceCurrency: 'NOK',
        availability: 'https://schema.org/InStock',
        url: `${ORIGIN}${app.variantPath(g.key, v.storeId)}`,
        seller: { '@type': 'Organization', name: v.storeName }
      }))
    }
  };
}

// The visible fallback. Real content rather than a spinner: the name as the
// page's one <h1>, every chain's price as text, and anchors a crawler can walk
// to the per-store pages and onward to related products. The app clears all of
// it on first render, so this is what non-JS clients and slow renderers see.
function bodyHtml(g, related) {
  const rows = g.variants
    .slice()
    .sort((a, b) => a.price - b.price)
    .map((v) => `<li><a href="${esc(app.variantPath(g.key, v.storeId))}">`
      + `<strong>${esc(v.storeName)}</strong> — ${esc(nf(v.price))}`
      + (v.perUnit != null ? ` (${esc(nf(v.perUnit))} per ${esc(v.unitDim)})` : '')
      + `</a> <span>${esc(v.rawName)}</span></li>`)
    .join('\n      ');
  const links = related
    .map((r) => `<li><a href="${esc(app.groupPath(r.key))}">${esc(r.name)}</a></li>`)
    .join('\n      ');
  return `<article>
    <p><a href="/">Prisboka</a> › Leksikon</p>
    <h1>${esc(g.name)}</h1>
    <p>Pris i ${g.storeCount} ${g.storeCount === 1 ? 'butikk' : 'butikker'}, billigst først.
       Prisene kommer fra kjedenes tilbudsaviser og fra kvitteringer folk skanner.</p>
    <ul>
      ${rows}
    </ul>
    <p><a href="/liste">Handleliste</a> · <a href="/skann">Bidra med priser</a> · <a href="/om">Om Prisboka</a></p>
    <h2>Andre varer i leksikonet</h2>
    <ul>
      ${links}
    </ul>
  </article>`;
}

// Rewrites the committed index.html rather than templating a second copy of
// the <head>. The shell owns the design system, the CSP-safe script tags and
// the preconnects; duplicating it here would mean every future change to
// index.html silently skipping ~5 000 pages.
function renderPage(shell, g, related) {
  const m = pageMeta(g);
  let html = shell;
  const swap = (re, replacement) => { html = html.replace(re, replacement); };

  swap(/<title>[\s\S]*?<\/title>/, `<title>${esc(m.title)}</title>`);
  swap(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(m.desc)}">`);
  swap(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${esc(m.canonical)}">`);
  swap(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(m.title)}">`);
  swap(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(m.desc)}">`);
  swap(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${esc(m.canonical)}">`);
  swap(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${esc(m.title)}">`);
  swap(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${esc(m.desc)}">`);
  swap(/<meta property="og:type" content="[^"]*">/, '<meta property="og:type" content="product">');

  // og:type product wants a price alongside it, and the same block is what
  // carries the offer into a search result.
  const ld = `<script type="application/ld+json" id="ld-product">${JSON.stringify(productLd(g))}</script>`;
  swap(/<\/head>/, `  ${ld}\n</head>`);
  swap(/<div id="app"><\/div>/, `<div id="app">${bodyHtml(g, related)}</div>`);
  return html;
}

function sitemapXml(groups) {
  const urls = [
    { loc: `${ORIGIN}/`, priority: '1.0', changefreq: 'daily' },
    { loc: `${ORIGIN}/om`, priority: '0.3', changefreq: 'monthly' },
    { loc: `${ORIGIN}/skann`, priority: '0.5', changefreq: 'monthly' },
    ...groups.map((g) => ({ loc: `${ORIGIN}${app.groupPath(g.key)}`, priority: '0.7', changefreq: 'weekly' }))
  ];
  // /liste is a visitor's own basket and /vare/* is one chain's slice of a page
  // the group already covers (it canonicalises there) — neither is submitted.
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>
    <loc>${u.loc}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;
}

async function main() {
  const shell = await readFile(path.join(OUT, 'index.html'), 'utf8');

  let stores, rows;
  try {
    ({ stores, rows } = await fetchCatalogue());
  } catch (err) {
    console.warn(`build: catalogue unavailable (${err.message}) — keeping the committed sitemap, skipping prerender.`);
    return;
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    console.warn('build: catalogue came back empty — keeping the committed sitemap, skipping prerender.');
    return;
  }

  // Mirror applyCatalog(): hide the chains without real coverage, so a
  // prerendered page never quotes a store the running app won't show.
  const covered = app.coveredStores(rows);
  const narrow = Object.keys(covered).length > 0;
  app.buildStores(stores, narrow ? covered : null);
  const built = app.buildGroups(narrow ? rows.filter((o) => o && covered[o.store_id]) : rows);
  const groups = (Array.isArray(built) ? built : Object.values(built))
    .filter((g) => g && g.key && g.name && g.variants && g.variants.length);

  const indexable = groups
    .filter((g) => g.storeCount >= MIN_STORES)
    .sort((a, b) => a.key.localeCompare(b.key, 'nb'));

  await writeFile(path.join(OUT, 'sitemap.xml'), sitemapXml(indexable));

  await mkdir(path.join(OUT, 'gruppe'), { recursive: true });
  for (let i = 0; i < indexable.length; i++) {
    const g = indexable[i];
    // A handful of neighbours in the sorted list, so every prerendered page
    // links onward to others. Without that the pages are 5 000 orphans that
    // only the sitemap knows about, and internal links are most of what tells
    // a crawler which of them matter.
    const related = [];
    for (let d = 1; related.length < 6 && d < indexable.length; d++) {
      const before = indexable[i - d], after = indexable[i + d];
      if (before) related.push(before);
      if (after && related.length < 6) related.push(after);
      if (!before && !after) break;
    }
    // cleanUrls serves gruppe/<slug>.html at /gruppe/<slug>.
    await writeFile(path.join(OUT, 'gruppe', `${app.slugFor(g.key)}.html`), renderPage(shell, g, related));
  }

  console.log(`build: ${rows.length} rader → ${groups.length} grupper, `
    + `${indexable.length} forhåndsrendret (≥${MIN_STORES} butikker) og lagt i sitemap.`);
}

main().catch((err) => {
  // Never fail the deploy over the SEO layer.
  console.warn(`build: ${err && err.stack ? err.stack : err}`);
});
