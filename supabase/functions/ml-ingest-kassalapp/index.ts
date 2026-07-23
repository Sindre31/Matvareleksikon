// Supabase Edge Function: ml-ingest-kassalapp
// -----------------------------------------------------------------------------
// Real shelf prices across the chains via the Kassalapp API (https://kassal.app),
// the source `billigkurv` uses. Writes source='kassalapp' rows into ml_offers
// (validity null = always current) with the same group_key scheme as the
// tilbudsaviser, so shelf prices and Tjek offers compare in one product group.
//
// Accumulate-by-default: every run ADDS/updates rows (upsert on external_id) and
// appends a daily point to ml_price_history, so historical prices and offers are
// kept. It never deletes unless the caller passes deleteFirst:true.
//
// Modes (POST JSON body):
//   {}                                  refresh default terms (add/update, no delete)
//   { terms:[...], pages:N }            add a batch for specific terms
//   { bulk:true, startPage:N, pages:M } page the whole /products catalogue
//   { deleteFirst:true, ... }           opt in to wiping kassalapp rows first
// Requires the KASSALAPP_TOKEN secret; a no-op ({skipped}) without it.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const API = "https://kassal.app/api/v1";
const PAGE_SIZE = 100;
const TIME_BUDGET_MS = 115000;
// Kassalapp allows ~60 requests/minute per token. One page fetch = one request,
// so pace the bulk sweep at ~1.1 s between pages (~54/min) to stay under the
// cap; going faster earns 429s that silently drop pages (and the Rema/Kiwi
// products on them). Because the sweep self-chains sequentially (below), only
// one invocation is ever calling the API at a time, so this budget is global.
const BULK_SLEEP_MS = 1100;
// Safety stop for the self-chaining bulk sweep, in case the catalogue's
// last_page metadata is ever missing (prevents an unbounded chain).
const MAX_BULK_PAGE = 5000;

const DEFAULT_TERMS = [
  "melk", "lettmelk", "revet ost", "brunost", "smør", "margarin", "egg", "yoghurt",
  "rømme", "fløte", "brød", "rundstykker", "knekkebrød", "leverpostei", "kjøttdeig",
  "kyllingfilet", "pølser", "bacon", "kjøttboller", "laks", "torsk", "fiskepinner",
  "pasta", "spaghetti", "ris", "hvetemel", "sukker", "havregryn", "müsli", "cornflakes",
  "potet", "gulrot", "løk", "paprika", "tomat", "agurk", "salat", "brokkoli", "eple",
  "banan", "mais", "bønner", "kokosmelk", "ketchup", "majones", "pastasaus", "tacokrydder",
  "tortilla", "kaffe", "te", "brus", "juice", "olje", "sjokolade", "kjeks", "smørbukk",
];

