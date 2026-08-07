// Supabase Edge Function: ml-ingest-oda
// -----------------------------------------------------------------------------
// Real Oda (oda.com, formerly Kolonial.no) shelf prices from Oda's public
// product search API (keyless). Oda is a single online store, so every hit maps
// to the 'oda' store. We ingest into ml_offers (source='oda') with the shared
// group_key scheme, plus product images and price history.
//
// Modes (POST JSON body):
//   {}                        one range from term 0 (manual smoke test)
//   { restart:true }          a fresh sweep from the first term (the weekly cron)
//   { resume:true }           watchdog: continue a sweep whose chain died
//   { startTerm:N }           an explicit range: the chain's own links, and
//                             manual runs
//   { terms:[...] }           sweep specific terms instead of TERMS
//   { deleteFirst:true }      wipe the existing oda rows before inserting
//
// ── Why this reads /search/ and pages it ────────────────────────────────────
// It used to call /search/mixed/ once per term and keep whatever page 1 held —
// 33 items of MIXED types (categories and recipes among them), so ~20 products
// per term and 1 237 products in total. That left Oda under `MIN_STORE_PRICES`
// (1500) and therefore hidden from the whole app: no grid rows, no filter chip,
// no line in "hva koster lista i hver butikk".
//
// /search/?q=<term> is the products-only endpoint. It reports `total_hits`,
// returns 40 products per page and pages properly, so a term now yields every
// product it matches instead of the first screenful. Measured 2026-08-07 over
// the same 56 terms: 274 requests, **4 913 unique products**, of which 4 750
// survive the floor and the availability check below and become rows — 4x the
// old figure and three times over the coverage bar.
//
// Two hard limits found by probing, both respected below:
//   • a page beyond 49 answers 422, so ~1 960 products is the most any single
//     query can retrieve. No term here comes near it (the widest, "melk", ends
//     at page 15 = its full 565 hits), but MAX_PAGE keeps a future one honest.
//   • `filters=`/`category=` are accepted and silently IGNORED — there is no
//     category listing endpoint (every /categories/ path 404s and the category
//     pages render client-side), so a term list is the only way to sweep.
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
// oda.com/robots.txt states the policy for crawlers in so many words: send a
// User-Agent carrying "bot", a program name and a way to reach us, and back off
// on 429/5xx honouring Retry-After. "Failure to comply may result in your
// traffic being blocked." This used to send a copied Chrome string, which is
// exactly what that asks us not to do — and it made us anonymous to the one
// team who would otherwise just tell us to slow down. Identify honestly; the
// backoff below is the other half of the bargain.
const UA = "matvareleksikon-bot/1.0 (+https://matvareleksikon.vercel.app; https://github.com/Sindre31/Matvareleksikon)";

// The API's own page size — not a parameter. `page_size`/`limit` are ignored
// (measured), so this is fixed at what /search/ returns, and a page holding
// fewer than this many products is the last one.
const PAGE_SIZE = 40;
// Page 50 and beyond answer 422 Unprocessable Entity, whatever the query.
const MAX_PAGE = 49;
// Kept under the platform's wall-clock limit: the upserts still have to run
// after the loop, and an invocation killed before it reaches dispatchNext takes
// the whole self-chain down with it (see the Kassalapp sweep, which learned
// this the expensive way).
const TIME_BUDGET_MS = 95000;
// Checkpoint so a broken chain is resumable instead of lost (see ml_sweep_state).
const SWEEP_NAME = "oda";
// A resume only takes over once nothing has advanced the checkpoint for this
// long. Otherwise a chain link is still working, and two invocations sweeping
// at once would double the load Oda sees from us.
const RESUME_AFTER_MS = 240000;
// Interval between request *starts*, not a sleep bolted onto each one — a flat
// post-fetch sleep double-counts the fetch (the Kassalapp sweep measured that
// mistake at half the catalogue per invocation). Oda publishes no rate limit,
// only "handle 429/5xx with exponential backoff", so this is politeness rather
// than a ceiling we were given: ~3 requests/second at most, and in practice the
// fetch itself takes far longer than this, so it rarely sleeps at all.
const REQUEST_INTERVAL_MS = 350;
// A term that fails is not the end of the sweep. Skip past a few bad pages
// rather than abandon the range, and only give up when Oda is clearly down.
const MAX_CONSECUTIVE_FAILURES = 4;
// Safety stop for the self-chaining sweep, mirroring MAX_BULK_PAGE next door.
const MAX_TERM_INDEX = 5000;

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function num(v: unknown): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") { const n = Number(v.replace(",", ".")); return isFinite(n) ? n : null; }
  return null;
}

