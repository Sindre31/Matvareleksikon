// Supabase Edge Function: ml-ingest-kassalapp
// -----------------------------------------------------------------------------
// Real shelf prices across the chains via the Kassalapp API (https://kassal.app),
// the source `billigkurv` uses. Writes source='kassalapp' rows into ml_offers
// (validity null = always current) with the same group_key scheme as the
// tilbudsaviser, so shelf prices and Tjek offers compare in one product group.
//
// Accumulate-by-default: every run ADDS/updates rows (upsert on external_id) and
// appends a daily point to ml_price_history, so historical prices and offers are
// kept. It never deletes unless the caller passes deleteFirst:true.
//
// Modes (POST JSON body):
//   {}                                  refresh default terms (add/update, no delete)
//   { terms:[...], pages:N }            add a batch for specific terms
//   { bulk:true, startPage:N, pages:M } page the whole /products catalogue
//   { bulk:true, restart:true }         start a fresh catalogue sweep (weekly cron)
//   { bulk:true, resume:true }          watchdog: continue a sweep whose chain died
//   { deleteFirst:true, ... }           opt in to wiping kassalapp rows first
// Requires the KASSALAPP_TOKEN secret; a no-op ({skipped}) without it.
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

const API = "https://kassal.app/api/v1";
const PAGE_SIZE = 100;
// Kept well under the platform's wall-clock limit: the upserts still have to run
// after the loop, and an invocation killed before it reaches dispatchNext takes
// the whole self-chain down with it. Measured 2026-07-28 with a 115 s budget:
// invocations landed at 120–125 s and the chain died at 77 % of the catalogue.
const TIME_BUDGET_MS = 95000;
// Checkpoint so a broken chain is resumable instead of lost (see ml_sweep_state).
const SWEEP_NAME = "kassalapp";
// A resume only takes over once nothing has advanced the checkpoint for this
// long. Otherwise a chain link is still working, and two invocations paging at
// once would break the one-call-at-a-time rate-limit invariant.
const RESUME_AFTER_MS = 240000;
// Kassalapp allows ~60 requests/minute per token ("1 kall per sekund"). One
// page fetch = one request, so hold ~1.1 s between them (~54/min) to stay under
// the cap; going faster earns 429s that silently drop pages (and the Rema/Kiwi
// products on them). Because the sweep self-chains sequentially (below), only
// one invocation is ever calling the API at a time, so this budget is global.
//
// This is the interval between request *starts*, not a sleep bolted onto the
// end of each one. A flat post-fetch sleep double-counts: the fetch itself
// takes ~1.6 s, so 1.1 s of extra sleep paced the sweep at ~2.9 s/page — about
// 21 req/min, a third of what the token allows, and the reason a 90-page range
// only got through ~41 pages inside the time budget (measured on the 2026-07-27
// run). Sleeping only the remainder keeps the promised 1 call/second and reads
// ~50 % more of the catalogue per invocation.
const BULK_INTERVAL_MS = 1100;
// Safety stop for the self-chaining bulk sweep. The catalogue does not report
// `last_page` at all (measured: it is absent on every page), so end-of-
// catalogue is detected from a short page and this is the only hard backstop.
// The catalogue currently runs to ~2450 pages (~245 000 products), so 5000
// leaves plenty of head-room.
const MAX_BULK_PAGE = 5000;
// A page that fails is not the end of the catalogue. Skip past a few bad pages
// instead, and only give up the range when Kassalapp is clearly down.
const MAX_CONSECUTIVE_PAGE_FAILURES = 3;

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
  // Coop Extra only. Coop's other chains (Mega, Prix, Marked, Obs) run their
  // own campaigns at their own prices — comparing this week's flyers, they
  // share only a handful of lines with Extra and rarely at the same price — so
  // folding them into `extra` would report a price Extra never charged.
  if (s.includes("coop extra") || s === "extra" || s.includes(" extra")) return "extra";
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
// Kassalapp reports current_unit_price against the BASE unit even when
// weight_unit is the pack's own ("Pepsi Max 1,5l x4": weight 6000 ml,
// unit price 14,98 = 89,90 / 6 l), so fold the pack unit to l / kg / stk.
function baseUnit(u: unknown): string | null {
  const s = String(u ?? "").toLowerCase().trim();
  if (s === "l" || s === "ml" || s === "cl" || s === "dl") return "l";
  if (s === "kg" || s === "hg" || s === "g") return "kg";
  if (s === "stk" || s === "pk" || s === "stykk") return "stk";
  return null;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Returns the page's rows plus the catalogue's last_page (Laravel pagination
// metadata — under `meta` for resource collections, sometimes top-level), so the
// bulk sweep knows when it has reached the end instead of guessing a page cap.
// `data: null` signals a hard failure (after retrying 429s with backoff).
async function getPage(url: string, token: string): Promise<{ data: any[] | null; lastPage: number | null }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (res.ok) {
      const j = await res.json();
      const lastPage = typeof j?.meta?.last_page === "number" ? j.meta.last_page
        : (typeof j?.last_page === "number" ? j.last_page : null);
      return { data: j?.data ?? [], lastPage };
    }
    if (res.status === 429 && attempt < 3) { await sleep(2000 * attempt); continue; }
    console.error("kassalapp", res.status, url);
    return { data: null, lastPage: null };
  }
  return { data: null, lastPage: null };
}

