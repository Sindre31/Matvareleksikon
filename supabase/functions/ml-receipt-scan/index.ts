// Supabase Edge Function: ml-receipt-scan
// -----------------------------------------------------------------------------
// Server-side receipt OCR for Prisboka, adapted from the approach proven in the
// author's `billigkurv` project: send the photo to Google Gemini (vision) with
// a Norwegian prompt tuned for grocery receipts, validate the JSON, and return
// clean line items. The Gemini API key stays server-side (Supabase secret) and
// never reaches the browser.
//
// Protection (why verify_jwt is disabled): this is a public contribution
// endpoint, but every call costs a vision request, so it enforces its own
// guards — per-IP rate limiting (ml_scan_allow RPC), plus size and MIME checks.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") || "gemini-flash-latest";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const RATE_LIMIT = 30;        // scans …
const RATE_WINDOW_SECS = 3600; // … per hour per IP

// Map whatever chain Gemini recognises onto Prisboka's four stores.
const CHAIN_TO_STORE: Record<string, string> = {
  "kiwi": "Kiwi",
  "rema": "Rema 1000", "rema 1000": "Rema 1000", "rema-1000": "Rema 1000", "rema1000": "Rema 1000",
  "extra": "Extra", "coop extra": "Extra", "coop-extra": "Extra",
  "meny": "Meny",
};
function storeFromText(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).toLowerCase();
  for (const key of Object.keys(CHAIN_TO_STORE)) if (s.includes(key)) return CHAIN_TO_STORE[key];
  return null;
}

const SYSTEM_PROMPT = `Du leser et bilde av en norsk dagligvarekvittering og returnerer KUN gyldig JSON.

Returner nøyaktig denne strukturen, uten tekst før eller etter:

{
  "storeName": "string | null",
  "storeSlug": "kiwi | rema-1000 | coop-extra | meny | null",
  "purchaseDate": "YYYY-MM-DD | null",
  "items": [
    {
      "name": "string",
      "unitPrice": number | null,
      "quantity": number | null,
      "lineTotal": number | null,
      "unit": "string | null",
      "category": "string | null"
    }
  ]
}

Regler:
- "storeName" er butikknavnet slik det står øverst på kvitteringen.
- "storeSlug" er kiwi, rema-1000, coop-extra eller meny hvis du kjenner igjen kjeden, ellers null.
- Hver vare i "items" er én kjøpt varelinje. Bruk punktum som desimaltegn (42.90).
- "lineTotal" er totalsummen som ble belastet for linja.
- VEKT-/ANTALLSVARER: under eller på varelinja står det ofte «0,750 kg x 24,90 kr/kg»
  eller «3 stk x 12,90». Da skal:
    "quantity" = mengden (0.75 eller 3),
    "unitPrice" = prisen per enhet (24.90 eller 12.90),
    "unit"      = enheten ("kg" eller "stk"),
    "lineTotal" = totalen for linja (18.68 eller 38.70).
  Det er VIKTIG å få med vekten/antallet — ellers blir kiloprisen feil.
- VANLIG PAKKEVARE (kun én pris på linja, f.eks. melk til 19,90): sett
  "lineTotal" = prisen, "unitPrice" = null, "quantity" = null.
- Mange kvitteringer har en mva-kode ("15%"/"25%") mellom varenavn og pris — den
  er IKKE en del av navnet og IKKE prisen.
- IKKE ta med: totalsum ("Sum", "SUM"), mva-linjer, pant, rabatt/«du sparte»,
  betalingslinjer (BANK/kort), bonus/Trumf, byttelapp. Kun faktiske varer.
- Rens varenavn til lesbar form og behold mengde/størrelse (f.eks.
  "LETTMELK 1L" -> "Lettmelk 1L").
- "category" er en grov kategori (meieri, kjøtt, frukt og grønt, ...) hvis mulig, ellers null.
- Hvis bildet ikke er en kvittering, returner items som tom liste.`;

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

interface RawItem {
  name?: unknown; unitPrice?: unknown; quantity?: unknown; lineTotal?: unknown;
  unit?: unknown; category?: unknown;
}
interface LineItem { name: string; price: number; unit: string | null; quantity: number | null; lineTotal: number | null; category: string | null; }

const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) && v > 0 ? v : null);

