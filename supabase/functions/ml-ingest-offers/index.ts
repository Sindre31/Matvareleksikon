// Supabase Edge Function: ml-ingest-offers
// -----------------------------------------------------------------------------
// Ingests tilbudsaviser (weekly grocery offer catalogues) from the public
// Tjek / eTilbudsavis API — the same source and approach as the author's
// `billigkurv` project — and writes them into `ml_offers`. As a bonus, offer
// images are used to fill a representative picture for each leksikon product
// (`ml_products.image_url`).
//
// The Tjek API needs no key. Writes use the service-role key that Supabase
// injects into Edge Functions, so this runs behind the platform JWT gate.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BASE = "https://api.etilbudsavis.dk/v2";
const CTRY = "NO";

// Low-coverage chains without open price APIs — sweep their whole catalogue.
const SWEEP: Array<[string, string]> = [["faa0Ym", "rema"], ["257bxm", "kiwi"]];
const SWEEP_MAX_PAGES = 3;

// Word searches broaden coverage and pull in Extra / Meny offers.
const SEARCH_TERMS = [
  "meny", "coop extra", "kjøttdeig", "kylling", "laks", "kaffe", "brød", "melk",
  "ost", "pizza", "yoghurt", "juice", "brus", "frukt", "grønnsaker", "pasta",
];

// leksikon product id -> a search term whose offer image represents it.
const PRODUCT_TERMS: Record<string, string> = {
  melk: "lettmelk", brod: "grovbrød", egg: "egg", smor: "meierismør",
  norvegia: "norvegia", banan: "banan", tomat: "tomat", potet: "poteter",
  kaffe: "filtermalt kaffe", pasta: "spaghetti", ris: "jasminris",
  havregryn: "havregryn", kjottdeig: "kjøttdeig", laks: "laksefilet",
  kylling: "kyllingfilet", pizza: "frossenpizza", cola: "cola",
  appelsinjuice: "appelsinjuice",
};

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

const TJEK_HEADERS = {
  Accept: "application/json",
  "Accept-Language": "nb-NO,nb;q=0.9,en;q=0.8",
  // Tjek blocks requests with no / non-browser User-Agent from cloud egress.
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

async function searchFirstImage(term: string): Promise<string | null> {
  const page = await getOffers(`${BASE}/offers/search?query=${encodeURIComponent(term)}&limit=10&country_id=${CTRY}`);
  for (const o of page) { const img = o?.images?.view || o?.images?.zoom || o?.images?.thumb; if (img) return img; }
  return null;
}

Deno.serve(async (req: Request) => {
  const SB_URL = Deno.env.get("SUPABASE_URL");
  const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB_URL || !SB_KEY) return json({ error: "Service role not available" }, 500);
  const sbHeaders = { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  // 1) Collect offers (dedup by id) from sweeps + searches.
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

  // Dedup by external_id (unique key) so the bulk insert can't self-conflict.
  const byExt = new Map<string, Record<string, unknown>>();
  for (const r of rows) byExt.set(r.external_id as string, r);
  const offerRows = [...byExt.values()];

  // 2) Replace this source's offers.
  await fetch(`${SB_URL}/rest/v1/ml_offers?source=eq.etilbudsavis`, { method: "DELETE", headers: sbHeaders });
  let inserted = 0;
  for (let i = 0; i < offerRows.length; i += 500) {
    const chunk = offerRows.slice(i, i + 500);
    const res = await fetch(`${SB_URL}/rest/v1/ml_offers`, {
      method: "POST", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(chunk),
    });
    if (res.ok) inserted += chunk.length;
    else console.error("offer insert failed:", res.status, await res.text());
  }

  // 3) Fill a representative image per leksikon product.
  let productImages = 0;
  for (const [productId, term] of Object.entries(PRODUCT_TERMS)) {
    const img = await searchFirstImage(term);
    if (!img) continue;
    const res = await fetch(`${SB_URL}/rest/v1/ml_products?id=eq.${productId}`, {
      method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify({ image_url: img }),
    });
    if (res.ok) productImages++;
  }

  return json({ offersFound: offerRows.length, offersInserted: inserted, productImages });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