// Fire-and-forget the next page range so the bulk sweep continues past this
// invocation's time budget — a sequential chain that walks the whole catalogue
// without ever running two invocations at once (keeping us under the rate cap).
// Uses the service-role key as the platform JWT; EdgeRuntime.waitUntil keeps the
// dispatch alive after this handler responds.
function dispatchNext(SB_URL: string, SB_KEY: string, startPage: number, pages: number) {
  const req = fetch(`${SB_URL}/functions/v1/ml-ingest-kassalapp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    body: JSON.stringify({ bulk: true, startPage, pages, deleteFirst: false, autochain: true }),
  }).then((r) => r.text()).catch((e) => console.error("chain dispatch failed", String(e)));
  const ER = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (ER && typeof ER.waitUntil === "function") ER.waitUntil(req);
}

// ── Sweep checkpoint ────────────────────────────────────────────────────────
// The bulk sweep is ~34 self-chained invocations. dispatchNext is fire-and-
// forget, so one lost link (an isolate killed on the wall-clock before it can
// fire) ends the run silently — there is no retry and nothing in the logs.
// Persisting the next page turns that unrecoverable chain into a resumable job:
// the chain stays the fast path, and a cron watchdog calling {resume:true}
// picks it up wherever it stopped.
type SweepState = { next_page: number; pages_done: number; updated_at: string; finished_at: string | null };
async function readSweep(SB_URL: string, sbHeaders: Record<string, string>): Promise<SweepState | null> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/ml_sweep_state?name=eq.${SWEEP_NAME}&select=next_page,pages_done,updated_at,finished_at`, { headers: sbHeaders });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] ? rows[0] as SweepState : null;
  } catch (e) { console.error("sweep state read failed", String(e)); return null; }
}
async function writeSweep(SB_URL: string, sbHeaders: Record<string, string>, patch: Record<string, unknown>) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/ml_sweep_state?name=eq.${SWEEP_NAME}`, {
      method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(patch),
    });
    if (!r.ok) console.error("sweep state write failed", r.status, await r.text());
  } catch (e) { console.error("sweep state write failed", String(e)); }
}

function rowFrom(p: any): any | null {
  const price = num(p?.current_price) ?? num(p?.price);
  const slug = storeSlug(p?.store?.name);
  if (price == null || price <= MIN_PRICE_NOK || !slug || !p?.name) return null;
  const hist = (p?.price_history ?? []).map((h: any) => h?.price).filter((x: any) => typeof x === "number");
  const recentMax = hist.length ? Math.max(...hist) : price;
  // Real markdown, not a price_history outlier: between 5% and 50% off. Kassalapp's
  // history occasionally holds junk-high values (wrong unit/size) that would look
  // like a 90% "offer" (e.g. Lutefisk 29,90 "fra" 299), so cap the before-price.
  const isOffer = recentMax > price * 1.05 && recentMax <= price * 2;
  return {
    external_id: "kassal:" + slug + ":" + nameSlug(p.name), store_id: slug, product_name: p.name,
    group_key: groupKey(p.name), price, pre_price: isOffer ? recentMax : null, unit: p?.weight_unit ?? null,
    // The source's own kilo-/litre price. The client still prefers the size in
    // the product name and only falls back to this, so it can add a per-unit
    // figure where the name states none, never override a parsed one.
    unit_price: num(p?.current_unit_price), unit_price_unit: baseUnit(p?.weight_unit),
    offer_text: isOffer ? "Nedsatt pris" : null, image_url: p?.image ?? null,
    valid_from: null, valid_until: null, source: "kassalapp",
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

Deno.serve(async (req: Request) => {
  const token = (Deno.env.get("KASSALAPP_TOKEN") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ skipped: true, reason: "KASSALAPP_TOKEN ikke satt" });
  const SB_URL = Deno.env.get("SUPABASE_URL"), SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB_URL || !SB_KEY) return json({ error: "Service role not available" }, 500);
  const sbHeaders = { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  const body = await req.json().catch(() => ({} as any));
  // Accumulate by default: only wipe existing kassalapp rows when the caller
  // explicitly asks (deleteFirst:true). Every run otherwise ADDS/updates prices
  // (upsert on external_id) and appends history, so historical prices and
  // offers are preserved.
  const deleteFirst = body.deleteFirst === true;
  const bulk = !!body.bulk;
  // An upper bound on the range, not a promise: TIME_BUDGET_MS is what actually
  // ends a run, and the sweep self-chains from wherever it stopped, so the whole
  // catalogue is covered either way. At the measured ~1.5 s/page a range gets
  // through ~55 pages before the budget bites.
  const pages = Math.max(1, Number(body.pages) || (bulk ? 90 : 2));
  const autochain = body.autochain !== false; // bulk self-continuation, on by default
  const terms: string[] = Array.isArray(body.terms) && body.terms.length ? body.terms : DEFAULT_TERMS;

  // Where this range starts. Three bulk entry points:
  //   {restart:true}  a fresh sweep from page 1 (the weekly cron)
  //   {resume:true}   the watchdog — continue from the checkpoint, but only if
  //                   the sweep is unfinished AND no chain link is still active
  //   {startPage:N}   an explicit range: the chain's own links, and manual runs
  const nowIso = () => new Date().toISOString();
  let startPage = Math.max(1, Number(body.startPage) || 1);
  let sweepState: SweepState | null = null;
  if (bulk) {
    sweepState = await readSweep(SB_URL, sbHeaders);
    if (body.restart === true) {
      startPage = 1;
      await writeSweep(SB_URL, sbHeaders, { next_page: 1, pages_done: 0, started_at: nowIso(), updated_at: nowIso(), finished_at: null, last_note: "restart" });
      sweepState = null;
    } else if (body.resume === true) {
      if (sweepState?.finished_at) {
        return json({ skipped: true, reason: "sweep already finished", finishedAt: sweepState.finished_at, pagesDone: sweepState.pages_done });
      }
      const ageMs = sweepState ? Date.now() - Date.parse(sweepState.updated_at) : Infinity;
      if (ageMs < RESUME_AFTER_MS) {
        return json({ skipped: true, reason: "chain still active", ageMs, nextPage: sweepState?.next_page ?? null });
      }
      startPage = Math.max(1, sweepState?.next_page ?? 1);
      console.log(`kassalapp: resuming dead chain at page ${startPage} (checkpoint ${Math.round(ageMs / 1000)} s stale)`);
    }
  }

  const start = Date.now();
  const byKey = new Map<string, any>();
  const add = (p: any) => { const r = rowFrom(p); if (!r) return; const prev = byKey.get(r.external_id); if (prev && Number(prev.price) <= r.price) return; byKey.set(r.external_id, r); };

  let lastPage = startPage - 1, hitEnd = false, catalogLastPage: number | null = null;
  let skippedPages = 0, consecutiveFailures = 0, pagesRead = 0;
  if (bulk) {
    for (let page = startPage; page < startPage + pages; page++) {
      if (Date.now() - start > TIME_BUDGET_MS) break;
      const pageStart = Date.now();
      const { data, lastPage: metaLast } = await getPage(`${API}/products?size=${PAGE_SIZE}&page=${page}`, token);
      lastPage = page;
      if (metaLast != null) catalogLastPage = metaLast;
      // A failed page is NOT the end of the catalogue. It used to be treated as
      // one, which silently truncated the sweep *and* stopped the self-chain:
      // a single 500 on page 200 of ~2450 left three quarters of the shelf
      // prices unread, and the run still reported success. Skip past the bad
      // page and keep going; only give up the range when Kassalapp is clearly
      // down, and even then chain onward so the rest is still swept.
      if (data == null) {
        skippedPages++;
        if (++consecutiveFailures >= MAX_CONSECUTIVE_PAGE_FAILURES) {
          console.error(`kassalapp: giving up range at page ${page} after ${consecutiveFailures} failures`);
          break;
        }
        await sleep(BULK_INTERVAL_MS * consecutiveFailures);
        continue;
      }
      consecutiveFailures = 0;
      pagesRead++;
      data.forEach(add);
      // End of catalogue: a short page, or we've reached the reported last_page.
      if (data.length < PAGE_SIZE || (catalogLastPage != null && page >= catalogLastPage)) { hitEnd = true; break; }
      // Hold the interval from this request's START, so the fetch's own latency
      // counts towards it instead of being added on top.
      const wait = pageStart + BULK_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
    }
  } else {
    for (const term of terms) {
      if (Date.now() - start > TIME_BUDGET_MS) break;
      for (let page = 1; page <= pages; page++) {
        const pageStart = Date.now();
        const { data } = await getPage(`${API}/products?search=${encodeURIComponent(term)}&size=${PAGE_SIZE}&page=${page}`, token);
        if (data == null) break;
        pagesRead++;
        data.forEach(add);
        if (data.length < PAGE_SIZE) break;
        const wait = pageStart + BULK_INTERVAL_MS - Date.now();
        if (wait > 0) await sleep(wait);
      }
    }
  }

  // Pacing is measured over the fetch loop alone — the upserts below are our
  // own database time and would flatter the req/min figure.
  const loopMs = Date.now() - start;

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
  for (const r of rows) { const k = r.group_key + "|" + r.store_id; if (betterHistoryRow(r, histMap.get(k))) histMap.set(k, r); }
  const historyRows = [...histMap.values()].map((r) => ({ group_key: r.group_key, store_id: r.store_id, product_name: r.product_name, image_url: r.image_url, price: r.price, pre_price: r.pre_price, is_offer: r.pre_price != null, observed_at: today }));
  let historyInserted = 0;
  for (let i = 0; i < historyRows.length; i += 500) {
    const chunk = historyRows.slice(i, i + 500);
    const res = await fetch(`${SB_URL}/rest/v1/ml_price_history?on_conflict=group_key,store_id,observed_at`, { method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(chunk) });
    if (res.ok) historyInserted += chunk.length; else console.error("history failed", res.status, await res.text());
  }

  const backfillInserted = await backfillPreviousWeek(SB_URL, sbHeaders, historyRows, today);

  // Checkpoint BEFORE dispatching the next link, so a link that dies on the
  // wall-clock still leaves a resumable position behind.
  if (bulk && lastPage >= startPage) {
    await writeSweep(SB_URL, sbHeaders, {
      next_page: hitEnd ? lastPage : lastPage + 1,
      pages_done: (sweepState?.pages_done ?? 0) + pagesRead,
      updated_at: nowIso(),
      finished_at: hitEnd ? nowIso() : null,
      last_note: hitEnd ? `finished at page ${lastPage}` : `swept ${startPage}-${lastPage}`,
    });
  }

  // Self-chain: if this was a bulk range that stopped on its time budget (not at
  // the catalogue's end), kick off the next range so a single weekly trigger
  // walks the whole catalogue, one invocation at a time.
  const nextPage = lastPage + 1;
  let chained = false;
  if (bulk && autochain && !hitEnd && lastPage >= startPage && nextPage <= MAX_BULK_PAGE
      && (catalogLastPage == null || nextPage <= catalogLastPage)) {
    dispatchNext(SB_URL, SB_KEY, nextPage, pages);
    chained = true;
  }

  const elapsedMs = Date.now() - start;
  return json({
    mode: bulk ? "bulk" : "search", productsFound: rows.length, inserted, historyInserted, backfillInserted,
    lastPage, catalogLastPage, hitEnd, skippedPages, chained, nextPage: bulk && !hitEnd ? nextPage : null,
    // Pacing, so a slowdown at the source is visible instead of silently
    // halving how much of the catalogue a run covers.
    pagesRead, msPerPage: pagesRead ? Math.round(loopMs / pagesRead) : null,
    reqPerMin: pagesRead ? Math.round(60000 / (loopMs / pagesRead)) : null,
    elapsedMs,
  });
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
