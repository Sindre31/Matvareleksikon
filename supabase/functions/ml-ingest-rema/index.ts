// Supabase Edge Function: ml-ingest-rema
// -----------------------------------------------------------------------------
// Real Rema 1000 shelf prices straight from Rema's own catalogue API (the
// keyless "Æ"/digital product API at api.digital.rema1000.no), so Rema no longer
// depends solely on Kassalapp's third-party index. We walk every department and
// page its products into ml_offers (source='rema') with the shared group_key
// scheme, plus product images, a native per-unit price, and price history.
//
// Rema is a single chain here → every row maps to the 'rema' store. The API is
// keyless but gates cloud egress without a browser User-Agent (like Tjek/ngdata),
// so we send one. Writes use the injected service-role key.
//
// The response shape is read defensively (fields checked in several candidate
// locations) so a minor upstream rename degrades to fewer fields, never a crash;
// the returned JSON carries diagnostics (departments walked, products found) so a
// dry upstream change is visible from the invocation result.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const API = "https://api.digital.rema1000.no/api/v3";
const STORE = "rema";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_DEPT = 40; // safety stop if pagination metadata is missing
const TIME_BUDGET_MS = 150000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const HEADERS = { Accept: "application/json", "Accept-Language": "nb-NO,nb;q=0.9,en;q=0.8", "User-Agent": UA };

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function num(v: any): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") { const n = Number(v.replace(",", ".")); return isFinite(n) ? n : null; }
  return null;
}

// Rema pagination/lists come back either as a bare array or wrapped under
// `data` / `products` / `departments`, depending on the endpoint — normalise.
function listOf(j: any, ...keys: string[]): any[] {
  if (Array.isArray(j)) return j;
  for (const k of keys) if (Array.isArray(j?.[k])) return j[k];
  return [];
}

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) { console.error("rema", res.status, url); return null; }
    return await res.json();
  } catch (e) { console.error("rema fetch error", url, String(e)); return null; }
}

// Map Rema's comparison unit onto the shared l/kg/stk dimensions used by the
// per-unit price column (matches ngdata/Oda), folding grams/millilitres up.
function dimOf(unit: string | null | undefined): string | null {
  const u = String(unit || "").toLowerCase().trim();
  if (u === "l" || u === "liter" || u === "ltr") return "l";
  if (u === "kg" || u === "kilo") return "kg";
  if (u === "stk" || u === "pcs" || u === "piece") return "stk";
  return null;
}

function rowFrom(p: any): any | null {
  const pr = p?.prices?.[0] ?? p?.pricing ?? p;
  const price = num(pr?.price) ?? num(p?.price) ?? num(p?.current_price);
  const name = p?.name || p?.title;
  if (price == null || price <= 0 || !name) return null;

  const id = p?.id ?? p?.product_id ?? name;
  // Native per-unit (per l/kg/stk) price, when Rema exposes a comparison price.
  const upVal = num(pr?.unit_price) ?? num(p?.unit_price);
  const upUnit = dimOf(pr?.unit_price_calc?.unit ?? pr?.compare_unit ?? p?.compare_unit ?? pr?.unit);

  // Before-price: only when genuinely on discount and the original is higher.
  const onDiscount = pr?.is_on_discount === true || p?.is_on_discount === true;
  const before = num(pr?.price_before_discount) ?? num(pr?.normal_price) ?? num(pr?.max_price) ?? num(p?.price_before_discount);
  const prePrice = onDiscount && before != null && before > price ? before : null;

  const img = p?.image_url || p?.images?.[0]?.medium || p?.images?.[0]?.url || p?.images?.[0]?.large || null;

  return {
    external_id: "rema:" + id,
    store_id: STORE,
    product_name: name,
    group_key: groupKey(name),
    price,
    pre_price: prePrice,
    unit: p?.unit_of_measure ?? pr?.unit ?? null,
    unit_price: upVal != null && upUnit ? Number(upVal.toFixed(4)) : null,
    unit_price_unit: upVal != null && upUnit ? upUnit : null,
    offer_text: prePrice != null ? "Nedsatt pris" : null,
    image_url: typeof img === "string" ? img : null,
    valid_from: null,
    valid_until: null,
    source: "rema",
  };
}

Deno.serve(async (_req: Request) => {
  const SB_URL = Deno.env.get("SUPABASE_URL"), SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB_URL || !SB_KEY) return json({ error: "Service role not available" }, 500);
  const sbHeaders = { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  const start = Date.now();
  const depJson = await getJson(`${API}/departments`);
  const departments = listOf(depJson, "data", "departments")
    .map((d: any) => ({ id: d?.id ?? d?.department_id, name: d?.name }))
    .filter((d: any) => d.id != null);

  const byKey = new Map<string, any>();
  let deptsWalked = 0, pagesFetched = 0;
  for (const dep of departments) {
    if (Date.now() - start > TIME_BUDGET_MS) break;
    deptsWalked++;
    for (let page = 1; page <= MAX_PAGES_PER_DEPT; page++) {
      if (Date.now() - start > TIME_BUDGET_MS) break;
      const j = await getJson(`${API}/products?department_id=${encodeURIComponent(String(dep.id))}&page_size=${PAGE_SIZE}&page=${page}`);
      if (j == null) break;
      pagesFetched++;
      const items = listOf(j, "data", "products");
      for (const p of items) {
        const r = rowFrom(p); if (!r) continue;
        const prev = byKey.get(r.external_id);
        if (prev && Number(prev.price) <= r.price) continue;
        byKey.set(r.external_id, r);
      }
      const pages = num(j?.pages) ?? num(j?.meta?.last_page) ?? num(j?.total_pages);
      if (items.length < PAGE_SIZE || (pages != null && page >= pages)) break;
      await sleep(150);
    }
  }
  const rows = [...byKey.values()];

  // Replace this source's rows so delisted products don't linger.
  await fetch(`${SB_URL}/rest/v1/ml_offers?source=eq.rema`, { method: "DELETE", headers: sbHeaders });
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

  return json({ departments: departments.length, deptsWalked, pagesFetched, productsFound: rows.length, inserted, historyInserted, backfillInserted, elapsedMs: Date.now() - start });
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
