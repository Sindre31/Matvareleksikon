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
 *
 * Last step, once the pages are written: IndexNow. A sitemap is an invitation
 * a crawler answers whenever it feels like it; IndexNow is a push, and Bing —
 * and therefore ChatGPT Search, which reads Bing's index — picks the change up
 * in hours instead of days. What it must not become is a firehose: prices move
 * once a week (supabase/cron.sql, Monday 04:00 UTC) while this build runs on
 * every push, so submitting all ~4 900 URLs each time would be thousands of
 * "nothing changed" pings and a 429 for spam. Hence the manifest — see
 * changedUrls() below for how the build works out what actually moved.
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
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

// IndexNow. The key is not a secret — the whole scheme is "prove you control
// the host by serving this string at a URL only you can write to", so the file
// and the constant have to match and both are public by design. Rotating means
// changing both in one commit.
const INDEXNOW_KEY = 'f7da145dc277cd658c2a75e91aeb6f32';
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
const INDEXNOW_BATCH = 10000;              // hard cap in the spec
const MANIFEST = 'indexnow-manifest.txt';  // written to OUT, served from the site root

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

// Næringsinnhold, in the prerendered markup for the same reason the prices
// are: "hvor mye protein er det i kyllingfilet" is a query, and an answer that
// only exists after the app has booted and fetched 500 kB is an answer no
// crawler waits for. Same matcher as the running app (app.matchNutrition), so
// the static page and the live one name the same food — and, like the app,
// nothing at all when the match isn't confident.
//
// Deliberately outside groupFingerprint(): these values move when Mattilsynet
// publishes a new edition, roughly once a year, and re-submitting ~5 000 URLs
// to IndexNow because a vitamin figure shifted is precisely the firehose the
// manifest exists to prevent. A product whose NAME changed moves its
// fingerprint already, and that is the change worth telling Bing about.
function nutritionHtml(nut, g) {
  if (!nut) return '';
  const hit = app.matchNutrition(nut.index, g.key);
  if (!hit) return '';
  const f = hit.food;
  const rows = [`<li>Energi — ${esc(app.nutNum(f.kcal, 0))} kcal (${esc(app.nutNum(f.kJ, 0))} kJ)</li>`];
  nut.index.nutrients.forEach((n, i) => {
    if (!n.decl) return;
    rows.push(`<li>${esc(n.indent ? `herav ${n.name.toLowerCase()}` : n.name)} — `
      + `${esc(app.nutNum(f.values[i], n.dec))} ${esc(n.unit)}</li>`);
  });
  return `<h2>Næringsinnhold per 100 g</h2>
    <p>Nærmeste oppslag i Matvaretabellen er
       <a href="https://www.matvaretabellen.no/${esc(f.slug)}/">${esc(f.name)}</a> — en generisk matvare,
       ikke varedeklarasjonen på akkurat denne pakningen.</p>
    <ul>
      ${rows.join('\n      ')}
    </ul>
    <p>Kilde: ${esc(nut.index.source)}.</p>`;
}

