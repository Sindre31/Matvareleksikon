// Supabase Edge Function: ml-ingest-oda
// -----------------------------------------------------------------------------
// Real Oda (oda.com, formerly Kolonial.no) shelf prices via Oda's public search
// API (keyless), the same source `billigkurv` uses. Oda is a single online
// store, so every hit maps to the 'oda' store. We ingest into ml_offers
// (source='oda') with the shared group_key scheme, plus product images and
// price history. The search API exposes no reliable before-price (its
// "promotions" are virtual bundles), so we record clean shelf prices only.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const API = "https://oda.com/api/v1";
const STORE = "oda";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const TERMS = [
  "melk", "lettmelk", "ost", "brunost", "smør", "margarin", "egg", "yoghurt", "rømme",
  "fløte", "brød", "rundstykker", "knekkebrød", "leverpostei", "kjøttdeig", "kyllingfilet",
  "pølser", "bacon", "kjøttboller", "laks", "torsk", "fiskepinner", "pasta", "spaghetti",
  "ris", "hvetemel", "sukker", "havregryn", "müsli", "cornflakes", "potet", "gulrot", "løk",
  "paprika", "tomat", "agurk", "salat", "brokkoli", "eple", "banan", "mais", "bønner",
  "kokosmelk", "ketchup", "majones", "pastasaus", "tacokrydder", "tortilla", "kaffe", "te",
  "brus", "juice", "olje", "sjokolade", "kjeks", "vann",
];

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

function num(v: any): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") { const n = Number(v.replace(",", ".")); return isFinite(n) ? n : null; }
  return null;
}

function rowFrom(a: any): any | null {
  const price = num(a?.gross_price);
  const name = a?.full_name || a?.name;
  if (price == null || price <= 0 || !name) return null;
  if (a?.currency && a.currency !== "NOK") return null;
  const img = a?.images?.[0]?.thumbnail?.url || a?.images?.[0]?.large?.url || null;
  return {
    external_id: "oda:" + nameSlug(name), store_id: STORE, product_name: name,
    group_key: groupKey(name), price, pre_price: null,
    unit: a?.unit_price_quantity_abbreviation ?? null,
    offer_text: null, image_url: img, valid_from: null, valid_until: null, source: "oda",
  };
}

Deno.serve(async (_req: Request) => {
  const SB_URL = Deno.env.get("SUPABASE_URL"), SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB_URL || !SB_KEY) return json({ error: "Service role not available" }, 500);
  const sbHeaders = { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  const byKey = new Map<string, any>();
  for (const term of TERMS) {
    try {
      const res = await fetch(`${API}/search/mixed/?q=${encodeURIComponent(term)}`, { headers: { Accept: "application/json", "User-Agent": UA } });
      if (!res.ok) { console.error("oda", res.status, term); await sleep(200); continue; }
      const j = await res.json();
      for (const item of j?.items ?? []) {
        if (item?.type !== "product") continue;
        const r = rowFrom(item?.attributes); if (!r) continue;
        const prev = byKey.get(r.external_id); if (prev && Number(prev.price) <= r.price) continue;
        byKey.set(r.external_id, r);
      }
    } catch (e) { console.error("oda fetch", term, String(e)); }
    await sleep(200);
  }
  const rows = [...byKey.values()];

  await fetch(`${SB_URL}/rest/v1/ml_offers?source=eq.oda`, { method: "DELETE", headers: sbHeaders });
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

  return json({ productsFound: rows.length, inserted, historyInserted, backfillInserted });
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
