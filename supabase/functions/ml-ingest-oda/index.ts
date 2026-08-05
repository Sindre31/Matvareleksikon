// Supabase Edge Function: ml-ingest-oda
// -----------------------------------------------------------------------------
// Real Oda (oda.com, formerly Kolonial.no) shelf prices via Oda's public search
// API (keyless), the same source `billigkurv` uses. Oda is a single online
// store, so every hit maps to the 'oda' store. We ingest into ml_offers
// (source='oda') with the shared group_key scheme, plus product images and
// price history. The search API exposes no reliable before-price (its
// "promotions" are virtual bundles), so we record clean shelf prices only.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// A price at or below this is not a price. Meny's feed carries placeholders
// for goods it has no real figure for — counter and deli items ("Husets
// Pizza" 0,10, "Barracuda Filet pr Kg" 2,00, "Sau hel og Halv pr Kg" 2,00),
// free municipal waste bags (0,01, and Kiwi has them too), gift cards and
// cutlery packs. 101 catalogue rows sat at or below 2 kr and not one of them
// was a real grocery price; the first genuine ones appear just above, at
// 2,40-2,99 (taco spice sachets, loose potatoes, marsipan). Hence 2, not 3:
// three would have taken ~15 real products with it.
//
// The floor cannot key on "pr Kg" or "Husets" instead — plenty of counter
// rows carry a true per-kilo price ("Kjøttdeig Av Storfe pr Kg" at 225). The
// price itself is what separates a placeholder from a measurement.
//
// Mirrored in app.js (MIN_PRICE_NOK) so the rows already in the database are
// hidden without waiting for the next ingest run. Change both together.
const MIN_PRICE_NOK = 2;

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
  if (price == null || price <= MIN_PRICE_NOK || !name) return null;
  if (a?.currency && a.currency !== "NOK") return null;
  const img = a?.images?.[0]?.thumbnail?.url || a?.images?.[0]?.large?.url || null;
  const unitAbbr = a?.unit_price_quantity_abbreviation ?? null;
  return {
    external_id: "oda:" + nameSlug(name), store_id: STORE, product_name: name,
    group_key: groupKey(name), price, pre_price: null,
    unit: unitAbbr, unit_price: num(a?.gross_unit_price), unit_price_unit: unitAbbr,
    offer_text: null, image_url: img, valid_from: null, valid_until: null, source: "oda",
  };
}

// Which row represents a (group, store) in the day's price history: its best
// VALUE, not its lowest sticker price. The history keeps ONE row per group,
// store and day, and it used to keep the cheapest pack — so a chain whose
// half-litre was cheapest per pack got recorded at 13,10 while its litre sat
// at 17,40, and everything reading the series back saw an expensive-per-litre
// carton as that chain's price. The rest of the app already ranks the other
// way ("cheapest per unit, so a small carton can't masquerade as the best
// deal"); this brings the history in line.
// The pack size stated in the product name, normalised to l / kg / stk. The
// source's own unit price is preferred where it exists, but it often doesn't:
// Kassalapp reports current_unit_price for every Meny row and for none of
// Kiwi's, so without this the per-unit rule would quietly fall back to
// pack price for exactly the chain the bug was reported against. Percentages
// are stripped first so "Lettmelk 0,5% 0,5l" reads as a half-litre and not as
// half a percent. Mirrors parseAmount/baseAmount in app.js.
const PCT_RE = /\d+([.,]\d+)?\s*%/g;
const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(kg|hg|g|ml|cl|dl|l|stk)\b/gi;
function nameAmount(name: string): { value: number; dim: string } | null {
  const s = String(name ?? "").toLowerCase().replace(PCT_RE, " ");
  let best: { value: number; dim: string } | null = null;
  for (const m of s.matchAll(SIZE_RE)) {
    const n = Number(m[1].replace(",", "."));
    if (!isFinite(n) || n <= 0) continue;
    const u = m[2];
    let value = n, dim = "stk";
    if (u === "l") { dim = "l"; }
    else if (u === "dl") { dim = "l"; value = n / 10; }
    else if (u === "cl") { dim = "l"; value = n / 100; }
    else if (u === "ml") { dim = "l"; value = n / 1000; }
    else if (u === "kg") { dim = "kg"; }
    else if (u === "hg") { dim = "kg"; value = n / 10; }
    else if (u === "g") { dim = "kg"; value = n / 1000; }
    // The largest stated size is the pack ("0,5 l eller 1 l" → 1 l).
    if (!best || value > best.value) best = { value, dim };
  }
  return best;
}
// Price per litre / kilo / piece: the source's own figure when it has one,
// otherwise derived from the size in the name.
function perUnitOf(r: any): { value: number; dim: string } | null {
  const u = String(r?.unit_price_unit ?? "").toLowerCase().trim();
  const p = Number(r?.unit_price);
  if (u && isFinite(p) && p > 0) return { value: p, dim: u };
  const a = nameAmount(r?.product_name);
  const price = Number(r?.price);
  if (!a || !isFinite(price) || price <= 0) return null;
  return { value: price / a.value, dim: a.dim };
}
function betterHistoryRow(cand: any, cur: any): boolean {
  if (!cur) return true;
  const cp = perUnitOf(cand), np = perUnitOf(cur);
  // Only comparable in the same dimension — litres against kilos is not
  // arithmetic anyone should do, so that falls back to the pack price.
  if (cp && np && cp.dim === np.dim) return cp.value < np.value;
  return Number(cand?.price) < Number(cur?.price);
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
  for (const r of rows) { const k = r.group_key + "|" + r.store_id; if (betterHistoryRow(r, histMap.get(k))) histMap.set(k, r); }
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
