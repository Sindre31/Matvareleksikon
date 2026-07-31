// Supabase Edge Function: ml-admin
// -----------------------------------------------------------------------------
// The password-protected back office for Prisboka: the report queue, and editing
// / removing / restoring products.
//
// Why this exists at all: the browser key is a PUBLISHABLE key. Every write path
// the front end has is guarded by RLS (anyone may insert a registration or a
// report; nobody may update or delete anything), so an admin screen cannot do
// its work from the browser — a password checked in JavaScript guards nothing
// when the key that would perform the write is public. The edits therefore
// happen HERE, with the service-role key that never leaves the server, and the
// password is a Supabase secret.
//
// Set it before use (Dashboard → Project settings → Edge Functions → Secrets,
// or `supabase secrets set ADMIN_PASSWORD=…`). Without the secret the function
// refuses every request, including login — there is no default password.
//
// Protection (why verify_jwt is disabled): the anon key the front end would send
// is public, so it proves nothing; this function does its own auth instead.
//   * password compared in constant time, never logged, never echoed
//   * failed logins are rate-limited per IP (ml_scan_allow), plus a global cap
//   * a session is a signed token (HMAC-SHA256, key derived from the password),
//     so changing the password invalidates every outstanding session
//   * every database call goes through a typed ml_admin_* RPC — product names
//     are full of commas and dots, which PostgREST reads as filter syntax
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SESSION_SECS = 12 * 3600;   // a working session, then log in again
const LOGIN_LIMIT = 10;           // failed logins …
const LOGIN_WINDOW = 900;         // … per 15 min per IP
const LOGIN_GLOBAL = 200;         // and per hour across everyone

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const enc = new TextEncoder();

function clientIp(req: Request): string | null {
  const h = req.headers;
  const v = h.get("cf-connecting-ip") || h.get("x-real-ip") ||
    (h.get("x-forwarded-for") || "").split(",")[0];
  return v && v.trim() ? v.trim() : null;
}

// Constant-time: a length-independent compare so a wrong password can't be
// narrowed down by timing it.
function sameSecret(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(password: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode("prisboka-admin|" + password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
}

// A token is "<expiry>.<signature>" — no session table to keep, and no way to
// mint one without the password.
async function mintToken(password: string): Promise<{ token: string; expiresAt: number }> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECS;
  return { token: `${exp}.${await sign(password, String(exp))}`, expiresAt: exp };
}

async function validToken(password: string, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || token.length > 400) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  if (!isFinite(exp) || exp * 1000 < Date.now()) return false;
  return sameSecret(token.slice(dot + 1), await sign(password, String(exp)));
}

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return isFinite(n) ? n : null;
};
const str = (v: unknown, max = 200): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const PASSWORD = Deno.env.get("ADMIN_PASSWORD") || "";
  const SB_URL = Deno.env.get("SUPABASE_URL");
  const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB_URL || !SB_KEY) return json({ error: "Service role not available" }, 500);
  if (!PASSWORD) {
    return json({ error: "Adminsiden er ikke satt opp: ADMIN_PASSWORD mangler som secret." }, 503);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Ugyldig forespørsel" }, 400); }

  const sbHeaders = { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
      method: "POST", headers: sbHeaders, body: JSON.stringify(args),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`${fn} failed:`, res.status, text);
      let msg = "Databasen avviste operasjonen.";
      try { msg = JSON.parse(text).message || msg; } catch { /* keep the generic message */ }
      throw new Error(msg);
    }
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  };
  const allow = async (key: string, limit: number, window: number): Promise<boolean> => {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/rpc/ml_scan_allow`, {
        method: "POST", headers: sbHeaders,
        body: JSON.stringify({ p_ip: key, p_limit: limit, p_window_secs: window }),
      });
      return r.ok ? (await r.json()) !== false : true;   // limiter down ≠ locked out
    } catch { return true; }
  };

  const action = String(body.action || "");

  // ── Login ────────────────────────────────────────────────────────────────
  // The IP budget is spent on FAILED attempts only, so a working password never
  // locks the admin out of their own back office.
  if (action === "login") {
    const ip = clientIp(req);
    if (!await allow("admin:GLOBAL", LOGIN_GLOBAL, 3600)) {
      return json({ error: "For mange innloggingsforsøk akkurat nå. Prøv igjen senere." }, 429);
    }
    const ok = typeof body.password === "string" && sameSecret(body.password, PASSWORD);
    if (!ok) {
      if (ip && !await allow(`admin:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW)) {
        return json({ error: "For mange forsøk. Prøv igjen om et kvarter." }, 429);
      }
      return json({ error: "Feil passord." }, 401);
    }
    return json(await mintToken(PASSWORD));
  }

  // ── Everything else needs a valid session ────────────────────────────────
  if (!await validToken(PASSWORD, body.token)) {
    return json({ error: "Økten har gått ut. Logg inn på nytt." }, 401);
  }

  try {
    switch (action) {
      case "session":
        return json({ ok: true });

      case "stats": {
        const rows = await rpc("ml_admin_stats", {});
        return json({ stats: Array.isArray(rows) ? rows[0] : rows });
      }

      case "reports": {
        const rows = await rpc("ml_admin_reports", {
          p_status: str(body.status, 20) || "open",
          p_limit: Math.min(Math.max(Number(body.limit) || 200, 1), 500),
        });
        return json({ reports: rows || [] });
      }

      case "search": {
        const rows = await rpc("ml_admin_search", {
          p_q: str(body.q, 100),
          p_store: str(body.store, 40),
          p_limit: Math.min(Math.max(Number(body.limit) || 60, 1), 200),
        });
        return json({ products: rows || [] });
      }

      case "overrides": {
        const rows = await rpc("ml_admin_overrides", {
          p_limit: Math.min(Math.max(Number(body.limit) || 200, 1), 500),
        });
        return json({ products: rows || [] });
      }

      case "save": {
        const store = str(body.store_id, 40), name = str(body.product_name, 300);
        if (!store || !name) return json({ error: "Mangler butikk eller produkt." }, 400);
        const price = num(body.new_price);
        if (price !== null && !(price > 0 && price <= 100000)) {
          return json({ error: "Prisen må være mellom 0 og 100 000 kr." }, 400);
        }
        await rpc("ml_admin_save", {
          p_store: store, p_name: name,
          p_new_name: str(body.new_name, 120),
          p_new_price: price,
          p_clear_pre: body.clear_pre_price === true,
          p_hidden: body.hidden === true,
          p_note: str(body.note, 300),
        });
        return json({ ok: true });
      }

      case "reset": {
        const store = str(body.store_id, 40), name = str(body.product_name, 300);
        if (!store || !name) return json({ error: "Mangler butikk eller produkt." }, 400);
        await rpc("ml_admin_reset", { p_store: store, p_name: name });
        return json({ ok: true });
      }

      case "report_status": {
        const id = str(body.id, 40), status = str(body.status, 20);
        if (!id || !status) return json({ error: "Mangler rapport eller status." }, 400);
        await rpc("ml_admin_set_report", { p_id: id, p_status: status });
        return json({ ok: true });
      }

      case "apply_report": {
        const id = str(body.id, 40);
        if (!id) return json({ error: "Mangler rapport." }, 400);
        await rpc("ml_admin_apply_report", { p_id: id });
        return json({ ok: true });
      }

      default:
        return json({ error: "Ukjent handling." }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message || "Noe gikk galt." }, 500);
  }
});
