// Supabase Edge Function: ml-ingest-offers
// -----------------------------------------------------------------------------
// Ingests tilbudsaviser (weekly grocery offer catalogues) from the public
// Tjek / eTilbudsavis API (same source/approach as `billigkurv`) into
// `ml_offers`, assigns each a `group_key` so store-specific products can be
// compared as generic items, and appends a real price point per product to
// `ml_price_history` (so the per-product chart fills in over time).
//
// Tjek needs no key (but blocks cloud egress without a browser User-Agent).
// Writes use the injected service-role key.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BASE = "https://api.etilbudsavis.dk/v2";
const CTRY = "NO";
const SWEEP: Array<[string, string]> = [["faa0Ym", "rema"], ["257bxm", "kiwi"]];
const SWEEP_MAX_PAGES = 3;
const SEARCH_TERMS = [
  "meny", "coop extra", "kjøttdeig", "kylling", "laks", "kaffe", "brød", "melk",
  "ost", "pizza", "yoghurt", "juice", "brus", "frukt", "grønnsaker", "pasta",
  "taco", "smør", "egg", "banan", "ris", "kjeks", "sjokolade", "mel",
];

function storeSlug(name: string | undefined): string | null {
  const s = (name || "").toLowerCase();
  if (s.includes("rema")) return "rema";
  if (s.includes("kiwi")) return "kiwi";
  if (s.includes("coop extra") || s === "extra" || s.includes(" extra")) return "extra";
  if (s.includes("meny")) return "meny";
  return null;
}
function toDate(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const d = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}
function dealerCountry(dealer: any): string | undefined {
  const c = dealer?.country;
  return !c ? undefined : (typeof c === "string" ? c : c.id);
}

// Generic grouping key: fold Norwegian letters, drop sizes/units/%, drop common
// store/house brands, keep the descriptive words. Imperfect but groups clearly
// similar items (e.g. "TACOSAUS MEDIUM" across stores).
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

const TJEK_HEADERS = {
  Accept: "application/json",
  "Accept-Language": "nb-NO,nb;q=0.9,en;q=0.8",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};
async function getOffers(url: string): Promise<any[]> {
  try {
    const r = await fetch(url, { headers: TJEK_HEADERS });
    if (!r.ok) { console.error("tjek", r.status, url); return []; }
    const j = await r.json();
    return Array.isArray(j) ? j : (j.offers ?? []);
  } catch (e) { console.error("tjek fetch error", String(e)); return []; }
}

Deno.serve(async (_req: Request) => {
  const SB_URL = Deno.env.get("SUPABASE_URL");
  const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB_URL || !SB_KEY) return json({ error: "Service role not available" }, 500);
  const sbHeaders = { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  const collect = (offers: any[]) => {
    for (const o of offers) {
      const id = o?.id || `${o?.heading}|${o?.dealer_id}|${o?.pricing?.price}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const price = o?.pricing?.price, currency = o?.pricing?.currency;
      if (typeof price !== "number" || (currency && currency !== "NOK")) continue;
      const cty = dealerCountry(o?.dealer); if (cty && cty !== CTRY) continue;
      const slug = storeSlug(o?.dealer?.name); if (!slug || !o?.heading) continue;
      const pre = o?.pricing?.pre_price;
      rows.push({
        external_id: String(id),
        store_id: slug,
        product_name: o.heading,
        group_key: groupKey(o.heading),
        price,
        pre_price: typeof pre === "number" ? pre : null,
        unit: o?.quantity?.unit?.symbol ?? null,
        offer_text: typeof pre === "number" && pre > price ? `Tilbudsavis (før ${pre.toFixed(2)})` : "Tilbudsavis",
        image_url: o?.images?.view || o?.images?.zoom || o?.images?.thumb || null,
        valid_from: toDate(o?.run_from),
        valid_until: toDate(o?.run_till),
        source: "etilbudsavis",
      });
    }
  };
  for (const [dealerId] of SWEEP) {
    for (let off = 0; off < SWEEP_MAX_PAGES * 100; off += 100) {
      const page = await getOffers(`${BASE}/offers?dealer_id=${dealerId}&limit=100&offset=${off}&country_id=${CTRY}`);
      collect(page);
      if (page.length < 100) break;
    }
  }
  for (const term of SEARCH_TERMS) {
    collect(await getOffers(`${BASE}/offers/search?query=${encodeURIComponent(term)}&limit=100&country_id=${CTRY}`));
  }

  const byExt = new Map<string, Record<string, unknown>>();
  for (const r of rows) byExt.set(r.external_id as string, r);
  const offerRows = [...byExt.values()];

  // Replace this source's offers.
  await fetch(`${SB_URL}/rest/v1/ml_offers?source=eq.etilbudsavis`, { method: "DELETE", headers: sbHeaders });
  let inserted = 0;
  for (let i = 0; i < offerRows.length; i += 500) {
    const chunk = offerRows.slice(i, i + 500);
    const res = await fetch(`${SB_URL}/rest/v1/ml_offers`, {
      method: "POST", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(chunk),
    });
    if (res.ok) inserted += chunk.length; else console.error("offer insert failed:", res.status, await res.text());
  }

  // Append one price point per (group_key, store) — the cheapest today — into history.
  const today = new Date().toISOString().slice(0, 10);
  const histMap = new Map<string, any>();
  for (const r of offerRows as any[]) {
    const k = r.group_key + "|" + r.store_id;
    const ex = histMap.get(k);
    if (!ex || Number(r.price) < Number(ex.price)) histMap.set(k, r);
  }
  const historyRows = [...histMap.values()].map((r) => ({
    group_key: r.group_key, store_id: r.store_id, product_name: r.product_name, image_url: r.image_url,
    price: r.price, pre_price: r.pre_price, is_offer: r.pre_price != null && Number(r.pre_price) > Number(r.price),
    observed_at: today,
  }));
  let historyInserted = 0;
  for (let i = 0; i < historyRows.length; i += 500) {
    const chunk = historyRows.slice(i, i + 500);
    const res = await fetch(`${SB_URL}/rest/v1/ml_price_history?on_conflict=group_key,store_id,observed_at`, {
      method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(chunk),
    });
    if (res.ok) historyInserted += chunk.length; else console.error("history upsert failed:", res.status, await res.text());
  }

  return json({ offersFound: offerRows.length, offersInserted: inserted, historyInserted });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