// Oda's `full_name` does NOT state the pack size — it lives in `name_extra`
// ("Tine Lettmelk 1% fett" + "1% fett, 1,75 l"). Two consequences, both of
// which were live bugs:
//
//   • the 1 l and the 1,75 l carton share a full_name, so the old
//     external_id (a slug of the name) collided and one of the two was
//     dropped. Measured over 4 913 products: 106 colliding slugs, 117 products
//     silently lost. `id` is unique across the same set and is now the key.
//   • a size-less name is a size-less product card: "Tine Lettmelk 1% fett" at
//     21,50 and at 35,70, with nothing on screen saying why they differ, and
//     nothing for app.js's parseAmount to read a per-litre price out of.
//
// So the size is appended to the name — but ONLY the size token itself, never
// the whole of name_extra. name_extra also carries purchase limits ("Maks 10
// per kunde", "Maks 3 til nedsatt pris") and hedges ("ca."), and those are
// words: folding them in shifted the group_key of 301 of 4 913 products —
// Pepsi Max, Solo, Grandiosa, Norvegia, the popular lines precisely — which
// would have unpicked them from every other chain's rows in the same group.
// Appending the bare size instead is invisible to group_key, which strips
// sizes: measured 0 keys changed of 4 913, and 0 remaining duplicate names.
const PCT_RE = /\d+([.,]\d+)?\s*%/g;
const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(kg|hg|g|ml|cl|dl|l|stk)\b/gi;
function sizeToken(extra: string | null | undefined): string | null {
  const s = String(extra ?? "").replace(PCT_RE, " ");
  // The LAST size in name_extra is the pack ("12 x 85 g", "Middagskit, 685 g").
  let last: string | null = null;
  SIZE_RE.lastIndex = 0;
  for (let m = SIZE_RE.exec(s); m; m = SIZE_RE.exec(s)) last = m[0].trim().replace(/\s+/g, " ");
  return last;
}
function productName(p: Record<string, any>): string {
  const base = String(p?.full_name || p?.name || "").trim();
  const size = sizeToken(p?.name_extra);
  // Don't restate a size the name already ends with (390 of 4 913 carry one).
  if (!size || base.toLowerCase().includes(size.toLowerCase())) return base;
  return `${base} ${size}`;
}

// A before-price, but only where Oda means one. `discount` covers three kinds
// of campaign and only one of them is a markdown on the single unit:
//
//   price_discount      130 seen, 110 with undiscounted_gross_price above the
//                       shelf price — a real "før 53,80, nå 26,80".
//   fixed_price_bundle   60 seen, 0 with a higher undiscounted price
//   mix_and_match        54 seen, 0 with a higher undiscounted price
//
// The bundles quote undiscounted == gross_price, because the saving only
// exists once you buy three of them. Reporting that as an offer would put a
// 0 %-off badge on the card and, worse, feed backfillPreviousWeek a "last
// week's price" identical to this week's. Hence the type gate AND the
// above-the-price test — either alone would let something through.
function prePriceOf(p: Record<string, any>, price: number): number | null {
  const d = p?.discount;
  if (!d || d.is_discounted !== true || d.discount_type !== "price_discount") return null;
  const before = num(d.undiscounted_gross_price);
  return before != null && before > price ? before : null;
}

// A price you cannot pay is not a price. `availability.code` is 'available' on
// 4 744 of 4 913, and the rest are sold_out (16), sold_out_supplier (103) or
// available_later (44) — real products, but not ones this week's basket can be
// priced against, and a comparison that quotes them makes Oda look cheaper
// than it is. available_weekdays (6) IS purchasable, just not every day.
function isPurchasable(p: Record<string, any>): boolean {
  const code = String(p?.availability?.code ?? "");
  return code === "available" || code === "available_weekdays";
}

