// Supabase Edge Function: ml-ingest-kassalapp
// -----------------------------------------------------------------------------
// Real shelf prices across the chains via the Kassalapp API (https://kassal.app),
// the source `billigkurv` uses. Writes source='kassalapp' rows into ml_offers
// (validity null = always current) with the same group_key scheme as the
// tilbudsaviser, so shelf prices and Tjek offers compare in one product group.
//
// Modes (POST JSON body):
//   {}                                  weekly refresh: default terms, replace
//   { terms:[...], pages:N, deleteFirst:false }   append a batch (one-time bulk)
//   { bulk:true, startPage:N, pages:M, deleteFirst:false }   page /products (no search)
// Rows are UPSERTed on external_id, so batched one-time pulls accumulate safely.
// Requires the KASSALAPP_TOKEN secret; a no-op ({skipped}) without it.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const API = "https://kassal.app/api/v1";
const PAGE_SIZE = 100;
const TIME_BUDGET_MS = 115000;

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

async function getPage(url: string, token: string): Promise<any[] | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (res.ok) { const j = await res.json(); return j?.data ?? []; }
    if (res.status === 429 && attempt === 1) { await sleep(2000); continue; }
    console.error("kassalapp", res.status, url);
    return null;
  }
  return null;
}

function rowFrom(p: any): any | null {
  const price = num(p?.current_price) ?? num(p?.price);
  const slug = storeSlug(p?.store?.name);
  if (price == null || price <= 0 || !slug || !p?.name) return null;
  const hist = (p?.price_history ?? []).map((h: any) => h?.price).filter((x: any) => typeof x === "number");
  const recentMax = hist.length ? Math.max(...hist) : price;
  const isOffer = recentMax > price * 1.05;
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
  const deleteFirst = body.deleteFirst !== false && !body.bulk && (!body.terms);
  const bulk = !!body.bulk;
  const pages = Math.max(1, Number(body.pages) || (bulk ? 40 : 2));
  const startPage = Math.max(1, Number(body.startPage) || 1);
  const terms: string[] = Array.isArray(body.terms) && body.terms.length ? body.terms : DEFAULT_TERMS;

  const start = Date.now();
  const byKey = new Map<string, any>();
  const add = (p: any) => { const r = rowFrom(p); if (!r) return; const prev = byKey.get(r.external_id); if (prev && Number(prev.price) <= r.price) return; byKey.set(r.external_id, r); };

  let lastPage = startPage - 1, hitEnd = false;
  if (bulk) {
    for (let page = startPage; page < startPage + pages; page++) {
      if (Date.now() - start > TIME_BUDGET_MS) break;
      const data = await getPage(`${API}/products?size=${PAGE_SIZE}&page=${page}`, token);
      lastPage = page;
      if (data == null) { hitEnd = true; break; }
      data.forEach(add);
      if (data.length < PAGE_SIZE) { hitEnd = true; break; }
      await sleep(100);
    }
  } else {
    for (const term of terms) {
      if (Date.now() - start > TIME_BUDGET_MS) break;
      for (let page = 1; page <= pages; page++) {
        const data = await getPage(`${API}/products?search=${encodeURIComponent(term)}&size=${PAGE_SIZE}&page=${page}`, token);
        if (data == null) break;
        data.forEach(add);
        if (data.length < PAGE_SIZE) break;
        await sleep(100);
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

  return json({ mode: bulk ? "bulk" : "search", productsFound: rows.length, inserted, historyInserted, backfillInserted, lastPage, hitEnd, nextPage: bulk && !hitEnd ? lastPage + 1 : null, elapsedMs: Date.now() - start });
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
