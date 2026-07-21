// Supabase Edge Function: ml-add-history
// -----------------------------------------------------------------------------
// Lets a contributor record a KNOWN earlier price as one row in ml_price_history
// (the table the product price-history chart is built from). Typical use: "I know
// this product cost X last week" → add a point dated to that week.
//
// Guards (this writes straight to the chart data, so it validates hard):
//  - the (group_key, store_id) must already exist in ml_offers (real product),
//  - price must be a sane positive number,
//  - observed_at must be a valid past date within the last ~2 years,
//  - per-IP rate limiting via the shared ml_scan_allow RPC.
// The write uses the injected service-role key; on_conflict updates the point so
// the same week can be corrected without duplicates.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const RATE_LIMIT = 40;
const RATE_WINDOW_SECS = 3600;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function num(v: unknown): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") { const n = Number(v.replace(",", ".")); return isFinite(n) ? n : null; }
  return null;
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function rateLimitAllows(url: string, key: string, ip: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/rest/v1/rpc/ml_scan_allow`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ p_ip: ip, p_limit: RATE_LIMIT, p_window_secs: RATE_WINDOW_SECS }),
    });
    if (!res.ok) return true;
    return (await res.json()) === true;
  } catch { return true; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SB_URL = Deno.env.get("SUPABASE_URL"), SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB_URL || !SB_KEY) return json({ error: "Tjenesten er ikke tilgjengelig." }, 500);
  const sbHeaders = { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  if (!(await rateLimitAllows(SB_URL, SB_KEY, ip))) {
    return json({ error: "For mange innsendinger på kort tid. Vent litt og prøv igjen." }, 429);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Ugyldig forespørsel." }, 400); }

  const groupKey = typeof body?.group_key === "string" ? body.group_key.trim() : "";
  const storeId = typeof body?.store_id === "string" ? body.store_id.trim() : "";
  const price = num(body?.price);
  const prePrice = body?.pre_price == null ? null : num(body.pre_price);
  const observedAt = typeof body?.observed_at === "string" ? body.observed_at.trim() : "";

  if (!groupKey || !storeId) return json({ error: "Mangler produkt eller butikk." }, 400);
  if (price == null || price <= 0 || price > 100000) return json({ error: "Ugyldig pris." }, 400);
  if (!DATE_RE.test(observedAt)) return json({ error: "Ugyldig dato (bruk ÅÅÅÅ-MM-DD)." }, 400);

  const today = new Date().toISOString().slice(0, 10);
  const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  if (observedAt > today) return json({ error: "Datoen kan ikke være i framtiden." }, 400);
  if (observedAt < twoYearsAgo) return json({ error: "Datoen er for langt tilbake." }, 400);

  // The product+store must be real (exists in the catalogue).
  const chk = await fetch(
    `${SB_URL}/rest/v1/ml_offers?select=product_name&group_key=eq.${encodeURIComponent(groupKey)}&store_id=eq.${encodeURIComponent(storeId)}&limit=1`,
    { headers: sbHeaders },
  );
  const existing = chk.ok ? await chk.json() : [];
  if (!Array.isArray(existing) || !existing.length) {
    return json({ error: "Ukjent produkt/butikk-kombinasjon." }, 404);
  }
  const productName = typeof body?.product_name === "string" && body.product_name.trim()
    ? body.product_name.trim()
    : existing[0]?.product_name || groupKey;

  const row = {
    group_key: groupKey, store_id: storeId, product_name: productName,
    price, pre_price: prePrice, is_offer: prePrice != null && prePrice > price,
    observed_at: observedAt,
  };
  const res = await fetch(`${SB_URL}/rest/v1/ml_price_history?on_conflict=group_key,store_id,observed_at`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([row]),
  });
  if (!res.ok) {
    console.error("history insert", res.status, await res.text());
    return json({ error: "Kunne ikke lagre prispunktet." }, 502);
  }
  return json({ ok: true, saved: row });
});
