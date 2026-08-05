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

const BASE = "https://api.etilbudsavis.dk/v2";
const CTRY = "NO";
const SWEEP: Array<[string, string]> = [["faa0Ym", "rema"], ["257bxm", "kiwi"]];
const SWEEP_MAX_PAGES = 3;
// Broad net so Kiwi/Rema/Extra offers (which only exist as weekly flyers, not
// shelf-price APIs) are surfaced across all dealers via /offers/search.
const SEARCH_TERMS = [
  "meny", "coop extra", "kiwi", "rema", "kjøttdeig", "kjøttkaker", "karbonade",
  "kylling", "kyllingfilet", "laks", "torsk", "fisk", "reker", "bacon", "pølser",
  "skinke", "leverpostei", "kaffe", "te", "brød", "rundstykker", "knekkebrød",
  "melk", "lettmelk", "ost", "brunost", "smør", "margarin", "rømme", "fløte",
  "yoghurt", "egg", "pizza", "pasta", "spaghetti", "ris", "nudler", "taco",
  "tortilla", "juice", "brus", "vann", "saft", "frukt", "eple", "banan", "druer",
  "grønnsaker", "tomat", "agurk", "paprika", "løk", "potet", "gulrot", "salat",
  "brokkoli", "mais", "bønner", "kjeks", "sjokolade", "godteri", "snacks", "chips",
  "is", "mel", "sukker", "havregryn", "müsli", "cornflakes", "ketchup", "majones",
  "sennep", "olje", "krydder", "suppe", "hermetikk", "bleier", "vaskemiddel",
];
const SEARCH_PAGES = 2;

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

// Derive a comparable per-unit price from the offer's quantity block, so
// tilbudsavis offers (whose names often omit the size) still compare per l/kg/stk.
function unitInfo(o: any, price: number): { up: number; unit: string } | null {
  const q = o?.quantity;
  if (!q) return null;
  const sym = String(q?.unit?.si?.symbol || q?.unit?.symbol || "").toLowerCase();
  const factor = (typeof q?.unit?.si?.factor === "number" && q.unit.si.factor > 0) ? q.unit.si.factor : 1;
  const size = typeof q?.size?.from === "number" ? q.size.from : null;
  if (size && size > 0 && sym) {
    let amt = size * factor, dim: string | null = null;
    if (sym === "l") dim = "l";
    else if (sym === "ml") { dim = "l"; amt = amt / 1000; }
    else if (sym === "cl") { dim = "l"; amt = amt / 100; }
    else if (sym === "dl") { dim = "l"; amt = amt / 10; }
    else if (sym === "kg") dim = "kg";
    else if (sym === "g") { dim = "kg"; amt = amt / 1000; }
    if (dim && amt > 0) return { up: price / amt, unit: dim };
  }
  const pieces = typeof q?.pieces?.from === "number" ? q.pieces.from : null;
  if (pieces && pieces > 1) return { up: price / pieces, unit: "stk" };
  return null;
}

// Some flyer offers are only valid certain weekdays ("Gjelder fre–lør",
// "HELGETILBUD TORSDAG-LØRDAG"). Tjek has no structured field for this, so parse
// it out of the free-text description when present (rare, but real).
const DAY_RE = "(man(?:dag)?|tir(?:sdag)?|ons(?:dag)?|tor(?:sdag)?|fre(?:dag)?|l[øo]r(?:dag)?|s[øo]n(?:dag)?)";
function normDay(w: string): string | null {
  w = w.toLowerCase();
  if (w.startsWith("man")) return "man";
  if (w.startsWith("tir")) return "tir";
  if (w.startsWith("ons")) return "ons";
  if (w.startsWith("tor")) return "tor";
  if (w.startsWith("fre")) return "fre";
  if (w.startsWith("lør") || w.startsWith("lor")) return "lør";
  if (w.startsWith("søn") || w.startsWith("son")) return "søn";
  return null;
}
function offerDays(desc: string | undefined): string | null {
  const t = String(desc || "").toLowerCase();
  const m = t.match(new RegExp(DAY_RE + "\\s*(?:-|–|—|til)\\s*" + DAY_RE));
  if (m) { const a = normDay(m[1]), b = normDay(m[2]); if (a && b) return a + "–" + b; }
  if (/\bhelg(etilbud|en)?\b/.test(t)) return "helg";
  return null;
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
      if (typeof price !== "number" || !isFinite(price) || price <= MIN_PRICE_NOK || (currency && currency !== "NOK")) continue;
      const cty = dealerCountry(o?.dealer); if (cty && cty !== CTRY) continue;
      const slug = storeSlug(o?.dealer?.name); if (!slug || !o?.heading) continue;
      const pre = o?.pricing?.pre_price;
      const ui = unitInfo(o, price as number);
      rows.push({
        external_id: String(id),
        store_id: slug,
        product_name: o.heading,
        group_key: groupKey(o.heading),
        price,
        pre_price: typeof pre === "number" ? pre : null,
        unit: o?.quantity?.unit?.symbol ?? null,
        unit_price: ui ? Number(ui.up.toFixed(4)) : null,
        unit_price_unit: ui ? ui.unit : null,
        offer_days: offerDays(o?.description),
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
    for (let p = 0; p < SEARCH_PAGES; p++) {
      const page = await getOffers(`${BASE}/offers/search?query=${encodeURIComponent(term)}&limit=100&offset=${p * 100}&country_id=${CTRY}`);
      collect(page);
      if (page.length < 100) break;
    }
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
    if (betterHistoryRow(r, histMap.get(k))) histMap.set(k, r);
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

  const backfillInserted = await backfillPreviousWeek(SB_URL, sbHeaders, historyRows, today);

  return json({ offersFound: offerRows.length, offersInserted: inserted, historyInserted, backfillInserted });
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