// Canonical price: prefer the receipt's unit price (kr/kg); else lineTotal/quantity
// (so 18,68 kr for 0,750 kg bananas becomes 24,90 kr/kg); else the line total.
function normalizeItem(raw: RawItem): LineItem | null {
  const name = typeof raw?.name === "string" ? raw.name.trim() : "";
  if (!name) return null;
  const unitPrice = num(raw?.unitPrice), quantity = num(raw?.quantity), lineTotal = num(raw?.lineTotal);
  let price: number | null = null;
  if (unitPrice) price = unitPrice;
  else if (quantity && lineTotal) price = lineTotal / quantity;
  else if (lineTotal) price = lineTotal;
  if (price == null || !(price > 0) || price > 100000) return null;
  return {
    name,
    price: Number(price.toFixed(2)),
    unit: typeof raw?.unit === "string" ? raw.unit.trim() : null,
    quantity, lineTotal,
    category: typeof raw?.category === "string" ? raw.category.trim() : null,
  };
}

function parseImage(image: string, fallbackMime?: string): { data: string; mimeType: string } {
  const m = image.match(/^data:([^;]+);base64,([\s\S]*)$/);
  if (m) return { mimeType: m[1], data: m[2] };
  return { data: image, mimeType: fallbackMime || "image/jpeg" };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function rateLimitAllows(ip: string): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return true; // fail open if service role isn't available
  const res = await fetch(`${url}/rest/v1/rpc/ml_scan_allow`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ p_ip: ip, p_limit: RATE_LIMIT, p_window_secs: RATE_WINDOW_SECS }),
  });
  if (!res.ok) return true;
  return (await res.json()) === true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function requestGemini(parts: unknown[], apiKey: string): Promise<string> {
  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
  };
  const backoff = [500, 1200, 2500];
  let lastReason = "ukjent feil";
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(`${API_BASE}/${GEMINI_MODEL}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(t);
      const data = await res.json();
      if (res.ok) {
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text as string;
        lastReason = "tomt svar";
      } else {
        console.error("gemini", GEMINI_MODEL, res.status, JSON.stringify(data)?.slice(0, 400));
        if (!RETRYABLE.has(res.status)) {
          throw new Error("Klarte ikke å kontakte AI-tjenesten. Sjekk at GEMINI_API_KEY er gyldig.");
        }
        lastReason = `HTTP ${res.status}`;
      }
    } catch (err) {
      clearTimeout(t);
      if (err instanceof Error && err.message.startsWith("Klarte ikke")) throw err;
      lastReason = err instanceof Error && err.name === "AbortError" ? "timeout" : "nettverksfeil";
    }
    if (attempt < 2) await sleep(backoff[attempt]);
  }
  throw new Error(`Klarte ikke å lese kvitteringen (${lastReason}). Prøv igjen om litt.`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const apiKey = Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_API_KEY");
  if (!apiKey) return json({ error: "AI-tjenesten er ikke konfigurert (mangler GEMINI_API_KEY)." }, 503);

  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  try {
    if (!(await rateLimitAllows(ip))) {
      return json({ error: "For mange skanninger på kort tid. Vent litt og prøv igjen." }, 429);
    }
  } catch (_) { /* fail open */ }

  let body: { image?: unknown; mimeType?: unknown };
  try { body = await req.json(); } catch { return json({ error: "Ugyldig forespørsel." }, 400); }
  const image = body?.image;
  if (typeof image !== "string" || image.length < 100) return json({ error: "Bildet mangler eller er for lite." }, 400);

  const { data, mimeType } = parseImage(image, typeof body?.mimeType === "string" ? body.mimeType : undefined);
  if (data.length > 8_000_000) return json({ error: "Bildet er for stort. Prøv et mindre bilde." }, 413);
  if (!["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(mimeType)) {
    return json({ error: "Ugyldig bildeformat. Bruk JPG, PNG eller WEBP." }, 400);
  }

  let raw: string;
  try {
    raw = await requestGemini(
      [{ text: "Les denne kvitteringen og returner JSON som beskrevet." }, { inline_data: { mime_type: mimeType, data } }],
      apiKey,
    );
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "AI-feil." }, 502);
  }

  let parsed: { items?: unknown; storeName?: unknown; storeSlug?: unknown; purchaseDate?: unknown };
  try { parsed = JSON.parse(extractJson(raw)); } catch {
    return json({ error: "AI-en returnerte et svar vi ikke klarte å tolke. Prøv et tydeligere bilde." }, 502);
  }

  const items = (Array.isArray(parsed?.items) ? parsed.items : [])
    .map((it) => normalizeItem(it as RawItem))
    .filter((it): it is LineItem => it !== null);

  const store = storeFromText(parsed?.storeSlug as string) || storeFromText(parsed?.storeName as string);
  return json({
    store,
    storeName: typeof parsed?.storeName === "string" ? parsed.storeName : null,
    purchaseDate: typeof parsed?.purchaseDate === "string" ? parsed.purchaseDate : null,
    items,
    model: GEMINI_MODEL,
  }, 200);
});