function storeSlug(name: string | undefined): string | null {
  const s = (name || "").toLowerCase();
  if (s.includes("rema")) return "rema";
  if (s.includes("kiwi")) return "kiwi";
  if (s.includes("coop extra") || s.includes("coop mega") || s.includes("coop prix") || s.includes("coop obs") || s === "obs" || s === "extra" || s.includes(" extra")) return "extra";
  if (s.includes("meny")) return "meny";
  return null;
}
function num(v: any): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (v && typeof v === "object" && typeof v.price === "number") return v.price;
  if (typeof v === "string") { const n = Number(v.replace(",", ".")); return isFinite(n) ? n : null; }
  return null;
}
const BRAND_RE = /\b(rema|kiwi|coop|extra|meny|spar|first ?price|x-?tra|xtra|eldorado|prima|folkets|anglamark|q|tine|gilde|synnove|nordfjord|prior|stange|jacobs)\b/g;
function groupKey(name: string): string {
  let s = (name || "").toLowerCase()
    .replace(/ø/g, "o").replace(/æ/g, "ae").replace(/å/g, "a")
    .replace(/\d+([.,]\d+)?\s*(kg|hg|g|ml|cl|dl|l|stk|pk|pakk|pack|kop)\b/g, " ")
    .replace(/\d+([.,]\d+)?\s*%/g, " ")
    .replace(BRAND_RE, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ").trim();
  if (!s) s = (name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return s;
}
function nameSlug(name: string): string { return (name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Returns the page's rows plus the catalogue's last_page (Laravel pagination
// metadata — under `meta` for resource collections, sometimes top-level), so the
// bulk sweep knows when it has reached the end instead of guessing a page cap.
// `data: null` signals a hard failure (after retrying 429s with backoff).
async function getPage(url: string, token: string): Promise<{ data: any[] | null; lastPage: number | null }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (res.ok) {
      const j = await res.json();
      const lastPage = typeof j?.meta?.last_page === "number" ? j.meta.last_page
        : (typeof j?.last_page === "number" ? j.last_page : null);
      return { data: j?.data ?? [], lastPage };
    }
    if (res.status === 429 && attempt < 3) { await sleep(2000 * attempt); continue; }
    console.error("kassalapp", res.status, url);
    return { data: null, lastPage: null };
  }
  return { data: null, lastPage: null };
}

// Fire-and-forget the next page range so the bulk sweep continues past this
// invocation's time budget — a sequential chain that walks the whole catalogue
// without ever running two invocations at once (keeping us under the rate cap).
// Uses the service-role key as the platform JWT; EdgeRuntime.waitUntil keeps the
// dispatch alive after this handler responds.
function dispatchNext(SB_URL: string, SB_KEY: string, startPage: number, pages: number) {
  const req = fetch(`${SB_URL}/functions/v1/ml-ingest-kassalapp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    body: JSON.stringify({ bulk: true, startPage, pages, deleteFirst: false, autochain: true }),
  }).then((r) => r.text()).catch((e) => console.error("chain dispatch failed", String(e)));
  const ER = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (ER && typeof ER.waitUntil === "function") ER.waitUntil(req);
}

function rowFrom(p: any): any | null {
  const price = num(p?.current_price) ?? num(p?.price);
  const slug = storeSlug(p?.store?.name);
  if (price == null || price <= 0 || !slug || !p?.name) return null;
  const hist = (p?.price_history ?? []).map((h: any) => h?.price).filter((x: any) => typeof x === "number");
  const recentMax = hist.length ? Math.max(...hist) : price;
  // Real markdown, not a price_history outlier: between 5% and 50% off. Kassalapp's
  // history occasionally holds junk-high values (wrong unit/size) that would look
  // like a 90% "offer" (e.g. Lutefisk 29,90 "fra" 299), so cap the before-price.
  const isOffer = recentMax > price * 1.05 && recentMax <= price * 2;
  return {
    external_id: "kassal:" + slug + ":" + nameSlug(p.name), store_id: slug, product_name: p.name,
    group_key: groupKey(p.name), price, pre_price: isOffer ? recentMax : null, unit: p?.weight_unit ?? null,
    offer_text: isOffer ? "Nedsatt pris" : null, image_url: p?.image ?? null,
    valid_from: null, valid_until: null, source: "kassalapp",
  };
}

Deno.serve(async (req: Request) => {
  const token = (Deno.env.get("KASSALAPP_TOKEN") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ skipped: true, reason: "KASSALAPP_TOKEN ikke satt" });
  const SB_URL = Deno.env.get("SUPABASE_URL"), SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB_URL || !SB_KEY) return json({ error: "Service role not available" }, 500);
  const sbHeaders = { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  const body = await req.json().catch(() => ({} as any));
  // Accumulate by default: only wipe existing kassalapp rows when the caller
  // explicitly asks (deleteFirst:true). Every run otherwise ADDS/updates prices
  // (upsert on external_id) and appends history, so historical prices and
  // offers are preserved.
  const deleteFirst = body.deleteFirst === true;
  const bulk = !!body.bulk;
  // ~90 pages fits the ~115 s budget at the 1.1 s/page rate limit; the sweep
  // then self-chains to the next range, so the whole catalogue is covered.
  const pages = Math.max(1, Number(body.pages) || (bulk ? 90 : 2));
  const startPage = Math.max(1, Number(body.startPage) || 1);
  const autochain = body.autochain !== false; // bulk self-continuation, on by default
  const terms: string[] = Array.isArray(body.terms) && body.terms.length ? body.terms : DEFAULT_TERMS;

  const start = Date.now();
  const byKey = new Map<string, any>();
  const add = (p: any) => { const r = rowFrom(p); if (!r) return; const prev = byKey.get(r.external_id); if (prev && Number(prev.price) <= r.price) return; byKey.set(r.external_id, r); };

  let lastPage = startPage - 1, hitEnd = false, catalogLastPage: number | null = null;
  if (bulk) {
    for (let page = startPage; page < startPage + pages; page++) {
      if (Date.now() - start > TIME_BUDGET_MS) break;
      const { data, lastPage: metaLast } = await getPage(`${API}/products?size=${PAGE_SIZE}&page=${page}`, token);
      lastPage = page;
      if (metaLast != null) catalogLastPage = metaLast;
      if (data == null) { hitEnd = true; break; }
      data.forEach(add);
      // End of catalogue: a short page, or we've reached the reported last_page.
      if (data.length < PAGE_SIZE || (catalogLastPage != null && page >= catalogLastPage)) { hitEnd = true; break; }
      await sleep(BULK_SLEEP_MS);
    }
  } else {
    for (const term of terms) {
      if (Date.now() - start > TIME_BUDGET_MS) break;
      for (let page = 1; page <= pages; page++) {
        const { data } = await getPage(`${API}/products?search=${encodeURIComponent(term)}&size=${PAGE_SIZE}&page=${page}`, token);
        if (data == null) break;
        data.forEach(add);
        if (data.length < PAGE_SIZE) break;
        await sleep(BULK_SLEEP_MS);
      }
    }
  }

  const rows = [...byKey.values()];
  if (deleteFirst) await fetch(`${SB_URL}/rest/v1/ml_offers?source=eq.kassalapp`, { method: "DELETE", headers: sbHeaders });
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const res = await fetch(`${SB_URL}/rest/v1/ml_offers?on_conflict=external_id`, { method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(chunk) });
    if (res.ok) inserted += chunk.length; else console.error("upsert failed", res.status, await res.text());
  }

  const today = new Date().toISOString().slice(0, 10);
  const histMap = new Map<string, any>();
  for (const r of rows) { const k = r.group_key + "|" + r.store_id; const ex = histMap.get(k); if (!ex || Number(r.price) < Number(ex.price)) histMap.set(k, r); }
  const historyRows = [...histMap.values()].map((r) => ({ group_key: r.group_key, store_id: r.store_id, product_name: r.product_name, image_url: r.image_url, price: r.price, pre_price: r.pre_price, is_offer: r.pre_price != null, observed_at: today }));
  let historyInserted = 0;
  for (let i = 0; i < historyRows.length; i += 500) {
    const chunk = historyRows.slice(i, i + 500);
    const res = await fetch(`${SB_URL}/rest/v1/ml_price_history?on_conflict=group_key,store_id,observed_at`, { method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(chunk) });
    if (res.ok) historyInserted += chunk.length; else console.error("history failed", res.status, await res.text());
  }

  const backfillInserted = await backfillPreviousWeek(SB_URL, sbHeaders, historyRows, today);

  // Self-chain: if this was a bulk range that stopped on its time budget (not at
  // the catalogue's end), kick off the next range so a single weekly trigger
  // walks the whole catalogue, one invocation at a time.
  const nextPage = lastPage + 1;
  let chained = false;
  if (bulk && autochain && !hitEnd && lastPage >= startPage && nextPage <= MAX_BULK_PAGE
      && (catalogLastPage == null || nextPage <= catalogLastPage)) {
    dispatchNext(SB_URL, SB_KEY, nextPage, pages);
    chained = true;
  }

  return json({ mode: bulk ? "bulk" : "search", productsFound: rows.length, inserted, historyInserted, backfillInserted, lastPage, catalogLastPage, hitEnd, chained, nextPage: bulk && !hitEnd ? nextPage : null, elapsedMs: Date.now() - start });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
// Back-fill: when a product is on offer (has a real before-price), record that
// before-price as *last week's* price point (a plain, non-offer observation) so
// the history chart shows the drop even when we only have this week's snapshot.
// Uses resolution=ignore-duplicates so a real measurement already recorded for
// that week is never overwritten.
async function backfillPreviousWeek(
  SB_URL: string,
  sbHeaders: Record<string, string>,
  historyRows: any[],
  today: string,
): Promise<number> {
  const lastWeek = new Date(new Date(today).getTime() - 7 * 864e5).toISOString().slice(0, 10);
  const rows = historyRows
    .filter((r) => r.pre_price != null && Number(r.pre_price) > Number(r.price))
    .map((r) => ({
      group_key: r.group_key, store_id: r.store_id, product_name: r.product_name, image_url: r.image_url,
      price: r.pre_price, pre_price: null, is_offer: false, observed_at: lastWeek,
    }));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const res = await fetch(`${SB_URL}/rest/v1/ml_price_history?on_conflict=group_key,store_id,observed_at`, {
      method: "POST", headers: { ...sbHeaders, Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(chunk),
    });
    if (res.ok) inserted += chunk.length; else console.error("backfill failed:", res.status, await res.text());
  }
  return inserted;
}