// The visible fallback. Real content rather than a spinner: the name as the
// page's one <h1>, every chain's price as text, and anchors a crawler can walk
// to the per-store pages and onward to related products. The app clears all of
// it on first render, so this is what non-JS clients and slow renderers see.
function bodyHtml(g, related, nut) {
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
    ${nutritionHtml(nut, g)}
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
function renderPage(shell, g, related, nut) {
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
  swap(/<div id="app"><\/div>/, `<div id="app">${bodyHtml(g, related, nut)}</div>`);
  return html;
}

// The category pages — "hva koster egg". These matter more per page than the
// product pages: one answers a whole query rather than a single product, and
// they are the only crawl path from the front page into the ~5 000 products
// that does not involve paging through all of them.
function renderCategoryPage(shell, c, groups) {
  const lower = c.title.toLowerCase();
  const url = `${ORIGIN}${app.categoryPath(c.slug)}`;
  // Cheapest pack in the category, and which product it is — the same choice
  // app.js makes, so the prerendered sentence and the live one agree.
  let low = null;
  for (const g of groups) for (const v of g.variants) if (!low || v.price < low.v.price) low = { v, g };

  const title = `Hva koster ${lower}? Pris i butikkene | Prisboka`;
  const desc = (low ? `Billigst nå ${nf(low.v.price)} hos ${low.v.storeName}. ` : '')
    + `Sammenlign prisen på ${lower} i norske dagligvarebutikker — ${groups.length} varer, `
    + 'med prishistorikk og pris per kg/l.';

  // ItemList rather than Product: the page is a ranked list of products, and
  // saying so is what lets a result show it as one.
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': `${url}#list`,
    name: `Hva koster ${lower}?`,
    url,
    numberOfItems: groups.length,
    itemListElement: groups.slice(0, 50).map((g, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: g.name,
      url: `${ORIGIN}${app.groupPath(g.key)}`
    }))
  };

  const rows = groups.map((g) => `<li><a href="${esc(app.groupPath(g.key))}">${esc(g.name)}</a>`
    + ` — fra ${esc(nf(g.minPrice))}`
    + (g.unitPrice != null ? ` (${esc(nf(g.unitPrice))} per ${esc(g.unitDim)})` : '')
    + `, ${g.storeCount} ${g.storeCount === 1 ? 'butikk' : 'butikker'}</li>`).join('\n      ');
  const others = app.CATEGORIES.filter((x) => x.slug !== c.slug)
    .map((x) => `<li><a href="${esc(app.categoryPath(x.slug))}">${esc(x.title)}</a></li>`).join('\n      ');

  const body = `<article>
    <p><a href="/">Prisboka</a> › Kategori</p>
    <h1>Hva koster ${esc(lower)}?</h1>
    <p>${low ? `Billigst nå er ${esc(low.g.name.toLowerCase())} til ${esc(nf(low.v.price))} hos ${esc(low.v.storeName)}. ` : ''}${groups.length} varer, rangert etter pris per kilo eller liter.
       Prisene kommer fra kjedenes tilbudsaviser og fra kvitteringer folk skanner.</p>
    <ul>
      ${rows}
    </ul>
    <h2>Andre kategorier</h2>
    <ul>
      ${others}
    </ul>
  </article>`;

  let html = shell;
  const swap = (re, replacement) => { html = html.replace(re, replacement); };
  swap(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  swap(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(desc)}">`);
  swap(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${esc(url)}">`);
  swap(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${esc(title)}">`);
  swap(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${esc(desc)}">`);
  swap(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${esc(url)}">`);
  swap(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${esc(title)}">`);
  swap(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${esc(desc)}">`);
  swap(/<\/head>/, `  <script type="application/ld+json" id="ld-product">${JSON.stringify(ld)}</script>\n</head>`);
  swap(/<div id="app"><\/div>/, `<div id="app">${body}</div>`);
  return html;
}

function sitemapXml(groups, categories) {
  const urls = [
    { loc: `${ORIGIN}/`, priority: '1.0', changefreq: 'daily' },
    { loc: `${ORIGIN}/om`, priority: '0.3', changefreq: 'monthly' },
    { loc: `${ORIGIN}/skann`, priority: '0.5', changefreq: 'monthly' },
    // Above the product pages: a category answers a whole query ("hva koster
    // egg") rather than one product, and it is the page the products hang off.
    ...categories.map((c) => ({ loc: `${ORIGIN}${app.categoryPath(c.slug)}`, priority: '0.9', changefreq: 'weekly' })),
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

// ---------------------------------------------------------------- IndexNow

// What makes a page "changed" is the answer it gives, not the bytes it ships.
// Hashing the rendered HTML would mark all ~4 900 pages dirty the moment
// anyone touches the shell in index.html — a CSS class rename would submit the
// whole site. So the fingerprint covers exactly the facts the page asserts:
// the name and every chain's price. Sorted by store, because buildGroups()
// orders variants by whatever came back from PostgREST first and a reordering
// is not a price change.
const fingerprint = (parts) => createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 12);

export function groupFingerprint(g) {
  const variants = g.variants
    .map((v) => `${v.storeId}:${v.price}:${v.perUnit ?? ''}`)
    .sort();
  return fingerprint([g.name, ...variants]);
}

export function categoryFingerprint(c, groups) {
  return fingerprint([c.title, ...groups.map((g) => `${g.key}:${g.minPrice}`).sort()]);
}

export const serialiseManifest = (m) => [...m].map(([url, fp]) => `${url} ${fp}`).join('\n') + '\n';

export function parseManifest(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const cut = line.lastIndexOf(' ');
    if (cut > 0) map.set(line.slice(0, cut), line.slice(cut + 1));
  }
  return map;
}

// The previous manifest comes off the live site, because that is the only copy
// that survives: Vercel builds from a fresh clone, and the manifest is build
// output, not source. One request buys the diff.
//
// The three outcomes are deliberately different. A 404 means this is the first
// build with IndexNow wired up and Bing has never seen these URLs — everything
// is new, submit it all. A network failure means we simply do not know what
// changed, and the safe answer there is to submit nothing: a missed ping costs
// a few days of latency, while guessing "everything" on every flaky fetch is
// the firehose we are trying to avoid.
async function previousManifest() {
  let res;
  try {
    res = await fetch(`${ORIGIN}/${MANIFEST}`);
  } catch (err) {
    return { map: null, why: err.message };
  }
  if (res.status === 404) return { map: new Map(), why: 'ingen manifest ennå — første kjøring' };
  if (!res.ok) return { map: null, why: `HTTP ${res.status}` };
  try {
    return { map: parseManifest(await res.text()) };
  } catch (err) {
    return { map: null, why: err.message };
  }
}

export function changedUrls(current, previous) {
  const changed = [];
  for (const [url, fp] of current) if (previous.get(url) !== fp) changed.push(url);
  // The front page lists the movers, so it is stale exactly when something
  // else is. It carries no fingerprint of its own — deriving one would mean
  // hashing the whole catalogue to learn what the pages already told us.
  if (changed.length) changed.unshift(`${ORIGIN}/`);
  return changed;
}

async function pingIndexNow(urls) {
  let ok = true;
  for (let i = 0; i < urls.length; i += INDEXNOW_BATCH) {
    const batch = urls.slice(i, i + INDEXNOW_BATCH);
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: new URL(ORIGIN).host,
        key: INDEXNOW_KEY,
        keyLocation: `${ORIGIN}/${INDEXNOW_KEY}.txt`,
        urlList: batch
      })
    });
    // 200 accepted, 202 accepted with the key check still pending. Anything
    // else is worth seeing in the deploy log: 403 is a key file that does not
    // match, 422 a URL that is not on this host, 429 too many submissions.
    if (!res.ok) ok = false;
    console[res.ok ? 'log' : 'warn'](`build: IndexNow ${batch.length} URL-er → ${res.status}`);
  }
  return ok;
}

// The key file is a committed static asset, so it ships *with* this deploy —
// but the build runs before the deploy is live, which means on the very first
// production build after wiring IndexNow up the key is not yet servable and
// the submission would come back 403. Checking first costs one request and
// turns that into a clean skip.
async function keyIsLive() {
  try {
    const res = await fetch(`${ORIGIN}/${INDEXNOW_KEY}.txt`);
    return res.ok && (await res.text()).trim() === INDEXNOW_KEY;
  } catch {
    return false;
  }
}

// Runs after the pages are on disk, and only for a real deploy. A preview
// build renders the same URLs from the same catalogue, so letting it ping
// would tell Bing production changed when nothing shipped — and would poison
// the manifest diff for the deploy that follows.
//
// The manifest is a receipt, not a log: it records what Bing has actually been
// told, so it is written only when the ping went through or when there was
// nothing to send. Writing it on a skipped ping is the one mistake that makes
// this silently stop working — the next build would diff against a baseline
// nobody ever received and conclude nothing changed, and the submission would
// be lost for good. Leaving no manifest instead means the next production
// build sees a 404, treats it as a first run, and sends the lot.
async function submitToIndexNow(current) {
  const write = () => writeFile(path.join(OUT, MANIFEST), serialiseManifest(current));

  if (process.env.VERCEL_ENV !== 'production') {
    // Harmless here: production reads the manifest from prisboka.no, never
    // from a preview URL. Written so a preview deploy can be inspected.
    await write();
    console.log(`build: hopper over IndexNow (VERCEL_ENV=${process.env.VERCEL_ENV ?? 'unset'}), manifest skrevet.`);
    return;
  }

  if (!await keyIsLive()) {
    console.warn(`build: ${INDEXNOW_KEY}.txt svarer ikke på ${ORIGIN} ennå — hopper over, og lar neste deploy sende inn alt.`);
    return;
  }

  const { map: previous, why } = await previousManifest();
  if (!previous) {
    console.warn(`build: fant ikke forrige IndexNow-manifest (${why}) — hopper over, og lar neste deploy sende inn alt.`);
    return;
  }
  if (why) console.log(`build: ${why}.`);

  const changed = changedUrls(current, previous);
  if (!changed.length) {
    console.log('build: ingen priser eller varer endret seg — ingen IndexNow-ping.');
    await write();
    return;
  }
  if (await pingIndexNow(changed)) await write();
}

// The committed table, or null if it is missing or unreadable — in which case
// the pages simply render without the nutrition block, the way they did before
// it existed. Same fail-soft rule as the rest of this build.
async function loadNutrition() {
  try {
    const index = app.buildNutrition(JSON.parse(await readFile(path.join(OUT, 'nutrition.json'), 'utf8')));
    if (!index) throw new Error('uventet format');
    return { index };
  } catch (err) {
    console.warn(`build: nutrition.json ikke lest (${err.message}) — sidene skrives uten næringsinnhold.`);
    return null;
  }
}

async function main() {
  const shell = await readFile(path.join(OUT, 'index.html'), 'utf8');
  const nut = await loadNutrition();

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

  // Only categories that actually have products — an empty page is worse than
  // no page, and it would be the one a search lands on.
  const categories = app.CATEGORIES.filter((c) => app.categoryGroups(c.slug).length > 0);

  await writeFile(path.join(OUT, 'sitemap.xml'), sitemapXml(indexable, categories));

  // Fingerprint as we render, so the manifest can only ever describe pages
  // that actually made it to disk.
  const manifest = new Map();

  await mkdir(path.join(OUT, 'kategori'), { recursive: true });
  for (const c of categories) {
    const gs = app.categoryGroups(c.slug);
    await writeFile(path.join(OUT, 'kategori', `${c.slug}.html`), renderCategoryPage(shell, c, gs));
    manifest.set(`${ORIGIN}${app.categoryPath(c.slug)}`, categoryFingerprint(c, gs));
  }

  await mkdir(path.join(OUT, 'gruppe'), { recursive: true });
  let matched = 0;
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
    await writeFile(path.join(OUT, 'gruppe', `${app.slugFor(g.key)}.html`), renderPage(shell, g, related, nut));
    manifest.set(`${ORIGIN}${app.groupPath(g.key)}`, groupFingerprint(g));
    if (nut && app.matchNutrition(nut.index, g.key)) matched++;
  }

  console.log(`build: ${rows.length} rader → ${groups.length} grupper, `
    + `${indexable.length} produktsider (≥${MIN_STORES} butikker) og ${categories.length} kategorisider `
    + `forhåndsrendret og lagt i sitemap`
    + (nut ? `, ${matched} med næringsinnhold fra Matvaretabellen ${nut.index.edition}.` : '.'));

  // Never let the ping take the deploy down with it — the pages are already
  // written and served by this point, and Bing finding out a day later via the
  // sitemap is a far smaller problem than a failed build.
  try {
    await submitToIndexNow(manifest);
  } catch (err) {
    console.warn(`build: IndexNow feilet (${err.message}) — sitemap og sider er upåvirket.`);
  }
}

// Only when run as the build (`node build.mjs`), never on import. test/ pulls
// the fingerprint and manifest helpers in directly, and importing a module
// whose top level fetches 50 000 catalogue rows would turn `node --test` into
// a network job.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // Never fail the deploy over the SEO layer.
    console.warn(`build: ${err && err.stack ? err.stack : err}`);
  });
}