function rowFrom(p: Record<string, any>): Record<string, unknown> | null {
  const price = num(p?.gross_price);
  const name = productName(p);
  const id = p?.id;
  if (price == null || price <= MIN_PRICE_NOK || !name || id == null) return null;
  if (p?.currency && p.currency !== "NOK") return null;
  if (!isPurchasable(p)) return null;
  const img = p?.images?.[0]?.thumbnail?.url || p?.images?.[0]?.large?.url || null;
  const unitAbbr = p?.unit_price_quantity_abbreviation ?? null;
  return {
    external_id: "oda:" + id, store_id: STORE, product_name: name,
    group_key: groupKey(name), price, pre_price: prePriceOf(p, price),
    unit: unitAbbr, unit_price: num(p?.gross_unit_price), unit_price_unit: unitAbbr,
    // Oda's campaign discounts carry no end date (active_until was null on all
    // 244 seen), so these are shelf prices with no stated validity, like the
    // other shelf-price sources. Leaving valid_until null keeps them current.
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
function nameAmount(name: string): { value: number; dim: string } | null {
  const s = String(name ?? "").toLowerCase().replace(PCT_RE, " ");
  let best: { value: number; dim: string } | null = null;
  SIZE_RE.lastIndex = 0;
  for (const m of s.matchAll(SIZE_RE)) {
    const n = Number(m[1].replace(",", "."));
    if (!isFinite(n) || n <= 0) continue;
    const u = m[2].toLowerCase();
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
// otherwise derived from the size in the name. Oda states gross_unit_price on
// every product measured (4 913 of 4 913), so this almost always takes the
// first branch.
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

// ── Oda fetch, with the backoff their robots.txt asks for ───────────────────
// 429 and 5xx are retried with exponential backoff, honouring Retry-After when
// it is sent. A page that still fails after this returns null and the caller
// treats it as a bad page, not as the end of the term.
async function getPage(term: string, page: number): Promise<Record<string, any> | null> {
  const url = `${API}/search/?q=${encodeURIComponent(term)}&page=${page}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA } });
      if (res.ok) return await res.json();
      // 422 is how the API says "past the last page"; not an error worth retrying.
      if (res.status === 422) return null;
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        const waitMs = isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * Math.pow(2, attempt);
        console.warn(`oda ${res.status} on "${term}" p${page}, waiting ${waitMs} ms`);
        await sleep(waitMs);
        continue;
      }
      console.error("oda", res.status, term, page);
      return null;
    } catch (e) {
      console.error("oda fetch", term, page, String(e));
      await sleep(1000 * Math.pow(2, attempt));
    }
  }
  return null;
}

// Self-chaining: one range hands the next its starting term, so a single weekly
// trigger walks every term one invocation at a time. Uses the service-role key
// as the platform JWT; EdgeRuntime.waitUntil keeps the dispatch alive after
// this handler has already responded.
function dispatchNext(SB_URL: string, SB_KEY: string, startTerm: number) {
  const req = fetch(`${SB_URL}/functions/v1/ml-ingest-oda`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    body: JSON.stringify({ startTerm, autochain: true }),
  }).then((r) => r.text()).catch((e) => console.error("chain dispatch failed", String(e)));
  const ER = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (ER && typeof ER.waitUntil === "function") ER.waitUntil(req);
}

// ── Sweep checkpoint ────────────────────────────────────────────────────────
// Shares ml_sweep_state with the Kassalapp sweep, under name='oda'. next_page
// holds the next TERM INDEX here — the column is the position in whatever the
// sweep walks, and for this one that is TERMS, not pages.
//
// dispatchNext is fire-and-forget, so one lost link (an isolate killed on the
// wall-clock before it can fire) would end the run silently. Persisting the
// position turns that into a resumable job the ml-ingest-oda-resume cron picks
// up wherever it stopped.
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

Deno.serve(async (req: Request) => {
  const SB_URL = Deno.env.get("SUPABASE_URL"), SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB_URL || !SB_KEY) return json({ error: "Service role not available" }, 500);
  const sbHeaders = { "Content-Type": "application/json", apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  const body = await req.json().catch(() => ({} as Record<string, any>));
  const terms: string[] = Array.isArray(body.terms) && body.terms.length ? body.terms : TERMS;
  const autochain = body.autochain !== false;
  const nowIso = () => new Date().toISOString();

  // Where this range starts. Three entry points, mirroring the Kassalapp sweep:
  //   {restart:true}  a fresh sweep from term 0 (the weekly cron)
  //   {resume:true}   the watchdog — continue from the checkpoint, but only if
  //                   the sweep is unfinished AND no chain link is still active
  //   {startTerm:N}   an explicit range: the chain's own links, and manual runs
  let startTerm = Math.max(0, Number(body.startTerm) || 0);
  let sweepState: SweepState | null = await readSweep(SB_URL, sbHeaders);
  // The sweep deletes the previous week's rows ONCE, at restart, and every link
  // after that accumulates — deleting per invocation would wipe the rows the
  // earlier links just wrote. That leaves Oda partially stocked for the few
  // minutes a sweep runs (Monday ~06:30 Oslo, three or four links), which is
  // the price of not carrying last week's prices forward as if they were
  // today's. The resume watchdog is what keeps that window from becoming a week.
  let deleteFirst = body.deleteFirst === true;
  if (body.restart === true) {
    startTerm = 0;
    deleteFirst = body.deleteFirst !== false;
    await writeSweep(SB_URL, sbHeaders, { next_page: 0, pages_done: 0, started_at: nowIso(), updated_at: nowIso(), finished_at: null, last_note: "restart" });
    sweepState = null;
  } else if (body.resume === true) {
    if (sweepState?.finished_at) {
      return json({ skipped: true, reason: "sweep already finished", finishedAt: sweepState.finished_at, termsDone: sweepState.pages_done });
    }
    const ageMs = sweepState ? Date.now() - Date.parse(sweepState.updated_at) : Infinity;
    if (ageMs < RESUME_AFTER_MS) {
      return json({ skipped: true, reason: "chain still active", ageMs, nextTerm: sweepState?.next_page ?? null });
    }
    startTerm = Math.max(0, sweepState?.next_page ?? 0);
    console.log(`oda: resuming dead chain at term ${startTerm} (checkpoint ${Math.round(ageMs / 1000)} s stale)`);
  }

  const start = Date.now();
  const byKey = new Map<string, any>();
  let requests = 0, termsRead = 0, skippedTerms = 0, consecutiveFailures = 0;
  let lastTerm = startTerm - 1, hitEnd = false;
  let nextRequestAt = 0;

  for (let i = startTerm; i < terms.length && i < MAX_TERM_INDEX; i++) {
    if (Date.now() - start > TIME_BUDGET_MS) break;
    const term = terms[i];
    let termFailed = false, budgetCut = false;
    for (let page = 1; page <= MAX_PAGE; page++) {
      if (Date.now() - start > TIME_BUDGET_MS) { budgetCut = true; break; }
      // Pace by request STARTS, so the fetch's own latency counts toward the
      // interval instead of being added to it.
      const waitMs = nextRequestAt - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
      const data = await getPage(term, page);
      requests++;
      if (!data) { if (page === 1) termFailed = true; break; }
      const products: any[] = Array.isArray(data.products) ? data.products : [];
      for (const p of products) {
        const r = rowFrom(p);
        if (!r) continue;
        // Same product from two terms: keep the cheaper reading.
        const prev = byKey.get(r.external_id as string);
        if (prev && Number(prev.price) <= (r.price as number)) continue;
        byKey.set(r.external_id as string, r);
      }
      if (products.length < PAGE_SIZE) break;   // short page = last page
    }
    // A term the clock cut off mid-paging is NOT a term this range covered.
    // Advancing past it would leave the rest of its pages unread by anyone —
    // the next link starts where the checkpoint says, so a half-swept term is
    // a silent hole in the catalogue rather than a visible failure. Leave
    // lastTerm behind it and let the next link redo it whole; the rows already
    // collected are still written below, and re-reading a handful of pages is
    // cheaper than never reading them.
    if (budgetCut) break;
    lastTerm = i;
    if (termFailed) {
      skippedTerms++;
      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`oda: ${consecutiveFailures} terms failed in a row, ending range at ${i}`);
        break;
      }
    } else { termsRead++; consecutiveFailures = 0; }
  }
  if (lastTerm >= terms.length - 1) hitEnd = true;

  const rows = [...byKey.values()];

  if (deleteFirst) {
    await fetch(`${SB_URL}/rest/v1/ml_offers?source=eq.oda`, { method: "DELETE", headers: sbHeaders });
  }
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const res = await fetch(`${SB_URL}/rest/v1/ml_offers?on_conflict=external_id`, { method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(chunk) });
    if (res.ok) inserted += chunk.length; else console.error("upsert failed", res.status, await res.text());
  }

  // The day's history point per (group, store). Chaining put a wrinkle in this
  // that the single-invocation version could not have: a group's products are
  // spread across TERMS, so two links can each hold part of a group and each
  // write the day's row for it — and with merge-duplicates, the link that
  // finishes last wins rather than the one holding the best value. A group
  // whose litre carton was read in link 1 and whose half-litre was read in
  // link 3 would be charted at the half-litre's per-litre price.
  //
  // So the final link recomputes the day from the whole of ml_offers rather
  // than from what it happens to be holding. Every link still writes its own
  // rows first: a chain that dies before the end leaves an approximate chart
  // rather than none at all, and the last link corrects it.
  const today = new Date().toISOString().slice(0, 10);
  const histSource = hitEnd ? await readAllOdaRows(SB_URL, sbHeaders) ?? rows : rows;
  const histMap = new Map<string, any>();
  for (const r of histSource) { const k = r.group_key + "|" + r.store_id; if (betterHistoryRow(r, histMap.get(k))) histMap.set(k, r); }
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
  //
  // `lastTerm >= startTerm` is "this range finished at least one term". It can
  // only fail if the very first term ate the whole budget, which needs a term
  // to take 95 s — 49 pages is the most any term can be, so that means Oda is
  // rate-limiting us into the backoff. Deliberately neither checkpointed nor
  // chained then: advancing would skip the term, and re-dispatching would spin
  // a chain that makes no progress. The checkpoint goes stale instead and the
  // resume watchdog picks the same term up once Oda is answering again.
  if (lastTerm >= startTerm) {
    await writeSweep(SB_URL, sbHeaders, {
      next_page: lastTerm + 1,
      pages_done: (sweepState?.pages_done ?? 0) + termsRead,
      updated_at: nowIso(),
      finished_at: hitEnd ? nowIso() : null,
      last_note: hitEnd ? `finished at term ${lastTerm}` : `swept terms ${startTerm}-${lastTerm}`,
    });
  }

  const nextTerm = lastTerm + 1;
  let chained = false;
  if (autochain && !hitEnd && lastTerm >= startTerm && nextTerm < terms.length && nextTerm < MAX_TERM_INDEX) {
    dispatchNext(SB_URL, SB_KEY, nextTerm);
    chained = true;
  }

  const elapsedMs = Date.now() - start;
  return json({
    productsFound: rows.length, inserted, historyInserted, backfillInserted,
    startTerm, lastTerm, termsRead, skippedTerms, hitEnd, chained,
    nextTerm: hitEnd ? null : nextTerm,
    // Pacing, so a slowdown at the source shows up instead of silently halving
    // how many terms a run covers.
    requests, msPerRequest: requests ? Math.round(elapsedMs / requests) : null,
    elapsedMs,
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Every oda row currently in ml_offers — what the last link of a sweep charts
// the day from, so a group split across links is judged on the whole of itself.
// Returns null if the read fails, and the caller falls back to its own rows:
// an approximate history point beats none.
async function readAllOdaRows(SB_URL: string, sbHeaders: Record<string, string>): Promise<any[] | null> {
  const PAGE = 1000;
  const out: any[] = [];
  const cols = "group_key,store_id,product_name,image_url,price,pre_price,unit_price,unit_price_unit";
  for (let offset = 0; ; offset += PAGE) {
    try {
      const r = await fetch(
        `${SB_URL}/rest/v1/ml_offers?source=eq.oda&select=${cols}&order=external_id&limit=${PAGE}&offset=${offset}`,
        { headers: sbHeaders },
      );
      if (!r.ok) { console.error("history re-read failed", r.status, await r.text()); return null; }
      const rows = await r.json();
      if (!Array.isArray(rows)) return null;
      out.push(...rows);
      if (rows.length < PAGE) return out;
    } catch (e) { console.error("history re-read failed", String(e)); return null; }
  }
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
