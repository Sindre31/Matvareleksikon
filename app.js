/*
 * Prisboka — Matvareleksikon
 * ------------------------------------------------------------------
 * Real prices from the chains' tilbudsaviser (via Supabase / ml_offers).
 *  - The leksikon lists real products; store-specific products are grouped
 *    by a `group_key` so similar items compare across stores.
 *  - Two-level navigation: click a product to see where it's sold (variants
 *    across stores); click a specific store's product to see its price history.
 *  - Offers are marked in the leksikon (no separate offers page).
 *  - Receipt scanning (Gemini vision Edge Function) contributes prices.
 * Deep-linkable: #/ , #/gruppe/:key , #/vare/:key/:store , #/skann
 */
(function () {
  "use strict";

  var SUPABASE_URL = 'https://jiaxeedguivvhixychcg.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_trP_tgjyaPU-2eJ7n9JX4w_Q7kIvDPC';
  // Forwarding-only address (see readme.md): mail sent here lands in a personal
  // inbox. Replying *as* this address would need an SMTP relay, which the free
  // forwarding tier does not include — so don't promise a reply from it.
  // It is also duplicated in index.html's JSON-LD; change both together.
  var SUPPORT_EMAIL = 'support@prisboka.no';
  function sb(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }, opts.headers || {});
    return fetch(SUPABASE_URL + '/rest/v1' + path, opts);
  }

  // ── Data (populated at boot) ─────────────────────────────────────────────
  var STORES = [];                 // [{id,name,color,dash,places[]}] — shown in the leksikon
  var ALL_STORES = [];             // every chain in ml_stores, incl. the ones below MIN_STORE_PRICES
  var STORE_NAME = {}, STORE_STYLE = {};
  var OFFERS = [];
  var GROUPS = [], GROUP_BY_KEY = {};
  var VALID_COUNT = 0;

  // A chain only belongs in a price comparison when it carries enough of the
  // catalogue to actually be compared. A store on a fraction of the products
  // is worse than no store: its filter chip empties the grid, and "hva koster
  // lista i hver butikk" quotes a total based on a couple of items.
  //
  // At 1500 the leksikon is the three chains with real shelf-price coverage —
  // Meny (40 551), Kiwi (5 785) and Rema 1000 (1 869). Below the bar: Oda
  // (1 237, its own search API) and Coop Extra (120). Extra has no route past
  // it today — Coop publishes no shelf prices anywhere (no dagligvare-
  // nettbutikk; coop.no serves CMS content and the kundeavis as images; and
  // Kassalapp, the source of the Rema/Kiwi/Meny shelf prices, carries Coop
  // only as store locations), so its one machine-readable source is the weekly
  // kundeavis on Tjek — ~120 offers, all of which we already ingest.
  //
  // Nothing is hardcoded to a chain and the ingest keeps collecting, so a
  // store reappears on its own the week it clears the bar.
  var MIN_STORE_PRICES = 1500;

  function cleanName(raw) {
    var s = (raw || '').replace(/\b\d+([.,]\d+)?\s*(kg|hg|g|ml|cl|dl|l|stk|pk|pakk|pack)\b/gi, ' ')
      .replace(/\d+([.,]\d+)?\s*%/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) s = raw || '';
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }
  function pctOff(v) { return v.prePrice ? Math.round((1 - v.price / v.prePrice) * 100) : 0; }

  // Parse a comparable amount out of a product name so prices can be compared
  // per litre / kilogram / piece — otherwise "billigst" wrongly favours small
  // packs (a 0,5 l carton looks cheaper than a 1 l one). Returns { value, dim }
  // in base units (l, kg, stk) or null when no size is stated.
  function baseAmount(n, u) {
    n = parseFloat(n);
    if (!isFinite(n) || n <= 0) return null;
    var f = { l: 1, dl: 0.1, cl: 0.01, ml: 0.001, kg: 1, hg: 0.1, g: 0.001 }[u];
    if (f == null) return null;
    return { value: n * f, dim: (u === 'kg' || u === 'hg' || u === 'g') ? 'kg' : 'l' };
  }
  function parseAmount(name) {
    var s = ' ' + String(name || '').toLowerCase().replace(/,/g, '.') + ' ';
    // multipack: "4 x 1.5l", "6x33cl"
    var mp = s.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|hg|g|dl|cl|ml|l)(?![a-zæøå])/);
    if (mp) { var b = baseAmount(mp[2], mp[3]); if (b) return { value: b.value * parseFloat(mp[1]), dim: b.dim }; }
    // fraction size: "1/4 l" = 0.25 l, "1/2l", "3/4 kg" — must run before the
    // single-token match, which would otherwise read the "4l" in "1/4l" as 4 l.
    var fr = s.match(/(\d+)\s*\/\s*(\d+)\s*(kg|hg|g|dl|cl|ml|l)(?![a-zæøå])/);
    if (fr) { var fd = parseFloat(fr[2]); if (fd > 0) { var bf = baseAmount(parseFloat(fr[1]) / fd, fr[3]); if (bf) return bf; } }
    // largest single weight/volume token
    var re = /(\d+(?:\.\d+)?)\s*(kg|hg|g|dl|cl|ml|l)(?![a-zæøå])/g, m, best = null;
    while ((m = re.exec(s))) { var b2 = baseAmount(m[1], m[2]); if (b2 && (!best || b2.value > best.value)) best = b2; }
    if (best) return best;
    // count: "6 stk", "10-pk", "4 pakk"
    var pk = s.match(/(\d+)\s*[-\s]?\s*(?:stk|pk|pakk|stykk)(?![a-zæøå])/);
    if (pk) { var c = parseFloat(pk[1]); if (c > 0) return { value: c, dim: 'stk' }; }
    return null;
  }
  function nfUnit(perUnit, dim) { return nf(perUnit) + '/' + dim; }
  // Normalise a source unit label to our comparison dimensions.
  function normUnit(u) {
    u = String(u || '').toLowerCase().trim();
    if (u === 'l' || u === 'liter' || u === 'ltr') return 'l';
    if (u === 'kg' || u === 'kilo' || u === 'kilogram') return 'kg';
    if (u === 'stk' || u === 'stykk' || u === 'pk' || u === 'pakke') return 'stk';
    return null;
  }

  // Cross-store grouping key computed client-side from the product name, so
  // stores that word the same item differently still group together. Folds
  // Norwegian letters, strips sizes/units/%/house-brands and filler, then sorts
  // the remaining words so word order doesn't matter ("knuste tomater" ==
  // "tomater knuste"). Each offer keeps its own server group_key for history.
  var GK_STOP = {
    rema: 1, kiwi: 1, coop: 1, extra: 1, meny: 1, spar: 1, first: 1, price: 1, xtra: 1,
    eldorado: 1, prima: 1, folkets: 1, anglamark: 1, q: 1, tine: 1, gilde: 1, synnove: 1,
    nordfjord: 1, prior: 1, stange: 1, jacobs: 1, den: 1, stolte: 1, hane: 1, mills: 1,
    og: 1, med: 1, i: 1, av: 1, til: 1, pk: 1, stk: 1, pack: 1, ca: 1,
    // budget / house lines that shouldn't drive grouping
    var: 1, laveste: 1, pris: 1, glide: 1
  };
  function foldName(name) {
    return String(name || '').toLowerCase()
      .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a')
      .replace(/\d+([.,]\d+)?\s*(kg|hg|g|ml|cl|dl|l|stk|pk|pakk|pack|kop)\b/g, ' ')
      .replace(/\d+([.,]\d+)?\s*%/g, ' ')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  // ⚠ MIRROR OF A DATABASE FUNCTION — public.ml_group_key(text) in Postgres.
  //
  // group_key is what the price-history and photo lookups are keyed on, and it
  // used to be shipped on every catalogue row. It is a pure IMMUTABLE transform
  // of product_name, so sending it as well was 372 kB of the 1208 kB boot
  // payload (31 %) spent on something the client can derive. It is derived here
  // instead and no longer selected.
  //
  // The cost of that is this invariant: **if ml_group_key changes in SQL, this
  // must change with it.** Nothing fails loudly when they drift — the lookups
  // just quietly return nothing, and charts and photos go missing. The SQL
  // carries the same warning, and test/group-key.test.js pins this against 164
  // (name → key) pairs taken verbatim from production.
  //
  // Postgres → JS: \y (word boundary) is \b; the fallback branch deliberately
  // starts from lower(p) WITHOUT the ø/æ/å folding, so those letters fall
  // through its [^a-z0-9]+ class as separators.
  var ML_GROUP_BRANDS = /\b(rema|kiwi|coop|extra|meny|spar|first ?price|x-?tra|xtra|eldorado|prima|folkets|anglamark|q|tine|gilde|synnove|nordfjord|prior|stange|jacobs)\b/g;
  function mlGroupKey(name) {
    var src = String(name == null ? '' : name);
    var s = src.toLowerCase()
      .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a')
      .replace(/\d+([.,]\d+)?\s*(kg|hg|g|ml|cl|dl|l|stk|pk|pakk|pack|kop)\b/g, ' ')
      .replace(/\d+([.,]\d+)?\s*%/g, ' ')
      .replace(ML_GROUP_BRANDS, ' ')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (s !== '') return s;
    // Everything was stripped (a name that is nothing but sizes and brands):
    // fall back to a plain fold of the original, as the SQL does.
    return src.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // Category grouping: some products must group by a *variety* (raw mince by
  // meat type), not by brand. Others (branded sauces) keep their brand. The
  // mince rule below keys "kjøttdeig"/"karbonadedeig" by meat type — svin,
  // storfe (the default), kylling, kalkun, lam, laks, or blandet for a mix —
  // so pork, beef and karbonade land in distinct groups while brand, fat %,
  // salt/water wording and pack size are ignored.
  var MEAT_TYPES = ['storfe', 'svin', 'kylling', 'kalkun', 'lam', 'laks', 'elg', 'vilt', 'hjort', 'rein', 'kalv'];
  var TYPE_ALIASES = { storfe: ['storfe'], svin: ['svin', 'gris'], kylling: ['kylling'], kalkun: ['kalkun'], lam: ['lam'], laks: ['laks'], elg: ['elg'], vilt: ['vilt'], hjort: ['hjort'], rein: ['rein'], kalv: ['kalv'] };
  // A "kjøttdeig"/"karbonadedeig" name that also carries one of these is really
  // a pizza, sauce, ready meal or veg imitation — keep it out of the mince
  // groups (substring on the folded name; no 'ris' — it hides inside "pris").
  var MINCE_DISQUALIFY = /a la|pizza|grandiosa|bowl|gronnsak|saus|wok|gryte|lasagne|taco|suppe|potetmos|vegetar|veggie|plante|soya|surdeig|medister/;
  var TYPE_LABEL = { storfe: 'av storfe', svin: 'av svin', kylling: 'kylling', kalkun: 'kalkun', lam: 'av lam', laks: 'av laks', elg: 'elg', vilt: 'vilt', hjort: 'hjort', rein: 'rein', kalv: 'kalv', blandet: 'blandet' };

  function typePresent(folded, t) {
    var al = TYPE_ALIASES[t] || [t];
    for (var i = 0; i < al.length; i++) if (folded.indexOf(al[i]) > -1) return true;
    return false;
  }
  function minceKey(folded) {
    if (MINCE_DISQUALIFY.test(folded)) return null;
    var toks = folded.split(' '), base = null;
    for (var i = 0; i < toks.length; i++) if (/karbonadedeig$/.test(toks[i])) { base = 'karbonadedeig'; break; }
    if (!base) for (var j = 0; j < toks.length; j++) if (/kjottdeig$/.test(toks[j])) { base = 'kjottdeig'; break; }
    if (!base) return null;
    var present = [];
    MEAT_TYPES.forEach(function (t) { if (typePresent(folded, t) && present.indexOf(t) < 0) present.push(t); });
    var type = present.length >= 2 ? 'blandet' : (present.length === 1 ? present[0] : 'storfe');
    if (base === 'karbonadedeig') return type === 'storfe' ? 'karbonadedeig' : ('karbonadedeig ' + type);
    return 'kjottdeig ' + type;
  }
  function ckey(name) {
    var folded = foldName(name);
    var mk = minceKey(folded);
    if (mk) return mk;
    folded = folded.replace(/\btaco saus\b/g, 'tacosaus'); // "taco saus" == "tacosaus"
    var words = folded.split(' ').filter(function (w) { return w.length > 1 && !GK_STOP[w]; });
    if (!words.length) words = folded.split(' ').filter(Boolean);
    words.sort();
    return words.join(' ') || (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  // A friendly title for the canonical mince keys (else null → use the product
  // name of the group's first variant, as before).
  function canonLabel(key) {
    var m = key.match(/^kjottdeig (\w+)$/);
    if (m) return 'Kjøttdeig ' + (TYPE_LABEL[m[1]] || m[1]);
    if (key === 'karbonadedeig') return 'Karbonadedeig';
    var c = key.match(/^karbonadedeig (\w+)$/);
    if (c) return 'Karbonadedeig ' + (TYPE_LABEL[c[1]] || c[1]);
    return null;
  }

  // Which offers a tilbudsavis puts up front: the categories a household buys
  // every week, not whatever happens to carry the steepest markdown. Weight 2 is
  // the front page (ost, kjøttdeig, kaffe …), weight 1 the rest of the everyday
  // basket, and anything unmatched is weight 0 — still shown, just after these.
  // The patterns are matched against a *group key*: lowercased, ø/æ/å folded to
  // o/ae/a, sizes and brands stripped, words sorted. So they must be spelled
  // folded ("polse", "brod", "flote") and anchored on word boundaries, or "ost"
  // starts matching "kompost" and "ris" matches "pris".
  var POPULAR = [
    { w: 2, family: 'ost', re: /\b(ost|brunost|gulost|hvitost|norvegia|jarlsberg|cheddar|mozzarella)\b/ },
    { w: 2, family: 'kjott', re: /\b(kjottdeig|karbonadedeig|ribbe|koteletter|entrecote|indrefilet|ytrefilet|biff|svinestek)\b/ },
    { w: 2, family: 'kylling', re: /\b(kylling|kyllingfilet|kyllinglar|kyllingvinger)\b/ },
    { w: 2, family: 'kaffe', re: /\b(kaffe|kaffekapsler|espresso)\b/ },
    { w: 2, family: 'fisk', re: /\b(laks|torsk|reker|sei|orret|fiskekaker)\b/ },
    { w: 2, family: 'pizza', re: /\b(pizza|grandiosa)\b/ },
    { w: 2, family: 'drikke', re: /\b(brus|cola|pepsi|solo|farris|urge|battery|monster|energidrikk)\b/ },
    { w: 1, family: 'meieri', re: /\b(melk|flote|romme|fraiche|smor|margarin|yoghurt|skyr|egg)\b/ },
    { w: 1, family: 'palegg', re: /\b(bacon|polse|polser|skinke|servelat|leverpostei|makrell|kaviar)\b/ },
    { w: 1, family: 'bakeri', re: /\b(brod|rundstykker|lomper|lefse|knekkebrod|boller)\b/ },
    { w: 1, family: 'snacks', re: /\b(sjokolade|chips|iskrem|smagodt|godteri|kjeks|potetgull|snacks)\b/ },
    { w: 1, family: 'middag', re: /\b(taco|lasagne|fiskepinner|kjottkaker|pasta|spaghetti|ris|wok|gryte)\b/ },
    { w: 1, family: 'frukt', re: /\b(bananer|epler|jordbaer|tomater|agurk|poteter|clementiner|druer|appelsiner|salat|gulrot|gulrotter)\b/ }
  ];
  function popularityOf(key) {
    for (var i = 0; i < POPULAR.length; i++) if (POPULAR[i].re.test(key)) return POPULAR[i];
    return null;
  }

  // The cards for "Ukas tilbud". The front page of a tilbudsavis is not a list
  // of the steepest markdowns — it is the staples a household buys every week
  // (ost, kjøttdeig, kaffe …) at a good price, so that is what leads here too:
  // popular categories first, deepest cut inside a category, one card per
  // product (not the same cheese from three chains) and at most `perFamily`
  // from any one category, so the row reads like a week's offers rather than
  // eight cheeses. Offers outside the categories fill whatever slots are left.
  function pickWeeklyOffers(groups, limit, perFamily) {
    limit = limit || 8;
    perFamily = perFamily || 2;
    var cands = [];
    (groups || []).forEach(function (g) {
      var best = null;
      (g.variants || []).forEach(function (v) { if (v.isOffer && (!best || pctOff(v) > pctOff(best))) best = v; });
      if (!best) return;
      var pop = popularityOf(g.key);
      cands.push({ g: g, v: best, pop: pop ? pop.w : 0, family: pop ? pop.family : null });
    });
    cands.sort(function (a, b) { return (b.pop - a.pop) || (pctOff(b.v) - pctOff(a.v)); });
    var out = [], taken = {};
    for (var i = 0; i < cands.length && out.length < limit; i++) {
      var c = cands[i];
      if (c.family) {
        var n = taken[c.family] || 0;
        if (n >= perFamily) continue;
        taken[c.family] = n + 1;
      }
      out.push(c);
    }
    return out;
  }

  // Make a non-native clickable element keyboard-operable (Enter/Space) and
  // announced as a button. Merge the returned props into the element.
  function activate(handler, label) {
    return {
      role: 'button', tabindex: '0', 'aria-label': label || false, onClick: handler,
      onKeydown: function (e) { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); handler(e); } }
    };
  }

  // How many usable prices each store contributes right now (expired offers and
  // junk rows don't count — they aren't in the leksikon either), and which
  // stores clear MIN_STORE_PRICES. Returns a { storeId: count } map of the
  // stores worth showing.
  function coveredStores(offers, min) {
    var today = new Date().toISOString().slice(0, 10);
    var limit = min == null ? MIN_STORE_PRICES : min;
    var n = {};
    (Array.isArray(offers) ? offers : []).forEach(function (o) {
      if (!o || o.store_id == null) return;
      if (o.valid_until && o.valid_until < today) return;
      var p = Number(o.price);
      if (!isFinite(p) || p <= 0) return;
      n[o.store_id] = (n[o.store_id] || 0) + 1;
    });
    var out = {};
    Object.keys(n).forEach(function (k) { if (n[k] >= limit) out[k] = n[k]; });
    return out;
  }

  // `covered` (optional) narrows the leksikon to the stores with real coverage.
  // ALL_STORES keeps every chain regardless, so the scan flow can still file a
  // receipt under a hidden chain rather than mis-attributing it to a shown one.
  function buildStores(rows, covered) {
    ALL_STORES = (Array.isArray(rows) ? rows : [])
      .filter(function (s) { return s && s.id != null; })
      .map(function (s) { return { id: s.id, name: s.name || String(s.id), color: s.color, dash: s.dash || '', places: s.places || [] }; });
    STORES = covered ? ALL_STORES.filter(function (s) { return covered[s.id]; }) : ALL_STORES.slice();
    STORE_NAME = {}; STORE_STYLE = {};
    STORES.forEach(function (s) { STORE_NAME[s.id] = s.name; STORE_STYLE[s.id] = { color: s.color, dash: s.dash }; });
  }

  // Build one variant object from an offer row, incl. its price-per-unit
  // (parsed from the name, or the source's own unit price as a fallback).
  function buildVariant(o) {
    var st = o.store_id, price = Number(o.price);
    var amt = parseAmount(o.product_name);
    var perUnit = amt ? price / amt.value : null, unitDim = amt ? amt.dim : null;
    if (perUnit == null && o.unit_price != null) { var nd = normUnit(o.unit_price_unit || o.unit); var up = Number(o.unit_price); if (nd && up > 0) { perUnit = up; unitDim = nd; } }
    return {
      storeId: st, storeName: STORE_NAME[st] || st,
      color: (STORE_STYLE[st] || {}).color || 'var(--color-accent)', dash: (STORE_STYLE[st] || {}).dash || '',
      rawName: o.product_name, name: cleanName(o.product_name),
      // Derived, not shipped — see mlGroupKey. The `o.group_key ||` arm is not
      // dead: rows restored from a snapshot written before the column was
      // dropped still carry one, and using it keeps those visits identical
      // rather than forcing the 12 h cache to be invalidated.
      serverKey: o.group_key || mlGroupKey(o.product_name) || ckey(o.product_name),
      price: price, prePrice: o.pre_price != null ? Number(o.pre_price) : null,
      // The photo itself is not in the boot payload — see the image loader.
      // hasImage says one exists, which is what reserves its frame.
      unit: o.unit || null, hasImage: !!o.has_image, validUntil: o.valid_until || null,
      offerDays: o.offer_days || null,
      isOffer: o.pre_price != null && Number(o.pre_price) > price,
      unitDim: unitDim, perUnit: perUnit,
      // The pack size itself (1.75 l, 0.4 kg, 12 stk), when the name stated one.
      // Null when the unit price came from the source rather than the name.
      amount: amt ? amt.value : null
    };
  }

  // ── Pack sizes ───────────────────────────────────────────────────────────
  // A size id groups variants that hold the same amount across stores, so a
  // shopper can compare (and shop) like for like. 'ukjent' covers the packs
  // whose name states no amount; 'alle' means "any size" on a list entry.
  function sizeIdOf(v) {
    if (!v || v.amount == null || !v.unitDim) return 'ukjent';
    return (Math.round(v.amount * 1000) / 1000) + v.unitDim;
  }
  function sizeLabel(id) {
    if (!id || id === 'alle') return 'Alle størrelser';
    if (id === 'ukjent') return 'Uoppgitt størrelse';
    var m = String(id).match(/^([\d.]+)(kg|l|stk)$/);
    if (!m) return String(id);
    return String(m[1]).replace('.', ',') + (m[2] === 'stk' ? ' stk' : ' ' + m[2]);
  }
  // Every distinct size of a product across all stores, smallest first, with
  // the cheapest price and the number of stores carrying it.
  function sizeOptions(g) {
    var by = {};
    Object.keys((g && g.allByStore) || {}).forEach(function (st) {
      (g.allByStore[st] || []).forEach(function (v) {
        var id = sizeIdOf(v);
        var o = by[id] || (by[id] = { id: id, label: sizeLabel(id), amount: v.amount, dim: v.unitDim, minPrice: Infinity, stores: {} });
        o.stores[st] = 1;
        if (v.price < o.minPrice) o.minPrice = v.price;
      });
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) {
      if (a.id === 'ukjent') return 1;
      if (b.id === 'ukjent') return -1;
      return (a.amount || 0) - (b.amount || 0);
    }).map(function (o) { o.storeCount = Object.keys(o.stores).length; return o; });
  }
  // The best variant per store, optionally narrowed to one size: cheapest per
  // unit when a unit price is known, else the cheapest pack — the same rule
  // buildGroups uses for the group representative.
  function bestPerStore(g, sizeId) {
    var out = [];
    Object.keys((g && g.allByStore) || {}).forEach(function (st) {
      var arr = (g.allByStore[st] || []).filter(function (v) {
        return !sizeId || sizeId === 'alle' || sizeIdOf(v) === sizeId;
      });
      if (!arr.length) return;
      var withU = arr.filter(function (x) { return x.perUnit != null; });
      out.push(withU.length
        ? withU.reduce(function (a, b) { return b.perUnit < a.perUnit ? b : a; })
        : arr.reduce(function (a, b) { return b.price < a.price ? b : a; }));
    });
    return out.sort(function (a, b) {
      if (a.perUnit != null && b.perUnit != null) return a.perUnit - b.perUnit;
      if (a.perUnit != null) return -1;
      if (b.perUnit != null) return 1;
      return a.price - b.price;
    });
  }

  // All distinct sizes a store carries of a product, cheapest-per-unit first
  // (unit price when known, else pack price). De-duped across sources by name.
  function sizesFor(g, storeId) {
    var arr = (g.allByStore && g.allByStore[storeId]) || [];
    var byName = {};
    arr.forEach(function (v) {
      var sig = (v.rawName || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!byName[sig] || v.price < byName[sig].price) byName[sig] = v;
    });
    return Object.keys(byName).map(function (k) { return byName[k]; }).sort(function (a, b) {
      if (a.perUnit != null && b.perUnit != null) return a.perUnit - b.perUnit;
      if (a.perUnit != null) return -1;
      if (b.perUnit != null) return 1;
      return a.price - b.price;
    });
  }

  function buildGroups(offers) {
    OFFERS = Array.isArray(offers) ? offers : [];
    var today = new Date().toISOString().slice(0, 10);
    var valid = OFFERS.filter(function (o) { return o && (!o.valid_until || o.valid_until >= today); });
    if (!valid.length) valid = OFFERS.filter(Boolean);
    VALID_COUNT = valid.length;
    var map = {};
    valid.forEach(function (o) {
      // Skip a malformed row rather than let it throw and blank the catalogue.
      try {
        if (!o) return;
        var price = Number(o.price);
        if (!isFinite(price) || price <= 0) return;
        var key = ckey(o.product_name);
        if (!key) return;
        var g = map[key] || (map[key] = { key: key, byStore: {}, serverKeys: {} });
        var v = buildVariant(o);
        g.serverKeys[v.serverKey] = 1;
        (g.byStore[v.storeId] || (g.byStore[v.storeId] = [])).push(v);
      } catch (e) { /* one bad offer row shouldn't take down the whole build */ }
    });
    GROUPS = Object.keys(map).map(function (key) {
      try {
      var byStore = map[key].byStore;
      // Per store the representative is the cheapest PER UNIT (best value) when a
      // unit price is known — so a small carton can't beat a big one — otherwise
      // the cheapest pack price.
      var variants = Object.keys(byStore).map(function (st) {
        var arr = byStore[st];
        var withU = arr.filter(function (x) { return x.perUnit != null; });
        if (withU.length) return withU.reduce(function (a, b) { return b.perUnit < a.perUnit ? b : a; });
        return arr.reduce(function (a, b) { return b.price < a.price ? b : a; });
      });
      // Always order by price-per-unit when known (nulls last), so litre/kilo
      // price drives the ranking. The "billigst per X" headline is only claimed
      // when *every* store is unit-comparable, to avoid a misleading claim.
      variants.sort(function (a, b) {
        if (a.perUnit != null && b.perUnit != null) return a.perUnit - b.perUnit;
        if (a.perUnit != null) return -1;
        if (b.perUnit != null) return 1;
        return a.price - b.price;
      });
      var comparable = variants.length >= 2 && variants.every(function (v) { return v.perUnit != null && v.unitDim === variants[0].unitDim; });
      var anyImage = variants.some(function (v) { return v.hasImage; });
      // Cheapest unit price across the group (variants are sorted unit-price
      // first, so variants[0] carries it when any variant has one).
      var cheapUnit = (variants[0] && variants[0].perUnit != null) ? variants[0].perUnit : null;
      var cheapUnitDim = cheapUnit != null ? variants[0].unitDim : null;
      return {
        key: key, name: canonLabel(key) || (variants[0] ? variants[0].name : key), variants: variants, hasImage: anyImage,
        allByStore: byStore, serverKeys: Object.keys(map[key].serverKeys),
        minPrice: variants.reduce(function (m, v) { return Math.min(m, v.price); }, Infinity),
        storeCount: variants.length,
        unitPrice: cheapUnit, unitDim: cheapUnitDim,
        compDim: comparable ? variants[0].unitDim : null,
        minUnit: comparable ? variants[0].perUnit : null,
        onOffer: variants.some(function (v) { return v.isOffer; }),
        bestOff: variants.reduce(function (m, v) { return Math.max(m, pctOff(v)); }, 0),
        searchText: (variants.map(function (v) { return v.rawName; }).join(' ') + ' ' + key).toLowerCase()
      };
      } catch (e) { return null; } // drop a bad group rather than blank the catalogue
    }).filter(Boolean);
    GROUP_BY_KEY = {}; GROUPS.forEach(function (g) { GROUP_BY_KEY[g.key] = g; });
    return GROUPS;
  }

  // ── Handleliste (shopping list) — persisted in localStorage ──────────────
  // An entry is "<group key>@<size id>": the product (a stable client group
  // key, derived from the name, so a saved list survives re-ingested data) and
  // the pack size the shopper picked. Group keys are folded to [a-z0-9 ], so
  // '@' can never appear in one and splitting is unambiguous. A bare key from
  // an older saved list reads as '@alle' (any size).
  // The list is an *ordered* array — the shopper drags it into shopping order,
  // so order is data, not presentation.
  // How many of the item the shopper wants rides along as a '*N' suffix, left
  // off entirely at 1. Group keys are [a-z0-9 ] and sizes are digits + a unit,
  // so '*' can no more appear in one than '@' can — which means quantity
  // travels with the entry id through localStorage, the drag order and the
  // share link without any of them needing to know about it. An older saved
  // list, or a link shared before this existed, simply reads as 1.
  var LIST_KEY = 'prisboka_liste';
  var MAX_QTY = 99;
  function clampQty(n) {
    n = Math.round(Number(n));
    return isFinite(n) && n > 1 ? Math.min(n, MAX_QTY) : 1;
  }
  function entryId(key, size, qty) {
    var q = clampQty(qty);
    return key + '@' + (size || 'alle') + (q > 1 ? '*' + q : '');
  }
  function parseEntry(e) {
    var s = String(e || ''), qty = 1;
    var star = s.lastIndexOf('*');
    if (star > -1 && /^\d+$/.test(s.slice(star + 1))) { qty = clampQty(s.slice(star + 1)); s = s.slice(0, star); }
    var i = s.lastIndexOf('@');
    var key = i < 0 ? s : s.slice(0, i);
    var size = i < 0 ? 'alle' : (s.slice(i + 1) || 'alle');
    return { id: entryId(key, size, qty), key: key, size: size, qty: qty };
  }
  function loadList() {
    try {
      var a = JSON.parse(localStorage.getItem(LIST_KEY) || '[]');
      if (!Array.isArray(a)) return [];
      var seen = {}, out = [];
      a.forEach(function (k) {
        if (!k) return;
        var id = parseEntry(k).id;
        if (!seen[id]) { seen[id] = 1; out.push(id); }
      });
      return out;
    } catch (e) { return []; }
  }
  function saveList() { try { localStorage.setItem(LIST_KEY, JSON.stringify(state.list)); } catch (e) { /* private mode / quota */ } }
  // A product is "in the list" at any size — the star reflects the product, so
  // it can be un-starred without knowing which size was picked.
  function listIndex(k) {
    for (var i = 0; i < state.list.length; i++) if (parseEntry(state.list[i]).key === k) return i;
    return -1;
  }
  function inList(k) { return listIndex(k) > -1; }
  function listCount() { return state.list.length; }
  function addToList(key, size) {
    var id = entryId(key, size);
    if (state.list.indexOf(id) < 0) state.list.push(id);
    saveList();
  }
  function removeFromList(key) {
    var i = listIndex(key);
    if (i > -1) state.list.splice(i, 1);
    saveList();
  }
  // Move a list entry to a new position, e.g. after a drag. Out-of-range
  // indices are clamped, so a stray drop can't drop the entry.
  function moveEntry(list, from, to) {
    var arr = (Array.isArray(list) ? list : []).slice();
    if (from < 0 || from >= arr.length) return arr;
    to = Math.max(0, Math.min(arr.length - 1, to));
    arr.splice(to, 0, arr.splice(from, 1)[0]);
    return arr;
  }

  // ── Drag-to-reorder ──────────────────────────────────────────────────────
  // Pointer events rather than HTML5 drag-and-drop, so a finger works as well
  // as a mouse. The rows are re-ordered in the DOM live and the new order is
  // committed once, on drop. `dragging` freezes render() meanwhile: a catalogue
  // refresh landing mid-drag would otherwise rebuild the rows under the finger.
  var dragging = false;
  function startRowDrag(e, handleEl) {
    var row = handleEl.closest ? handleEl.closest('[data-lid]') : null;
    var box = row && row.parentNode;
    if (!row || !box) return;
    e.preventDefault();
    dragging = true;
    var prevStyle = row.getAttribute('style') || '';
    row.setAttribute('style', prevStyle + ' opacity: 0.6; background: color-mix(in srgb, var(--color-accent) 10%, transparent);');
    // The listeners go on the document, not the handle: re-inserting the row
    // moves the handle with it, which releases any pointer capture we'd taken
    // and would strand the drag with no pointerup to commit it.
    var id = e.pointerId;
    var rowsOf = function () {
      return [].slice.call(box.children).filter(function (c) { return c !== row && c.getAttribute && c.getAttribute('data-lid'); });
    };
    var move = function (ev) {
      if (ev.pointerId !== id) return;
      ev.preventDefault();
      var y = ev.clientY, sibs = rowsOf();
      for (var i = 0; i < sibs.length; i++) {
        var r = sibs[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) { if (sibs[i].previousSibling !== row) box.insertBefore(row, sibs[i]); return; }
      }
      if (sibs.length && box.lastChild !== row) box.appendChild(row);
    };
    var end = function (ev) {
      if (ev && ev.pointerId != null && ev.pointerId !== id) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end);
      row.setAttribute('style', prevStyle);
      dragging = false;
      var order = [].slice.call(box.children)
        .map(function (c) { return c.getAttribute && c.getAttribute('data-lid'); })
        .filter(Boolean);
      // Only trust a complete order — with a filter on, some entries aren't on
      // screen, so splice the visible ones back into their slots instead.
      if (order.length === state.list.length) state.list = order;
      else {
        var slots = [];
        state.list.forEach(function (id, i) { if (order.indexOf(id) > -1) slots.push(i); });
        var next = state.list.slice();
        slots.forEach(function (slot, i) { next[slot] = order[i]; });
        state.list = next;
      }
      saveList();
      render();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
  }
  // The grip: drag with a pointer, or move with the arrow keys when focused.
  function dragHandle(it, idx, total) {
    var byKeyboard = function (dir) {
      var from = state.list.indexOf(it.id);
      state.list = moveEntry(state.list, from, from + dir);
      saveList();
      render();
      var el = document.querySelector('[data-lid="' + it.id + '"] [data-drag]');
      if (el) el.focus();
    };
    // `activate` first, so the arrow-key handler below replaces its Enter/Space
    // one — the grip drags and moves, it never "clicks".
    return h('span', Object.assign(activate(function () {}, 'Flytt ' + it.name + ', nr. ' + (idx + 1) + ' av ' + total + ' — bruk piltastene'), {
      'data-drag': '1', 'data-focus-id': 'drag-' + it.id,
      title: 'Dra for å flytte',
      style: 'width: 26px; height: 34px; display: flex; align-items: center; justify-content: center; cursor: grab; touch-action: none; color: ' + MUTED60 + '; font-size: 15px; user-select: none;',
      onPointerdown: function (e) { startRowDrag(e, e.currentTarget); },
      onKeydown: function (e) {
        if (e.key === 'ArrowUp' && idx > 0) { e.preventDefault(); byKeyboard(-1); }
        else if (e.key === 'ArrowDown' && idx < total - 1) { e.preventDefault(); byKeyboard(1); }
      }
    }), '⠿');
  }

  // A shareable list URL encodes the entries after the hash (entries are
  // [a-z0-9 @.] only, so '~' is a safe separator) — no account, no server.
  function listShareUrl() {
    return location.href.replace(/#.*$/, '') + '#/liste?d=' + encodeURIComponent(state.list.join('~'));
  }

  // ── State ────────────────────────────────────────────────────────────────
  var state = {
    phase: 'loading', errMsg: '',
    view: 'home', groupKey: null, storeId: null, query: '', storeFilter: 'Alle', sort: 'relevans', priceMode: 'kilo',
    scanPhase: 'idle', scanStep: '', scanItems: [], scanStore: 'Kiwi', scanDate: '',
    scanSubmitting: false, scanError: null, scanImageUrl: null, scanNote: null,
    doneCount: 0, doneMsgN: 0,
    list: [], copiedFor: null, lastUpdated: '', fromCache: false, sharedList: null, listShareCopied: false,
    listPriceMode: 'kilo', listOnlyUnit: false, listOpenStore: null, sizePicker: null,
    groupStore: 'Alle', groupSize: 'alle', groupSort: 'billigst', histMode: 'enhet',
    history: {},    // key -> 'loading' | [rows] — full rows, per product page
    listHistory: {} // key -> 'loading' | [rows] — trimmed rows for the list chart
  };
  state.list = loadList();
  function setState(patch) { Object.assign(state, patch); render(); }

  function nf(v) { return 'kr ' + Number(v).toFixed(2).replace('.', ','); }

  // ── Receipt OCR (Gemini vision Edge Function) — unchanged pipeline ────────
  var SCAN_FN_URL = SUPABASE_URL + '/functions/v1/ml-receipt-scan';

  function imageToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var target = 1600, w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, target / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        var c = document.createElement('canvas'); c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        try { resolve(c.toDataURL('image/jpeg', 0.85)); } catch (e) { reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Kunne ikke lese bildefila.')); };
      img.src = url;
    });
  }
  function onScanFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      // Every price in the leksikon has to come off a receipt the scanner
      // actually read, so a file we can't read leaves nothing to review —
      // there is no hand-typed fallback to fall back to.
      setState({ scanPhase: 'idle', scanItems: [], scanNote: null, scanError: 'Filen ser ikke ut som et bilde. Velg et foto av kvitteringen.' });
      return;
    }
    if (state.scanImageUrl) URL.revokeObjectURL(state.scanImageUrl);
    var previewUrl = URL.createObjectURL(file);
    setState({ scanPhase: 'scanning', scanStep: 'Leser kvitteringen med AI …', scanError: null, scanNote: null, scanImageUrl: previewUrl });
    runScan(file);
  }
  function runScan(file) {
    imageToDataUrl(file)
      .then(function (dataUrl) {
        return fetch(SCAN_FN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
          body: JSON.stringify({ image: dataUrl, mimeType: 'image/jpeg' })
        });
      })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }, function () { return { ok: res.ok, body: {} }; }); })
      .then(function (r) {
        if (!r.ok) {
          setState({ scanPhase: 'idle', scanItems: [], scanNote: null, scanError: (r.body && r.body.error) || 'Kunne ikke lese kvitteringen. Prøv igjen med et tydeligere bilde.' });
          return;
        }
        var data = r.body || {};
        var items = (data.items || []).map(function (it) {
          return { name: it.name || '', price: (it.price != null ? String(it.price) : ''), unit: it.unit || null, quantity: (it.quantity != null ? it.quantity : null), lineTotal: (it.lineTotal != null ? it.lineTotal : null) };
        });
        if (!items.length) {
          setState({ scanPhase: 'idle', scanItems: [], scanNote: null, scanError: 'Fant ingen varelinjer på bildet. Prøv et tydeligere bilde av hele kvitteringen.' });
          return;
        }
        var patch = { scanPhase: 'review', scanError: null, scanItems: items };
        patch.scanDate = (data.purchaseDate && /^\d{4}-\d{2}-\d{2}$/.test(data.purchaseDate)) ? data.purchaseDate : new Date().toISOString().slice(0, 10);
        if (data.store) patch.scanStore = data.store;
        patch.scanNote = 'Fant ' + items.length + ' varelinjer' + (data.storeName ? ' fra ' + data.storeName : '') + '. Se over dem før du lagrer.';
        setState(patch);
      })
      .catch(function () {
        setState({ scanPhase: 'idle', scanItems: [], scanNote: null, scanError: 'Kunne ikke lese bildet nå. Sjekk nettforbindelsen og prøv igjen.' });
      });
  }
  function resetScan() {
    if (state.scanImageUrl) URL.revokeObjectURL(state.scanImageUrl);
    setState({ scanPhase: 'idle', scanItems: [], scanImageUrl: null, scanNote: null, scanError: null });
  }
  function submitScan() {
    if (state.scanSubmitting || !state.scanItems.length) return;
    // ALL_STORES, not STORES: a receipt from a chain the leksikon currently
    // hides is still recorded under that chain (and counts towards its
    // coverage) instead of being filed under whichever store the picker
    // happened to default to.
    var storeObj = ALL_STORES.filter(function (x) { return x.name === state.scanStore; })[0];
    var obs = /^\d{4}-\d{2}-\d{2}$/.test(state.scanDate || '') ? state.scanDate : new Date().toISOString().slice(0, 10);
    var payload = state.scanItems.map(function (it) {
      var raw = String(it.price == null ? '' : it.price).replace(',', '.').trim();
      var price = raw === '' ? null : Number(raw);
      return { item_name: it.name, price: (price == null || isNaN(price)) ? null : price, store_id: storeObj ? storeObj.id : null, place: null, product_id: null, observed_at: obs, unit: it.unit || null, quantity: (it.quantity != null ? it.quantity : null), line_total: (it.lineTotal != null ? it.lineTotal : null) };
    });
    var n = state.scanItems.length;
    setState({ scanSubmitting: true, scanError: null });
    sb('/ml_registrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); })
      .then(function () { setState({ scanPhase: 'done', doneCount: state.doneCount + n, doneMsgN: n, scanSubmitting: false }); })
      .catch(function () { setState({ scanSubmitting: false, scanError: 'Kunne ikke lagre prisene nå. Sjekk nettforbindelsen og prøv igjen.' }); });
  }

  // ── Tiny hyperscript ─────────────────────────────────────────────────────
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SVG_TAGS = { svg: 1, line: 1, text: 1, polyline: 1, circle: 1, g: 1, rect: 1, path: 1 };
  function h(tag, props, children) {
    var el = SVG_TAGS[tag] ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      var val = props[k];
      if (val == null || val === false) return;
      if (k === 'cls') { el.setAttribute('class', val); }
      else if (k === 'style') { el.setAttribute('style', val); }
      else if (k === 'text') { el.textContent = val; }
      else if (/^on[A-Z]/.test(k) && typeof val === 'function') { el.addEventListener(k.slice(2).toLowerCase(), val); }
      else if (k === 'value') { el.value = val; if (el.setAttribute) el.setAttribute('value', val); }
      else { el.setAttribute(k, val); }
    });
    appendChildren(el, children);
    return el;
  }
  function appendChildren(el, children) {
    if (children == null) return;
    if (!Array.isArray(children)) children = [children];
    children.forEach(function (c) {
      if (c == null || c === false) return;
      if (typeof c === 'string' || typeof c === 'number') el.appendChild(document.createTextNode(String(c)));
      else el.appendChild(c);
    });
  }
  function corners() { return [h('i', { cls: 'corner tl' }), h('i', { cls: 'corner tr' }), h('i', { cls: 'corner bl' }), h('i', { cls: 'corner br' })]; }
  function storeLine(color, dash, w) {
    return h('svg', { width: w, height: '6', 'aria-hidden': 'true' },
      h('line', { x1: '0', y1: '3', x2: String(w), y2: '3', stroke: color, 'stroke-width': '2.5', 'stroke-dasharray': dash }));
  }
  // `reserve` keeps the frame for a product whose photo is known to exist but
  // hasn't arrived yet, so the card doesn't grow under the shopper when it does.
  // Products with no photo at all still get no frame, exactly as before.
  function imgBox(src, alt, height, reserve) {
    if (!src && !reserve) return null;
    return h('div', { style: 'height: ' + height + '; background: #fff; display: flex; align-items: center; justify-content: center; overflow: hidden; border-bottom: 1px solid var(--color-divider);' },
      src ? [h('img', { src: src, alt: alt, loading: 'lazy', style: 'max-width: 90%; max-height: 100%; object-fit: contain; mix-blend-mode: multiply;' })] : []);
  }
  // The 190 px square on the group and variant headers, same deal.
  function heroImgBox(src, alt, reserve) {
    if (!src && !reserve) return null;
    return h('div', { cls: 'blueprint', style: 'flex: none; width: 190px; height: 190px; background: #fff; display: flex; align-items: center; justify-content: center; overflow: hidden;' },
      corners().concat(src ? [h('img', { src: src, alt: alt, style: 'max-width: 82%; max-height: 82%; object-fit: contain; mix-blend-mode: multiply;' })] : []));
  }

  // ── Routing ──────────────────────────────────────────────────────────────
  function parseHash() {
    var hn = (location.hash || '').replace(/^#/, '');
    if (hn.indexOf('/gruppe/') === 0) return { view: 'gruppe', groupKey: decodeURIComponent(hn.slice('/gruppe/'.length)) };
    if (hn.indexOf('/vare/') === 0) {
      var rest = hn.slice('/vare/'.length), i = rest.lastIndexOf('/');
      if (i > 0) return { view: 'vare', groupKey: decodeURIComponent(rest.slice(0, i)), storeId: decodeURIComponent(rest.slice(i + 1)) };
    }
    if (hn === '/skann') return { view: 'scan' };
    if (hn === '/om') return { view: 'om' };
    if (hn.indexOf('/liste') === 0) {
      var shared = null, qi = hn.indexOf('?');
      if (qi > -1) {
        var mm = hn.slice(qi + 1).match(/(?:^|&)d=([^&]*)/);
        if (mm) { try { shared = decodeURIComponent(mm[1]).split('~').map(function (s) { return s.trim(); }).filter(Boolean); } catch (e) { shared = null; } }
      }
      return { view: 'liste', shared: shared };
    }
    return { view: 'home' };
  }
  function route() {
    if (state.phase !== 'ready') { render(); return; }
    var r = parseHash();
    if (r.view === 'gruppe') {
      if (!GROUP_BY_KEY[r.groupKey]) { location.hash = '#/'; return; }
      // The history lives on this page now, so fetch it here too. Opening a
      // different product resets the page's filters — they belong to the view,
      // not to the shopper.
      if (state.groupKey !== r.groupKey) { state.groupStore = 'Alle'; state.groupSize = 'alle'; }
      state.view = 'gruppe'; state.groupKey = r.groupKey;
      loadHistory(GROUP_BY_KEY[r.groupKey]);
    } else if (r.view === 'vare') {
      if (!GROUP_BY_KEY[r.groupKey]) { location.hash = '#/'; return; }
      state.view = 'vare'; state.groupKey = r.groupKey; state.storeId = r.storeId;
      loadHistory(GROUP_BY_KEY[r.groupKey]);
    } else if (r.view === 'scan') {
      state.view = 'scan';
    } else if (r.view === 'liste') {
      state.view = 'liste';
      state.sharedList = (r.shared && r.shared.length) ? r.shared : null;
      loadListHistory();
    } else if (r.view === 'om') {
      state.view = 'om';
    } else {
      state.view = 'home';
    }
    render();
  }
  // "Rema 1000, Kiwi, Meny og Oda" — the chains actually in the leksikon, so
  // the copy on Om/i bunnteksten follows the coverage threshold instead of
  // naming a chain the visitor can't find anywhere on the site.
  function storeListText() {
    var names = STORES.map(function (s) { return s.name; });
    if (!names.length) return 'norske dagligvarekjeder';
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(', ') + ' og ' + names[names.length - 1];
  }

  var HASH_FOR = { home: '#/', scan: '#/skann', liste: '#/liste', om: '#/om' };
  function go(hash) { if (location.hash === hash || (hash === '#/' && !location.hash)) route(); else location.hash = hash; }
  function nav(view) { return function (e) { if (e && e.preventDefault) e.preventDefault(); go(HASH_FOR[view] || '#/'); window.scrollTo(0, 0); }; }
  function openGroup(key) { return function () { go('#/gruppe/' + encodeURIComponent(key)); window.scrollTo(0, 0); }; }
  function openVariant(key, store) { return function () { go('#/vare/' + encodeURIComponent(key) + '/' + encodeURIComponent(store)); window.scrollTo(0, 0); }; }

  // ── Analytics ────────────────────────────────────────────────────────────
  // Vercel Web Analytics counts a view only when the *pathname* changes, and
  // its tracker skips hash-only navigation outright — so in this hash-routed
  // app every screen would land on "/" and the dashboard would show one page.
  // We report the views ourselves instead: `path` is the screen the visitor is
  // on, `route` is the pattern it belongs to, so thousands of products group
  // under /gruppe/[gruppe] rather than filling the list one by one. Both are
  // ordinary page views (they hit the same /_vercel/insights/view endpoint as
  // the automatic ones) — not custom events, so no paid plan is involved.
  //
  // `window.va` does not exist until the deferred tracker loads, so calls are
  // queued in `window.vaq` and replayed on load. That queue is Vercel's own
  // snippet; it lives here rather than inline in the HTML so the CSP can stay
  // at script-src 'self'.
  function va() {
    if (typeof window === 'undefined') return;
    if (!window.va) window.va = function () { (window.vaq = window.vaq || []).push(arguments); };
    window.va.apply(null, arguments);
  }

  function viewFor(r) {
    if (r.view === 'gruppe') return { path: '/gruppe/' + encodeURIComponent(r.groupKey), route: '/gruppe/[gruppe]' };
    if (r.view === 'vare') return { path: '/vare/' + encodeURIComponent(r.groupKey) + '/' + encodeURIComponent(r.storeId), route: '/vare/[gruppe]/[butikk]' };
    if (r.view === 'scan') return { path: '/skann', route: '/skann' };
    if (r.view === 'om') return { path: '/om', route: '/om' };
    // The shared list travels in the hash as ?d=<varer> — the screen is what we
    // report, never its payload. See the beforeSend hook below.
    if (r.view === 'liste') return { path: '/liste', route: '/liste' };
    return { path: '/', route: '/' };
  }

  // Derived from parseHash, not from the raw hash, so an unrecognised URL
  // collapses to home exactly the way the router treats it.
  function trackView() {
    var v = viewFor(parseHash());
    va('pageview', { path: v.path, route: v.route });
  }

  var lastTrackedUrl = null;
  function analyticsBeforeSend(e) {
    var u;
    try { u = new URL(e.url); } catch (err) { return e; }
    // The tracker builds the URL from location.href, so the hash rides along
    // even when `path` is set — and on #/liste that hash carries the visitor's
    // shopping list. The screen is already in `path`; the list is not ours to
    // send. (The query string is left alone: it is where utm_* lives.)
    u.hash = '';
    var url = u.href;
    if (e.type === 'pageview') {
      // Two page views for the same URL back-to-back can only be a double
      // fire — you cannot re-enter a screen without leaving it first. This
      // keeps the count honest if the tracker's own auto-tracking ever starts
      // up alongside ours despite data-disable-auto-track.
      if (url === lastTrackedUrl) return null;
      lastTrackedUrl = url;
    }
    return { type: e.type, url: url, payload: e.payload };
  }

  function loadHistory(g) {
    if (!g) return;
    var key = g.key;
    if (state.history[key]) return;
    state.history[key] = 'loading';
    // History rows are keyed by the servers' own group_key; a client group may
    // merge several of them, so fetch by the set of server keys it contains.
    var keys = (g.serverKeys && g.serverKeys.length) ? g.serverKeys : [key];
    var inList = keys.map(function (k) { return '"' + String(k).replace(/"/g, '') + '"'; }).join(',');
    // product_name comes along so the chart can read each point's own pack
    // size — the group page filters and converts per row, not per store.
    sb('/ml_price_history?select=store_id,price,pre_price,is_offer,observed_at,source,product_name&group_key=in.(' + encodeURIComponent(inList) + ')&order=observed_at.asc')
      .then(function (r) { return r.ok ? r.json() : []; })
      // Drop points from stores the leksikon doesn't show, so a hidden chain
      // can't draw a line on the chart or a row in "Registreringer".
      .then(function (rows) {
        state.history[key] = (rows || []).filter(function (r) { return r && STORE_NAME[r.store_id]; });
        if (HISTORY_VIEWS[state.view]) render();
      })
      .catch(function () { state.history[key] = []; if (HISTORY_VIEWS[state.view]) render(); });
  }
  // The screens that draw price history — a finished fetch repaints only these.
  var HISTORY_VIEWS = { vare: 1, gruppe: 1, liste: 1 };

  // The handleliste charts the whole basket, so it needs every listed
  // product's history. One request for the lot (chunked to keep the URL sane)
  // rather than one per item. It lands in its own cache: these rows carry only
  // the columns the chart needs, so they must not stand in for the full rows
  // the product page lists under "Registreringer".
  function loadListHistory() {
    var pending = [], byServerKey = {};
    state.list.forEach(function (e) {
      var g = GROUP_BY_KEY[parseEntry(e).key];
      if (!g || state.listHistory[g.key]) return;
      state.listHistory[g.key] = 'loading';
      pending.push(g);
      (g.serverKeys && g.serverKeys.length ? g.serverKeys : [g.key]).forEach(function (sk) { byServerKey[sk] = g.key; });
    });
    if (!pending.length) return;
    var keys = Object.keys(byServerKey);
    var CHUNK = 40, done = 0, chunks = Math.ceil(keys.length / CHUNK);
    var landed = {};
    pending.forEach(function (g) { landed[g.key] = []; });
    var finish = function () {
      if (++done < chunks) return;
      pending.forEach(function (g) { state.listHistory[g.key] = landed[g.key]; });
      if (HISTORY_VIEWS[state.view]) render();
    };
    for (var i = 0; i < keys.length; i += CHUNK) {
      var part = keys.slice(i, i + CHUNK).map(function (k) { return '"' + String(k).replace(/"/g, '') + '"'; }).join(',');
      // product_name rides along: each line is drawn in the size its entry is
      // pinned to, and only the row itself knows which pack it measured.
      sb('/ml_price_history?select=store_id,price,group_key,observed_at,product_name&group_key=in.(' + encodeURIComponent(part) + ')&order=observed_at.asc')
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (rows) {
          (rows || []).forEach(function (r) {
            if (!r || !STORE_NAME[r.store_id]) return;
            var ck = byServerKey[r.group_key];
            if (ck && landed[ck]) landed[ck].push(r);
          });
          finish();
        })
        .catch(finish);
    }
  }

  // ── Product photos (loaded on demand) ────────────────────────────────────
  // The image URLs are 29 % of the catalogue over the wire (498 kB of 1697 kB
  // gzipped) and they do not compress — they are mostly EANs. A screen shows at
  // most 58 products, so they are fetched per screen from ml_group_images
  // instead of shipped with the catalogue. `hasImage` rides along on the boot
  // payload, so the frame is reserved before the URL lands and nothing shifts.
  //
  // Photos seen once are kept in localStorage: a return visit paints them
  // immediately, and they stay available offline.
  var IMAGES = {};        // see the two key shapes below -> url
  var IMG_ASKED = {};     // server group key -> 1, so each key is requested once
  var IMG_QUEUE = {};     // server group keys waiting for the next flush
  var IMG_KEY = 'prisboka_images_v1';
  var IMG_MAX = 6000;     // ~450 kB of URLs, well inside the localStorage budget

  // Two keys per store, both NUL-joined so a group key or a product name can
  // never run into the next field. The exact key names the pack the catalogue
  // already picked to represent that store, so the photo is the one that used to
  // ship inline -- needed because the client derives a pack's unit price from
  // the product NAME when the row carries no unit_price, which the server cannot
  // do. For 3.4 % of (group, store) pairs the two would otherwise rank a
  // different, equally valid, pack's photo first. The loose key is the fallback.
  function imgKey(serverKey, storeId) { return serverKey + '\u0000' + storeId; }
  function imgKeyExact(serverKey, storeId, rawName) {
    return serverKey + '\u0000' + storeId + '\u0000' + (rawName || '');
  }

  try {
    var savedImgs = JSON.parse(localStorage.getItem(IMG_KEY) || 'null');
    if (savedImgs && typeof savedImgs === 'object') {
      IMAGES = savedImgs;
      // A saved URL means the group was already answered for; don't re-ask.
      Object.keys(IMAGES).forEach(function (k) { IMG_ASKED[k.split('\u0000')[0]] = 1; });
    }
  } catch (e) { /* corrupt or full — start empty */ }

  function saveImages() {
    try {
      var keys = Object.keys(IMAGES);
      var toSave = IMAGES;
      // The cap bounds what is PERSISTED, never the live map: trimming IMAGES
      // itself would blank photos the screen is currently showing. Oldest-first
      // eviction isn't worth a timestamp per entry, so keep the most recently
      // inserted — the screens the shopper actually reached.
      if (keys.length > IMG_MAX) {
        toSave = {};
        keys.slice(keys.length - IMG_MAX).forEach(function (k) { toSave[k] = IMAGES[k]; });
      }
      localStorage.setItem(IMG_KEY, JSON.stringify(toSave));
    } catch (e) { /* quota — the in-memory map still works this session */ }
  }

  // The photo for one variant, once its group has been fetched.
  function imageOf(v) {
    if (!v || !v.hasImage) return null;
    return IMAGES[imgKeyExact(v.serverKey, v.storeId, v.rawName)]
        || IMAGES[imgKey(v.serverKey, v.storeId)]
        || null;
  }
  // A group is represented by the first of its variants (they are ordered by
  // unit price) that has a photo — the same rule as when image_url shipped with
  // every row.
  function groupImage(g) {
    if (!g || !g.hasImage) return null;
    for (var i = 0; i < g.variants.length; i++) {
      var u = imageOf(g.variants[i]);
      if (u) return u;
    }
    return null;
  }

  // Queue a group's photos. Called while building a screen; the fetch itself is
  // flushed once, after the render, so one screen costs one round trip.
  function wantImages(g) {
    if (!g || !g.hasImage || !g.serverKeys) return;
    g.serverKeys.forEach(function (sk) {
      if (sk && !IMG_ASKED[sk]) IMG_QUEUE[sk] = 1;
    });
  }

  function flushImages() {
    var keys = Object.keys(IMG_QUEUE);
    if (!keys.length) return;
    IMG_QUEUE = {};
    keys.forEach(function (sk) { IMG_ASKED[sk] = 1; }); // before the request, so a
    // re-render while it is in flight doesn't ask again.

    var CHUNK = 40, done = 0, chunks = Math.ceil(keys.length / CHUNK), landed = false;
    var finish = function () {
      if (++done < chunks) return;
      if (landed) { saveImages(); render(); }
    };
    for (var i = 0; i < keys.length; i += CHUNK) {
      var part = keys.slice(i, i + CHUNK).map(function (k) { return '"' + String(k).replace(/"/g, '') + '"'; }).join(',');
      sb('/ml_group_images?select=group_key,store_id,product_name,unit,unit_price,unit_price_unit,price,image_url&group_key=in.(' + encodeURIComponent(part) + ')&order=external_id')
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (rows) {
          // A store can list several pack sizes under one group_key; keep the
          // cheapest per unit, which is the variant the client already promotes.
          // Two chains, or two feeds for one chain, can list the same pack under
          // the same name with different photos, so the exact key has to rank
          // its candidates too rather than let the last row win.
          var pick = {};
          (rows || []).forEach(function (r) {
            if (!r || !r.image_url || !r.group_key || r.store_id == null) return;
            // Exact pack first — one product can reach us from two feeds
            // (kassalapp .../large.jpg and ngdata .../medium.png for one EAN)
            // and only one of them fills unit_price, which is why rankImg reads
            // the size out of the shared name before trusting that column.
            keep(pick, imgKeyExact(r.group_key, r.store_id, r.product_name), r);
            // Store-level fallback, used when the name no longer matches.
            keep(pick, imgKey(r.group_key, r.store_id), r);
          });
          Object.keys(pick).forEach(function (k) {
            var url = pick[k].image_url;
            if (IMAGES[k] !== url) { IMAGES[k] = url; landed = true; }
          });
          finish();
        })
        .catch(finish);
    }
  }
  // Strictly less-than, so on an equal rank the first row wins. The rows arrive
  // ordered by external_id, the same order the catalogue pages in and resolves
  // its own ties by, so the photo matches the pack the leksikon settled on.
  function keep(into, key, row) {
    var cur = into[key];
    if (!cur || rankImg(row) < rankImg(cur)) into[key] = row;
  }
  // Rank a photo row exactly as buildVariant/buildGroups rank a variant: by the
  // unit price read out of the pack NAME, else the row's own unit_price, else
  // the pack price. Ranking on unit_price alone picks a different pack's photo
  // than the one on screen whenever only one of two feeds fills that column.
  function imgPerUnit(r) {
    var price = Number(r.price);
    var amt = parseAmount(r.product_name);
    if (amt && isFinite(price)) return price / amt.value;
    if (r.unit_price != null) {
      var nd = normUnit(r.unit_price_unit || r.unit), up = Number(r.unit_price);
      if (nd && up > 0) return up;
    }
    return null;
  }
  function rankImg(r) {
    var pu = imgPerUnit(r);
    if (pu != null && isFinite(pu)) return pu;   // comparable packs first…
    var p = Number(r.price);
    return isFinite(p) ? 1e9 + p : Infinity;     // …then simply the cheapest pack
  }

  // ── Shared style bits ────────────────────────────────────────────────────
  var MUTED60 = 'color-mix(in srgb, var(--color-text) 60%, transparent)';
  var MUTED70 = 'color-mix(in srgb, var(--color-text) 70%, transparent)';
  var MUTED78 = 'color-mix(in srgb, var(--color-text) 78%, transparent)';
  var KICKER = 'display: block; font-size: 13px; line-height: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: var(--color-accent-700); margin-bottom: 12px;';
  var RULE = 'height: 1px; border: 0; margin: 0 0 24px; background: var(--color-divider);';
  var NAME_STYLE = 'font-family: var(--font-heading); font-weight: 600; font-size: 18px; letter-spacing: 0.02em; text-transform: uppercase;';
  // Same weight, but never upper-cased: "1,75 l" must not read as "1,75 L".
  var SIZE_NAME_STYLE = 'font-family: var(--font-heading); font-weight: 600; font-size: 18px; letter-spacing: 0.02em;';
  var H1 = 'margin: -0.052em 0 0; font-size: clamp(36px, 5vw, 60px); line-height: 1.04; letter-spacing: 0.01em; text-transform: uppercase;';
  function offerTag() { return h('span', { cls: 'tag tag-accent', style: 'background: var(--color-accent-900); color: var(--color-bg);', text: 'På tilbud' }); }

  function dateDM(d) {
    d = String(d || '');
    return d.length >= 10 ? d.slice(8, 10) + '.' + d.slice(5, 7) + '.' + d.slice(0, 4) : d;
  }

  // Where a price point came from: community receipt scan vs. an official
  // chain/feed price. Scanned points get an accent tag so a stray bad scan is
  // easy to spot on the chart's data table.
  function sourceBadge(source) {
    var scan = source === 'scan';
    return h('span', {
      cls: 'tag ' + (scan ? 'tag-accent' : 'tag-neutral'),
      style: 'font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase;' + (scan ? ' background: var(--color-accent-200); color: var(--color-accent-800);' : ''),
      title: scan ? 'Registrert av fellesskapet fra en kvittering' : 'Hentet fra kjedenes prisdata',
      text: scan ? 'Skannet' : 'Offisiell'
    });
  }

  // Adding is a two-step: pick the size you actually buy, so the per-store
  // comparison holds like for like. Removing stays one click. A product with a
  // single size skips the dialog — there's nothing to choose.
  function toggleList(key) {
    if (inList(key)) { removeFromList(key); render(); return; }
    var g = GROUP_BY_KEY[key];
    var opts = g ? sizeOptions(g) : [];
    if (opts.length <= 1) { addToList(key, opts.length ? opts[0].id : 'alle'); render(); return; }
    setState({ sizePicker: { key: key, replace: null } });
  }
  // Re-open the same dialog for an item already on the list. `replace` carries
  // the entry it stands in for, so the new size lands in that entry's slot —
  // changing a size must not shuffle a list the shopper has dragged into order.
  function editEntrySize(entry) {
    return function () { setState({ sizePicker: { key: entry.key, replace: entry.id, current: entry.size } }); };
  }
  // Swap one entry for another in place, keeping its slot. A duplicate of the
  // incoming entry elsewhere in the list is dropped, so a swap can never leave
  // the same product twice.
  function swapEntry(list, oldId, newId) {
    var arr = (Array.isArray(list) ? list : []).slice();
    var i = arr.indexOf(oldId);
    if (i < 0) return arr;
    var dup = arr.indexOf(newId);
    if (dup > -1 && dup !== i) { arr.splice(dup, 1); if (dup < i) i--; }
    arr[i] = newId;
    return arr;
  }
  function replaceEntry(oldId, key, size) {
    // Changing the size must not silently reset how many the shopper wanted.
    var id = entryId(key, size, parseEntry(oldId).qty);
    if (state.list.indexOf(oldId) < 0) { addToList(key, size); return; }
    state.list = swapEntry(state.list, oldId, id);
    saveList();
  }
  // Set the count on an entry, in place — the list is in the shopper's own
  // dragged order, so changing a quantity must not move the row.
  function setEntryQty(entry, qty) {
    var next = clampQty(qty);
    if (next === entry.qty) return;
    state.list = swapEntry(state.list, entry.id, entryId(entry.key, entry.size, next));
    saveList();
    render();
  }

  // Small star toggle overlaid on a product card (does not open the card).
  function cardStar(key) {
    var on = inList(key);
    return h('button', {
      type: 'button', cls: 'blueprint',
      'aria-pressed': on ? 'true' : 'false',
      'aria-label': (on ? 'Fjern fra handlelisten' : 'Legg i handlelisten'),
      title: (on ? 'Fjern fra handlelisten' : 'Legg i handlelisten'),
      style: 'position: absolute; top: 8px; right: 8px; z-index: 2; width: 34px; height: 34px; padding: 0; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 17px; line-height: 1; background: color-mix(in srgb, var(--color-bg) 88%, transparent); color: ' + (on ? 'var(--color-accent-700)' : MUTED60) + ';',
      onClick: function (e) { e.stopPropagation(); toggleList(key); },
      onKeydown: function (e) { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') e.stopPropagation(); }
    }, on ? '★' : '☆');
  }

  // Full-width "add to list" toggle for the group/variant headers.
  function listToggleBtn(key) {
    var on = inList(key);
    return h('button', { type: 'button', cls: 'btn ' + (on ? 'btn-secondary' : 'btn-ghost'), 'aria-pressed': on ? 'true' : 'false', onClick: function () { toggleList(key); }, text: on ? '★ I handlelisten' : '☆ Legg i handlelisten' });
  }

  // The size dialog itself — one row per size, with what it costs and how many
  // stores carry it, plus "alle størrelser" for a shopper who just wants the
  // product at whatever size is cheapest.
  function sizePickerOverlay() {
    var req = state.sizePicker || {};
    var g = req.key ? GROUP_BY_KEY[req.key] : null;
    if (!g) return null;
    var editing = !!req.replace;
    var close = function () { setState({ sizePicker: null }); };
    var pick = function (id) {
      return function () {
        if (editing) replaceEntry(req.replace, req.key, id); else addToList(req.key, id);
        setState({ sizePicker: null });
      };
    };
    var opts = sizeOptions(g);
    var rowStyle = 'display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; width: 100%; text-align: left; padding: 12px 16px; cursor: pointer; border: 0; background: transparent; color: inherit; font: inherit; border-bottom: 1px solid color-mix(in srgb, var(--color-text) 8%, transparent);';
    var sizeRow = function (id, label, sub, price) {
      var on = editing && req.current === id;
      return h('button', {
        type: 'button', cls: 'row-hover', 'aria-current': on ? 'true' : false,
        style: rowStyle + (on ? ' background: color-mix(in srgb, var(--color-accent) 8%, transparent);' : ''),
        onClick: pick(id)
      }, [
        h('span', {}, [
          h('span', { style: SIZE_NAME_STYLE, text: label }),
          h('span', { style: 'display: block; font-size: 13px; color: ' + MUTED60 + ';', text: on ? sub + ' · valgt nå' : sub })
        ]),
        h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 18px; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: 'fra ' + nf(price) })
      ]);
    };
    var rows = opts.map(function (o) {
      return sizeRow(o.id, o.label, o.storeCount + (o.storeCount === 1 ? ' butikk' : ' butikker'), o.minPrice);
    });
    rows.push(sizeRow('alle', 'Alle størrelser', 'sammenlign på billigst per kg/l uansett pakning', g.minPrice));
    var card = h('div', {
      cls: 'blueprint', role: 'dialog', 'aria-modal': 'true', 'aria-label': (editing ? 'Endre størrelse for ' : 'Velg størrelse for ') + g.name,
      style: 'width: min(520px, 100%); max-height: 80vh; overflow: auto; background: var(--color-bg); padding: 0;',
      onClick: function (e) { e.stopPropagation(); }
    }, corners().concat([
      h('div', { style: 'padding: 20px 16px 12px;' }, [
        h('span', { style: KICKER + ' margin-bottom: 6px;', text: editing ? 'Endre størrelse' : 'Velg størrelse' }),
        h('span', { style: 'display: block; font-family: var(--font-heading); font-weight: 600; font-size: 22px; letter-spacing: 0.02em; text-transform: uppercase;', text: g.name }),
        h('p', { style: 'margin: 8px 0 0; font-size: 14px; line-height: 20px; color: ' + MUTED70 + ';', text: (editing ? 'Hvilken pakning skal lista regne med? Varen blir liggende der den er i lista.' : 'Hvilken pakning skal i handlelisten?') + ' Butikksummene regnes ut fra den, så sammenligningen gjelder samme vare.' })
      ]),
      h('div', {}, rows),
      h('div', { style: 'padding: 14px 16px;' }, [
        h('button', { type: 'button', cls: 'btn btn-ghost', 'data-focus-id': 'size-cancel', onClick: close, text: 'Avbryt' })
      ])
    ]));
    return h('div', {
      style: 'position: fixed; inset: 0; z-index: 50; background: color-mix(in srgb, var(--color-text) 45%, transparent); display: flex; align-items: center; justify-content: center; padding: 20px;',
      onClick: close,
      onKeydown: function (e) { if (e.key === 'Escape') close(); }
    }, [card]);
  }

  // "Copy link" button with transient confirmation, keyed on the current hash.
  function copyLinkBtn() {
    var done = state.copiedFor === (location.hash || '#/');
    return h('button', { type: 'button', cls: 'btn btn-ghost', style: 'font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;', onClick: function () {
      var here = location.hash || '#/';
      var mark = function () { state.copiedFor = here; render(); setTimeout(function () { if (state.copiedFor === here) { state.copiedFor = null; render(); } }, 2000); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(location.href).then(mark, mark);
        else mark();
      } catch (e) { mark(); }
    }, text: done ? '✓ Lenke kopiert' : 'Kopier lenke' });
  }

  // The ingest runs weekly, so a newest price point older than STALE_AFTER_DAYS
  // means a run was missed — a broken token, a source that changed shape, a
  // cron that stopped. Without a visible signal the site just keeps serving
  // last month's prices as if they were today's, which is the one failure a
  // price comparison must not hide. Returns the age in whole days, else 0.
  var STALE_AFTER_DAYS = 10;
  function staleDaysFor(lastUpdated, nowMs) {
    if (!lastUpdated) return 0;
    var t = Date.parse(String(lastUpdated).slice(0, 10) + 'T00:00:00Z');
    if (!isFinite(t)) return 0;
    var days = Math.floor((nowMs - t) / 864e5);
    return days >= STALE_AFTER_DAYS ? days : 0;
  }
  function staleDays() { return staleDaysFor(state.lastUpdated, Date.now()); }

  // The shopping-list link. A phone's top bar only fits the brand plus three
  // items on one line, so there the label gives way to a cart glyph (with the
  // count riding along as a badge) — see the .nav-cart rules in index.html.
  // Both spellings are always in the DOM; CSS decides which one is shown.
  function navCartLink() {
    var n = listCount();
    var label = 'Handleliste' + (n ? ' (' + n + ')' : '');
    return h('a', { cls: 'nav-cart', href: '#/liste', onClick: nav('liste'), 'aria-label': label, title: label }, [
      h('span', { cls: 'nav-cart-text', text: label }),
      h('span', { cls: 'nav-cart-icon' }, [
        h('svg', { width: '20', height: '20', viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' }, [
          h('path', {
            d: 'M1.6 2.6h2.2l2.3 8.2a1.4 1.4 0 0 0 1.35 1.05h6.6a1.4 1.4 0 0 0 1.35-1.05L17.1 5.3H4.5',
            stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
          }),
          h('circle', { cx: '8', cy: '16.4', r: '1.3', fill: 'currentColor' }),
          h('circle', { cx: '14.4', cy: '16.4', r: '1.3', fill: 'currentColor' })
        ]),
        n ? h('span', { cls: 'nav-cart-count', 'aria-hidden': 'true', text: String(n) }) : null
      ])
    ]);
  }

  function renderNav() {
    return h('nav', { cls: 'nav', 'data-screen-label': 'Topplinje', style: 'padding-inline: max(24px, calc((100% - 1160px) / 2 + 24px));' }, [
      h('span', Object.assign({ cls: 'nav-brand', style: 'cursor: pointer;', text: 'Prisboka' }, activate(nav('home'), 'Prisboka — til forsiden'))),
      h('a', { href: '#/', onClick: nav('home'), text: 'Leksikon' }),
      navCartLink(),
      h('a', { href: '#/skann', onClick: nav('scan'), text: 'Bidra med priser' }),
      h('a', { cls: 'nav-wide-only', href: '#/om', onClick: nav('om'), text: 'Om' }),
      h('span', { cls: 'nav-wide-only', style: 'flex: 1;' }),
      h('span', {
        style: 'font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; '
          + "font-feature-settings: 'tnum' 1; color: " + (staleDays() ? 'var(--color-accent-700)' : MUTED70) + ';',
        title: staleDays() ? 'Prisene oppdateres ukentlig, men siste registrering er ' + staleDays() + ' dager gammel.' : false,
        text: VALID_COUNT + ' ekte priser · '
          + (state.lastUpdated ? 'sist oppdatert ' + dateDM(state.lastUpdated) : 'oppdatert ukentlig')
          + (staleDays() ? ' · kan være utdatert' : '')
      }),
      h('button', { type: 'button', cls: 'btn btn-primary nav-wide-only', onClick: nav('scan'), text: 'Skann kvittering' })
    ]);
  }

  // How well a group's *name* matches the search query, so the closest product
  // floats to the top. A word that IS the query or is a compound ENDING in it
  // ("helmelk", "lettmelk" for "melk") is the searched thing / a kind of it and
  // scores highest; merely starting with it ("melkesjokolade") or containing it
  // scores less. Norwegian names lead with the product and trail the brand, so
  // an earlier match is a better head-noun match; a query sitting after a
  // preposition ("havregrøt MED melk") is an ingredient, not the product, and is
  // demoted. Shorter names win within a tier (closer to the bare word); a match
  // only in a variant's raw name (not the shown name) ranks last.
  function searchRank(g, q) {
    var name = String(g.name || '').toLowerCase();
    if (name === q) return 1e9;
    var ws = name.split(/[^0-9a-zæøå]+/).filter(Boolean), best = -Infinity;
    for (var i = 0; i < ws.length; i++) {
      var w = ws[i], base = 0;
      if (w === q || (w.length > q.length && w.slice(-q.length) === q)) base = 3; // is q / a kind of q
      else if (w.indexOf(q) === 0) base = 1;                                      // starts with q
      else if (w.indexOf(q) > -1) base = 0.5;                                     // contains q
      if (!base) continue;
      var s = base * 100 - i * 15;                                               // earlier = better head noun
      if (i > 0 && /^(med|m|uten|u|i|til)$/.test(ws[i - 1])) s -= 70;            // "… med melk" = ingredient
      if (s > best) best = s;
    }
    if (best === -Infinity) best = name.indexOf(q) > -1 ? 120 : 5;               // phrase, or variant-text-only
    return best * 100 - Math.min(name.length, 80) + (g.onOffer ? 0.5 : 0);
  }

  // ── Home ─────────────────────────────────────────────────────────────────
  function renderHome() {
    var q = state.query.trim().toLowerCase();
    var sf = state.storeFilter || 'Alle';
    var filtered = GROUPS.filter(function (g) {
      if (sf !== 'Alle' && !g.variants.some(function (v) { return v.storeName === sf; })) return false;
      if (q && g.searchText.indexOf(q) === -1) return false;
      return true;
    });
    var byName = function (a, b) { return a.name.localeCompare(b.name, 'nb'); };
    // The sort price follows the chosen view: per kg/l (unit price, items
    // without one sink to the bottom) or per pack (enhetspris).
    var kilo = state.priceMode === 'kilo';
    var sortVal = function (g) { return kilo ? (g.unitPrice != null ? g.unitPrice : Infinity) : g.minPrice; };
    if (state.sort === 'billigst') filtered.sort(function (a, b) { return (sortVal(a) - sortVal(b)) || byName(a, b); });
    else if (state.sort === 'dyrest') filtered.sort(function (a, b) { return (sortVal(b) - sortVal(a)) || byName(a, b); });
    else if (state.sort === 'navn') filtered.sort(byName);
    else if (q) filtered.sort(function (a, b) { return (searchRank(b, q) - searchRank(a, q)) || byName(a, b); }); // relevance while searching
    else filtered.sort(function (a, b) { return (b.onOffer - a.onOffer) || byName(a, b); });
    var CAP = 50;
    var shown = filtered.slice(0, CAP);
    shown.forEach(wantImages);

    var hero = h('div', { style: 'padding: 64px 0 40px;' }, [
      h('h1', { style: 'margin: -0.052em 0 0; font-size: clamp(44px, 6vw, 76px); line-height: 1.04; letter-spacing: 0.01em; text-transform: uppercase;' }, ['Matvareleksikonet', h('br'), 'med ekte priser']),
      h('p', { style: 'margin: 20px 0 0; max-width: 60ch; font-size: 16px; line-height: 24px;' }, [
        'Ekte priser fra kjedenes tilbudsaviser. Søk opp en vare, se hvor den selges og til hvilken pris — og hva som er på tilbud denne uka.'
      ]),
      h('div', { style: 'display: flex; gap: 10px; margin-top: 28px; max-width: 640px;' }, [
        h('input', { cls: 'input', type: 'search', placeholder: 'Søk i leksikonet — f.eks. laks, kaffe, brokkoli …', value: state.query, 'aria-label': 'Søk etter matvare', 'data-focus-id': 'search', style: 'flex: 1; min-height: 40px; font-size: 16px;', onInput: function (e) { setState({ query: e.target.value }); } }),
        h('button', { type: 'button', cls: 'btn btn-ghost', onClick: function () { setState({ query: '' }); }, text: 'Nullstill' })
      ])
    ]);

    var picked = pickWeeklyOffers(GROUPS, 8, 2);
    var bestSection = null;
    if (!q && picked.length) {
      picked.forEach(function (o) { wantImages(o.g); });
      bestSection = h('div', { style: 'padding-bottom: 48px;' }, [
        h('span', { style: KICKER, text: '01 · Ukas tilbud' }),
        h('hr', { style: RULE }),
        h('div', { style: 'display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 28px;' }, picked.map(function (o) {
          var v = o.v;
          return h('div', Object.assign({ cls: 'blueprint card-hover', style: 'padding: 0; cursor: pointer; display: flex; flex-direction: column;' }, activate(openGroup(o.g.key), o.g.name + ', tilbud hos ' + v.storeName + ', ' + nf(v.price))), corners().concat([
            cardStar(o.g.key),
            imgBox(imageOf(v), v.name, '150px', v.hasImage),
            h('div', { style: 'padding: 14px 16px; display: flex; flex-direction: column; gap: 6px;' }, [
              h('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px;' + (v.hasImage ? '' : ' padding-right: 32px;') }, [
                h('span', { cls: 'tag tag-outline', text: v.storeName }),
                h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 15px; color: var(--color-accent-900);', text: '−' + pctOff(v) + ' %' })
              ]),
              h('span', { style: NAME_STYLE, text: v.name }),
              h('div', { style: 'display: flex; align-items: baseline; gap: 8px;' }, [
                h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 24px; font-feature-settings: 'tnum' 1;", text: nf(v.price) }),
                v.prePrice ? h('span', { style: "font-size: 13px; color: " + MUTED60 + "; text-decoration: line-through; font-feature-settings: 'tnum' 1;", text: nf(v.prePrice) }) : null
              ]),
              (v.perUnit != null) ? h('span', { style: 'font-size: 12px; color: ' + MUTED60 + "; font-feature-settings: 'tnum' 1;", text: nfUnit(v.perUnit, v.unitDim) }) : null
            ])
          ]));
        }))
      ]);
    }

    var storeChips = ['Alle'].concat(STORES.map(function (s) { return s.name; }));
    var chips = h('div', { role: 'group', 'aria-label': 'Filtrer på butikk', style: 'display: flex; flex-wrap: wrap; gap: 10px;' }, storeChips.map(function (c) {
      return h('button', { type: 'button', cls: 'btn ' + (c === sf ? 'btn-primary' : 'btn-ghost'), 'aria-pressed': c === sf ? 'true' : 'false', onClick: function () { setState({ storeFilter: c }); }, style: 'min-height: 34px; padding: 4px 14px; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase;', text: c });
    }));
    // Vis-pris toggle: per kg/l (jamførpris) vs enhetspris (pack price).
    var PMODES = [['kilo', 'Per kg/l'], ['enhet', 'Enhetspris']];
    var priceModeControl = h('label', { style: 'display: flex; align-items: center; gap: 8px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: ' + MUTED70 + '; white-space: nowrap;' }, [
      'Vis pris',
      h('div', { role: 'group', 'aria-label': 'Vis pris per', style: 'display: inline-flex; border: 1px solid var(--color-divider);' }, PMODES.map(function (o, idx) {
        var on = state.priceMode === o[0];
        return h('button', { type: 'button', 'aria-pressed': on ? 'true' : 'false', onClick: function () { setState({ priceMode: o[0] }); }, style: 'min-height: 34px; padding: 4px 12px; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; cursor: pointer; border: 0;' + (idx > 0 ? ' border-left: 1px solid var(--color-divider);' : '') + (on ? ' background: var(--color-accent); color: var(--color-bg);' : ' background: transparent; color: var(--color-text);'), text: o[1] });
      }))
    ]);
    var SORTS = [['relevans', q ? 'Beste treff' : 'Tilbud først'], ['billigst', 'Billigst'], ['dyrest', 'Dyrest'], ['navn', 'Navn A–Å']];
    var sortControl = h('label', { style: 'display: flex; align-items: center; gap: 8px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: ' + MUTED70 + '; white-space: nowrap;' }, [
      'Sorter',
      h('select', { cls: 'input', 'aria-label': 'Sorter varene', style: 'min-height: 34px; width: auto;', value: state.sort, onChange: function (e) { setState({ sort: e.target.value }); } },
        SORTS.map(function (o) { return h('option', { value: o[0], selected: state.sort === o[0] ? 'selected' : false, text: o[1] }); }))
    ]);
    var rightControls = h('div', { style: 'display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: center;' }, [priceModeControl, sortControl]);
    var controls = h('div', { style: 'display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: center; justify-content: space-between; margin-bottom: 32px;' }, [chips, rightControls]);

    var grid = h('div', { style: 'display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 32px;' }, shown.map(function (g) {
      var hasUnit = g.unitPrice != null;
      var pre = g.storeCount > 1 ? 'fra ' : '';
      var whereTxt = g.storeCount > 1 ? 'hos ' + g.storeCount + ' butikker' : g.variants[0].storeName;
      var priceTxt, subTxt;
      if (kilo && hasUnit) {
        // Lead with the per kg/l/stk price; pack price beneath.
        priceTxt = pre + nfUnit(g.unitPrice, g.unitDim);
        subTxt = 'fra ' + nf(g.minPrice) + ' · ' + whereTxt;
      } else {
        // Enhetspris (pack price) leads; comparison price beneath when known.
        priceTxt = pre + nf(g.minPrice);
        subTxt = hasUnit ? (nfUnit(g.unitPrice, g.unitDim) + ' · ' + whereTxt) : (g.storeCount > 1 ? whereTxt : (g.onOffer ? whereTxt : ''));
      }
      return h('div', Object.assign({ cls: 'blueprint card-hover', style: 'padding: 0; cursor: pointer; display: flex; flex-direction: column;' }, activate(openGroup(g.key), g.name + ', ' + priceTxt + ' ' + whereTxt)), corners().concat([
        cardStar(g.key),
        imgBox(groupImage(g), g.name, '150px', g.hasImage),
        h('div', { style: 'padding: 16px 18px 18px; display: flex; flex-direction: column; gap: 6px;' }, [
          h('div', { style: 'display: flex; gap: 8px; align-items: center; min-height: 20px;' }, [
            g.onOffer ? offerTag() : h('span', { style: 'font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: ' + MUTED60 + ';', text: whereTxt })
          ]),
          h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 22px; line-height: 1.1; letter-spacing: 0.02em; text-transform: uppercase;', text: g.name }),
          h('div', { style: 'display: flex; align-items: baseline; gap: 10px; margin-top: 6px;' }, [
            h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 24px; font-feature-settings: 'tnum' 1;", text: priceTxt })
          ]),
          h('span', { style: 'font-size: 13px; color: ' + MUTED60 + ';', text: subTxt })
        ])
      ]));
    }));

    var catalog = h('div', {}, [
      h('span', { style: KICKER, text: q ? 'Treff i leksikonet (' + filtered.length + ')' : (bestSection ? '02 · Hele leksikonet (' + filtered.length + ' varer)' : 'Hele leksikonet (' + filtered.length + ' varer)') }),
      h('hr', { style: 'height: 1px; border: 0; margin: 0 0 20px; background: var(--color-divider);' }),
      controls, grid,
      filtered.length > CAP ? h('p', { style: 'margin-top: 24px; font-size: 14px; color: ' + MUTED70 + ';', text: 'Viser de første ' + CAP + ' av ' + filtered.length + ' varer — søk for å finne flere.' }) : null,
      filtered.length === 0 ? h('p', { style: 'font-size: 15px; color: ' + MUTED70 + ';', text:
        GROUPS.length === 0 ? 'Leksikonet er tomt akkurat nå. Prøv igjen om litt, eller bidra med priser ved å skanne en kvittering.'
        : q ? ('Ingen treff på «' + state.query + '»' + (sf !== 'Alle' ? ' hos ' + sf : '') + '. Prøv et annet søk, eller bidra med priser ved å skanne en kvittering.')
        : ('Ingen varer' + (sf !== 'Alle' ? ' hos ' + sf : '') + ' akkurat nå. Velg en annen butikk eller nullstill filteret.') }) : null
    ]);

    return h('section', { 'data-screen-label': 'Hovedside' }, [hero, bestSection, catalog]);
  }

  function notFoundView(msg) {
    return h('section', { 'data-screen-label': 'Ikke funnet' }, [
      h('div', { style: 'padding: 64px 0 24px;' }, [
        h('h1', { style: H1, text: 'Fant ikke varen' }),
        h('p', { style: 'margin: 16px 0 24px; max-width: 56ch; font-size: 16px; line-height: 24px; color: ' + MUTED70 + ';', text: msg }),
        h('a', { href: '#/', onClick: nav('home'), cls: 'btn btn-primary', text: 'Til leksikonet' })
      ])
    ]);
  }

  // ── Group page: similar products + where sold ────────────────────────────
  function renderGroup() {
    var g = GROUP_BY_KEY[state.groupKey];
    if (!g) return notFoundView('Denne varen finnes ikke i leksikonet lenger — den kan ha gått ut av ukas sortiment. Søk den opp på nytt fra forsiden.');
    wantImages(g);
    var head = h('div', { style: 'padding: 40px 0 24px; display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start;' }, [
      h('div', { style: 'flex: 1; min-width: 260px;' }, [
        h('div', { style: 'display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;' }, [
          h('a', { href: '#/', onClick: nav('home'), style: 'font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;', text: '← Tilbake til leksikonet' }),
          copyLinkBtn()
        ]),
        h('div', { style: 'display: flex; flex-wrap: wrap; align-items: baseline; gap: 16px; margin-top: 20px;' }, [
          h('h1', { style: H1, text: g.name }),
          g.onOffer ? offerTag() : null
        ]),
        h('p', { style: 'margin: 12px 0 0; font-size: 15px; color: ' + MUTED70 + ';', text: g.storeCount > 1 ? ('Selges hos ' + g.storeCount + ' butikker · billigst ' + (g.compDim ? nfUnit(g.minUnit, g.compDim) : nf(g.minPrice))) : ('Selges hos ' + g.variants[0].storeName + ' · ' + nf(g.minPrice)) }),
        g.compDim ? h('p', { style: 'margin: 6px 0 0; font-size: 13px; color: ' + MUTED60 + ';', text: 'Sammenlignet per ' + g.compDim + ' siden pakningsstørrelsene er ulike.' }) : null,
        h('div', { style: 'margin-top: 18px;' }, [listToggleBtn(g.key)])
      ]),
      heroImgBox(groupImage(g), g.name, g.hasImage)
    ]);

    // Controls shared by both sections below: which stores to look at, which
    // size, and how to order the store list.
    var gStores = g.variants.map(function (v) { return v.storeName; });
    var gsf = gStores.indexOf(state.groupStore) > -1 ? state.groupStore : 'Alle';
    var gSizes = sizeOptions(g);
    var gsize = gSizes.filter(function (o) { return o.id === state.groupSize; }).length ? state.groupSize : 'alle';
    var shownVariants = bestPerStore(g, gsize).filter(function (v) { return gsf === 'Alle' || v.storeName === gsf; });
    var GSORTS = [['billigst', 'Billigst per kg/l'], ['storrelse', 'Størst pakning'], ['butikk', 'Butikk A–Å']];
    if (state.groupSort === 'storrelse') {
      shownVariants.sort(function (a, b) { return (b.amount || 0) - (a.amount || 0) || a.price - b.price; });
    } else if (state.groupSort === 'butikk') {
      shownVariants.sort(function (a, b) { return String(a.storeName).localeCompare(String(b.storeName), 'nb'); });
    }

    // `caps: false` for the size chips — "1,75 l" must not shout "1,75 L".
    var chipRow = function (label, values, current, onPick, caps) {
      return h('div', { role: 'group', 'aria-label': label, style: 'display: flex; flex-wrap: wrap; gap: 8px;' }, values.map(function (o) {
        var on = o.id === current;
        return h('button', { type: 'button', cls: 'btn ' + (on ? 'btn-primary' : 'btn-ghost'), 'aria-pressed': on ? 'true' : 'false', style: 'min-height: 32px; padding: 3px 12px; font-size: 12px; letter-spacing: 0.06em;' + (caps === false ? '' : ' text-transform: uppercase;'), onClick: function () { onPick(o.id); }, text: o.label });
      }));
    };
    var storeChoices = [{ id: 'Alle', label: 'Alle butikker' }].concat(g.variants.map(function (v) { return { id: v.storeName, label: v.storeName }; }));
    var sizeChoices = [{ id: 'alle', label: 'Alle størrelser' }].concat(gSizes.map(function (o) { return { id: o.id, label: o.label }; }));
    var groupControls = h('div', { style: 'display: flex; flex-wrap: wrap; gap: 14px 24px; align-items: center; justify-content: space-between; margin-bottom: 18px;' }, [
      h('div', { style: 'display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center;' }, [
        chipRow('Filtrer på butikk', storeChoices, gsf, function (id) { setState({ groupStore: id }); }),
        gSizes.length > 1 ? chipRow('Filtrer på størrelse', sizeChoices, gsize, function (id) { setState({ groupSize: id }); }, false) : null
      ]),
      h('label', { style: 'display: flex; align-items: center; gap: 8px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: ' + MUTED70 + '; white-space: nowrap;' }, [
        'Sorter',
        h('select', { cls: 'input', 'aria-label': 'Sorter butikkene', style: 'min-height: 34px; width: auto;', value: state.groupSort, onChange: function (e) { setState({ groupSort: e.target.value }); } },
          GSORTS.map(function (o) { return h('option', { value: o[0], selected: state.groupSort === o[0] ? 'selected' : false, text: o[1] }); }))
      ])
    ]);

    var rows = shownVariants.map(function (v) {
      var vu = v.validUntil ? 'Gyldig til ' + v.validUntil.slice(8, 10) + '.' + v.validUntil.slice(5, 7) : '';
      var vd = v.offerDays ? 'Gjelder ' + v.offerDays : '';
      var nSizes = gsize === 'alle' ? sizesFor(g, v.storeId).length : 1;
      var sub = v.rawName + (vd ? ' · ' + vd : '') + (vu ? ' · ' + vu : '') + (nSizes > 1 ? ' · ' + nSizes + ' størrelser' : '');
      return h('div', Object.assign({ cls: 'row-hover', style: 'display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; cursor: pointer; padding: 14px 20px; border-bottom: 1px solid color-mix(in srgb, var(--color-text) 8%, transparent);' }, activate(openVariant(g.key, v.storeId), v.storeName + ', ' + nf(v.price) + (nSizes > 1 ? ', ' + nSizes + ' størrelser' : '') + ', se prishistorikk')), [
        h('span', { style: 'display: flex; align-items: center; gap: 12px;' }, [
          storeLine(v.color, v.dash, 18),
          h('span', {}, [
            h('span', { style: NAME_STYLE, text: v.storeName }),
            h('span', { style: 'display: block; font-size: 13px; color: ' + MUTED60 + ';', text: sub })
          ])
        ]),
        v.isOffer ? h('span', { cls: 'tag tag-outline', text: '−' + pctOff(v) + ' %' }) : h('span'),
        h('span', { style: 'display: flex; flex-direction: column; align-items: flex-end; gap: 2px;' }, [
          h('span', { style: 'display: flex; align-items: baseline; gap: 8px; justify-content: flex-end;' }, [
            v.prePrice ? h('span', { style: "font-size: 13px; color: " + MUTED60 + "; text-decoration: line-through; font-feature-settings: 'tnum' 1;", text: nf(v.prePrice) }) : null,
            h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 22px; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: nf(v.price) })
          ]),
          (v.perUnit != null) ? h('span', { style: 'font-size: 12px; color: ' + MUTED60 + "; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: nfUnit(v.perUnit, v.unitDim) }) : null
        ])
      ]);
    });

    var table = h('div', {}, [
      h('span', { style: KICKER, text: '01 · Selges hos' }),
      h('hr', { style: RULE }),
      groupControls,
      h('div', { cls: 'blueprint', style: 'padding: 0;' }, corners().concat(rows.length ? rows : [
        h('p', { style: 'margin: 0; padding: 20px; font-size: 14px; color: ' + MUTED60 + ';', text: 'Ingen butikker fører denne varen i valgt størrelse.' })
      ])),
      h('p', { style: 'margin: 16px 0 0; font-size: 13px; color: ' + MUTED60 + ';', text: 'Prisene sammenlignes per liter/kilo. Trykk på en butikk for å se størrelsene den har og alle registreringene.' })
    ]);

    // ── Prishistorikk, right on the product page ───────────────────────────
    // Both filters above drive the chart: the chain filter picks the lines,
    // and the size filter keeps only the points recorded for that pack — each
    // history row names the product it came from, so its own size is knowable
    // (rowAmount). Per kg/l divides by *that* row's size, never by the pack the
    // store happens to sell today, which is the only way a group whose weekly
    // point flips between a 0,5 l and a 1,75 l carton compares at all.
    var hist = state.history[g.key];
    var visibleStores = {};
    shownVariants.forEach(function (v) { visibleStores[v.storeId] = 1; });
    var histBody, histNote = '';
    if (hist === 'loading' || hist == null) {
      histBody = h('p', { style: 'font-size: 15px; color: ' + MUTED70 + ';', text: 'Laster prishistorikk …' });
    } else {
      var perUnit = state.histMode === 'kilo';
      var inView = hist.filter(function (r) { return visibleStores[r.store_id]; });
      var hrows = gsize === 'alle' ? inView : inView.filter(function (r) { return rowSizeId(r) === gsize; });
      var sizeDropped = inView.length - hrows.length;
      var unitDropped = 0;
      var series = storeSeries(hrows, function (r) {
        var p = Number(r.price);
        if (!perUnit) return p;
        var a = rowAmount(r);
        if (!a) { unitDropped++; return null; }
        return p / a.value;
      });
      if (!series.length) {
        histBody = h('p', { style: 'font-size: 15px; line-height: 22px; color: ' + MUTED70 + ';', text: !inView.length
          ? 'Ingen prishistorikk ennå for dette utvalget. Den bygges opp fra uke til uke.'
          : (!hrows.length
            ? 'Ingen målepunkter for ' + sizeLabel(gsize).toLowerCase() + ' ennå. Hver uke lagres bare den billigste pakningen per butikk, så en størrelse dukker opp i grafen de ukene den var billigst. Velg «alle størrelser» for å se alt.'
            : 'Ingen av målepunktene oppgir en pakningsstørrelse, så prisen kan ikke regnes om per kg/l.') });
      } else {
        var ch = chartFrom(series);
        var dims = {};
        hrows.forEach(function (r) { var a = rowAmount(r); if (a) dims[a.dim] = 1; });
        var dim = Object.keys(dims)[0] || 'enhet';
        histNote = (ch.single ? 'Ett målepunkt så langt — prishistorikken bygges opp hver uke fra tilbudsavisene.' : 'Ukentlige målepunkter fra tilbudsavisene.')
          + (perUnit ? ' Vist per ' + dim + ', regnet om med pakningsstørrelsen hvert målepunkt faktisk gjelder' + (unitDropped ? ' — målepunkter uten oppgitt størrelse er utelatt' : '') + '.' : '')
          + (gsize !== 'alle' ? ' Bare målepunkter for ' + sizeLabel(gsize).toLowerCase() + (sizeDropped ? ' — ' + sizeDropped + ' punkt' + (sizeDropped === 1 ? '' : 'er') + ' for andre størrelser er utelatt' : '') + '.' : '');
        histBody = chartBlock(ch, null, histNote, 'Prishistorikk for ' + g.name);
      }
    }
    var HMODES = [['enhet', 'Enhetspris'], ['kilo', 'Per kg/l']];
    var histModeControl = h('label', { style: 'display: flex; align-items: center; gap: 8px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: ' + MUTED70 + '; white-space: nowrap;' }, [
      'Vis pris',
      h('div', { role: 'group', 'aria-label': 'Vis prishistorikk per', style: 'display: inline-flex; border: 1px solid var(--color-divider);' }, HMODES.map(function (o, idx) {
        var on = (state.histMode === 'kilo') === (o[0] === 'kilo');
        return h('button', { type: 'button', 'aria-pressed': on ? 'true' : 'false', onClick: function () { setState({ histMode: o[0] }); }, style: 'min-height: 34px; padding: 4px 12px; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; cursor: pointer; border: 0;' + (idx > 0 ? ' border-left: 1px solid var(--color-divider);' : '') + (on ? ' background: var(--color-accent); color: var(--color-bg);' : ' background: transparent; color: var(--color-text);'), text: o[1] });
      }))
    ]);
    var histSection = h('div', { style: 'margin-top: 40px;' }, [
      h('span', { style: KICKER, text: '02 · Prishistorikk' }),
      h('hr', { style: RULE }),
      h('div', { style: 'display: flex; justify-content: flex-end; margin-bottom: 18px;' }, [histModeControl]),
      histBody
    ]);

    return h('section', { 'data-screen-label': 'Produktgruppe' }, [head, table, histSection]);
  }

  // ── Price-history chart ──────────────────────────────────────────────────
  // Generic over its series, so the same chart draws one store's history, a
  // whole product group's, and the shopping list's total. A series is
  // { id, name, color, dash, points: [{ date, value }] }.
  function chartFrom(series) {
    var pl = 46, pr = 14, pt = 14, pb = 24, W = 760, H = 260;
    series = (series || []).filter(function (s) { return s && s.points && s.points.length; });
    var dates = [], seen = {};
    series.forEach(function (s) { s.points.forEach(function (p) { if (!seen[p.date]) { seen[p.date] = 1; dates.push(p.date); } }); });
    dates.sort();
    var di = {}; dates.forEach(function (d, i) { di[d] = i; });
    var lo = Infinity, hi = -Infinity;
    series.forEach(function (s) { s.points.forEach(function (p) { if (p.value < lo) lo = p.value; if (p.value > hi) hi = p.value; }); });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    var pad = (hi - lo) * 0.15 || Math.max(hi * 0.05, 1); lo -= pad; hi += pad;
    var n = dates.length;
    var x = function (i) { return n <= 1 ? (pl + (W - pl - pr) / 2) : pl + (i / (n - 1)) * (W - pl - pr); };
    var y = function (v) { return pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb); };
    var lines = series.map(function (s) {
      var pts = s.points.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      var last = pts[pts.length - 1];
      return {
        id: s.id, name: s.name, color: s.color || 'var(--color-accent)', dash: s.dash || '',
        points: pts.map(function (p) { return x(di[p.date]).toFixed(1) + ',' + y(p.value).toFixed(1); }).join(' '),
        lastX: x(di[last.date]).toFixed(1), lastY: y(last.value).toFixed(1)
      };
    });
    var axis = function (v) { return (Math.abs(v) < 20 ? (Math.round(v * 10) / 10).toFixed(1).replace('.', ',') : String(Math.round(v))) + ' kr'; };
    var grid = []; for (var i = 0; i < 4; i++) { var gv = lo + (i / 3) * (hi - lo), gy = y(gv); grid.push({ y: gy.toFixed(1), ty: (gy + 3.5).toFixed(1), label: axis(gv) }); }
    // With many dates the labels collide — thin them to at most ~10.
    var step = Math.ceil(n / 10) || 1;
    var ticks = dates.map(function (d, i) { return { x: x(i).toFixed(1), label: d.slice(8, 10) + '.' + d.slice(5, 7), show: (i % step === 0) || i === n - 1 }; })
      .filter(function (t) { return t.show; });
    return { W: W, H: H, lines: lines, grid: grid, ticks: ticks, single: n <= 1, dates: dates };
  }

  // Price-history rows → one series per store. `valueOf(row)` returns the
  // plotted number, or null to drop the point (e.g. no size to convert with).
  function storeSeries(rows, valueOf) {
    var byStore = {};
    (rows || []).forEach(function (r) { (byStore[r.store_id] || (byStore[r.store_id] = [])).push(r); });
    return Object.keys(byStore).map(function (s) {
      var pts = [];
      byStore[s].forEach(function (r) {
        var v = valueOf ? valueOf(r, s) : Number(r.price);
        if (v != null && isFinite(v) && v > 0) pts.push({ date: r.observed_at, value: v });
      });
      return { id: s, name: STORE_NAME[s] || s, color: (STORE_STYLE[s] || {}).color || 'var(--color-accent)', dash: (STORE_STYLE[s] || {}).dash || '', points: pts };
    }).filter(function (s) { return s.points.length; });
  }

  function chartLegend(c, emphId) {
    return c.lines.map(function (l) {
      return h('span', { style: 'display: inline-flex; align-items: center; gap: 8px; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; opacity: ' + (!emphId || l.id === emphId ? '1' : '0.55') + ';' }, [storeLine(l.color, l.dash, 26), l.name]);
    });
  }
  function chartSvg(c, emphId, label) {
    var kids = [];
    c.grid.forEach(function (gl) {
      kids.push(h('line', { x1: '46', x2: '748', y1: gl.y, y2: gl.y, stroke: 'var(--color-divider)', 'stroke-width': '1' }));
      kids.push(h('text', { x: '40', y: gl.ty, 'text-anchor': 'end', 'font-size': '11', fill: MUTED60, 'font-family': 'var(--font-body)', text: gl.label }));
    });
    // Anchor the edge ticks inward, or the first and last dates hang off the
    // plot — the last one always shows, so it would clip on every chart.
    c.ticks.forEach(function (t) {
      var x = Number(t.x);
      kids.push(h('text', { x: t.x, y: String(c.H - 6), 'text-anchor': x > c.W - 40 ? 'end' : (x < 60 ? 'start' : 'middle'), 'font-size': '11', fill: MUTED60, 'font-family': 'var(--font-body)', text: t.label }));
    });
    c.lines.forEach(function (l) {
      var emph = !emphId || l.id === emphId;
      kids.push(h('polyline', { points: l.points, fill: 'none', stroke: l.color, 'stroke-width': emph ? '2.8' : '1.6', 'stroke-dasharray': l.dash, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: emph ? '1' : '0.5' }));
      kids.push(h('circle', { cx: l.lastX, cy: l.lastY, r: emph ? '4' : '3', fill: l.color, opacity: emph ? '1' : '0.5' }));
    });
    return h('svg', { viewBox: '0 0 ' + c.W + ' ' + c.H, style: 'width: 100%; height: auto; display: block;', role: 'img', 'aria-label': label || 'Prishistorikk' }, kids);
  }
  // The whole block: legend, chart and caption, in the blueprint frame.
  function chartBlock(c, emphId, note, label) {
    return h('div', { cls: 'blueprint', style: 'padding: 24px;' }, corners().concat([
      h('div', { style: 'display: flex; flex-wrap: wrap; gap: 20px; margin-bottom: 16px;' }, chartLegend(c, emphId)),
      chartSvg(c, emphId, label),
      note ? h('p', { style: 'margin: 16px 0 0; font-size: 13px; line-height: 20px; color: ' + MUTED60 + ';', text: note }) : null
    ]));
  }

  // A history row keeps the product name it was recorded from, so the pack it
  // measured is knowable — read the size off the row itself rather than
  // assuming the pack the store sells today. Only the ingest's cheapest row
  // per (group, store, day) is stored, so which size a point represents can
  // change from week to week; that's exactly why this must be per row.
  function rowAmount(r) { return parseAmount(r && r.product_name) || null; }
  function rowSizeId(r) {
    var a = rowAmount(r);
    return sizeIdOf({ amount: a ? a.value : null, unitDim: a ? a.dim : null });
  }
  function parseSizeId(id) {
    var m = String(id || '').match(/^([\d.]+)(kg|l|stk)$/);
    var v = m ? Number(m[1]) : NaN;
    return m && isFinite(v) && v > 0 ? { value: v, dim: m[2] } : null;
  }
  // What a history row says the entry's pinned size costs.
  //
  // ml_price_history keeps ONE row per (group, store, day) — that day's
  // cheapest pack — so which size got recorded varies by store and by date.
  // Demanding an exact size match therefore threw away whole chains: a list
  // pinned to 1 l lettmelk drew no Kiwi line at all, because Kiwi's recorded
  // row was the 0,5 l carton every single day, while the per-store totals
  // right above the chart had Kiwi as the cheapest chain. When the two sizes
  // are comparable, scale the measured price to the pinned size instead of
  // discarding it — and say so, since a scaled figure is arithmetic on a real
  // measurement, not a price anyone was charged.
  function priceAtSize(row, sizeId) {
    var p = Number(row && row.price);
    if (!isFinite(p) || p <= 0) return null;
    if (!sizeId || sizeId === 'alle') return { price: p, scaled: false };
    if (rowSizeId(row) === sizeId) return { price: p, scaled: false };
    var want = parseSizeId(sizeId), got = rowAmount(row);
    if (!want || !got || want.dim !== got.dim || !(got.value > 0)) return null;
    return { price: Math.round(p * (want.value / got.value) * 100) / 100, scaled: true };
  }

  function renderVariant() {
    var g = GROUP_BY_KEY[state.groupKey];
    if (!g) return notFoundView('Denne varen finnes ikke i leksikonet lenger — den kan ha gått ut av ukas sortiment. Søk den opp på nytt fra forsiden.');
    var v = g.variants.filter(function (x) { return x.storeId === state.storeId; })[0] || g.variants[0];
    wantImages(g);

    var head = h('div', { style: 'padding: 40px 0 24px; display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start;' }, [
      h('div', { style: 'flex: 1; min-width: 260px;' }, [
        h('div', { style: 'display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;' }, [
          h('a', { href: '#/gruppe/' + encodeURIComponent(g.key), onClick: function (e) { e.preventDefault(); openGroup(g.key)(); }, style: 'font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;', text: '← ' + g.name }),
          copyLinkBtn()
        ]),
        h('div', { style: 'display: flex; flex-wrap: wrap; align-items: baseline; gap: 16px; margin-top: 20px;' }, [
          h('h1', { style: H1, text: v.storeName }),
          v.isOffer ? offerTag() : null
        ]),
        h('p', { style: 'margin: 12px 0 0; font-size: 15px; color: ' + MUTED70 + ';', text: v.rawName + (v.offerDays ? ' · gjelder ' + v.offerDays : '') + (v.validUntil ? ' · gyldig til ' + v.validUntil.slice(8, 10) + '.' + v.validUntil.slice(5, 7) : '') }),
        h('div', { style: 'display: flex; align-items: baseline; gap: 12px; margin-top: 14px;' }, [
          h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 40px; font-feature-settings: 'tnum' 1;", text: nf(v.price) }),
          v.prePrice ? h('span', { style: "font-size: 16px; color: " + MUTED60 + "; text-decoration: line-through; font-feature-settings: 'tnum' 1;", text: nf(v.prePrice) }) : null,
          (v.perUnit != null) ? h('span', { style: 'font-size: 15px; color: ' + MUTED70 + "; font-feature-settings: 'tnum' 1;", text: nfUnit(v.perUnit, v.unitDim) }) : null
        ]),
        h('div', { style: 'margin-top: 18px;' }, [listToggleBtn(g.key)])
      ]),
      heroImgBox(imageOf(v) || groupImage(g), v.name, g.hasImage)
    ]);

    var hist = state.history[g.key];
    var histBlock;
    if (hist === 'loading' || hist == null) {
      histBlock = h('p', { style: 'font-size: 15px; color: ' + MUTED70 + ';', text: 'Laster prishistorikk …' });
    } else if (!hist.length) {
      histBlock = h('p', { style: 'font-size: 15px; color: ' + MUTED70 + ';', text: 'Ingen prishistorikk ennå. Den bygges opp fra uke til uke.' });
    } else {
      var c = chartFrom(storeSeries(hist));
      histBlock = chartBlock(c, v.storeId, c.single ? 'Ett målepunkt så langt — prishistorikken bygges opp hver uke fra tilbudsavisene.' : 'Ukentlige målepunkter fra tilbudsavisene.');
    }

    // ── Registreringer: the recorded price points behind the chart ─────────
    var regRows = (Array.isArray(hist) ? hist.slice() : []).sort(function (a, b) {
      return a.observed_at < b.observed_at ? 1 : (a.observed_at > b.observed_at ? -1 : Number(a.price) - Number(b.price));
    }).map(function (r) {
      var color = (STORE_STYLE[r.store_id] || {}).color || 'var(--color-accent)';
      var dash = (STORE_STYLE[r.store_id] || {}).dash || '';
      var d = String(r.observed_at || '');
      var dateTxt = d.length >= 10 ? d.slice(8, 10) + '.' + d.slice(5, 7) + '.' + d.slice(0, 4) : d;
      return h('div', { style: 'display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 12px 20px; border-bottom: 1px solid color-mix(in srgb, var(--color-text) 8%, transparent);' }, [
        h('span', { style: 'display: flex; align-items: center; gap: 12px;' }, [storeLine(color, dash, 18), h('span', { style: NAME_STYLE, text: STORE_NAME[r.store_id] || r.store_id })]),
        h('span', { style: 'display: flex; flex-direction: column; align-items: flex-start; gap: 4px;' }, [
          h('span', { style: 'font-size: 13px; color: ' + MUTED60 + "; font-feature-settings: 'tnum' 1;", text: dateTxt }),
          sourceBadge(r.source)
        ]),
        h('span', { style: 'display: flex; align-items: baseline; gap: 8px; justify-content: flex-end;' }, [
          r.is_offer ? h('span', { cls: 'tag tag-outline', text: 'Tilbud' }) : null,
          h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 20px; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: nf(Number(r.price)) })
        ])
      ]);
    });
    var regBlock = regRows.length
      ? h('div', {}, [
          h('div', { cls: 'blueprint', style: 'padding: 0;' }, corners().concat(regRows)),
          h('p', { style: 'margin: 16px 0 0; font-size: 13px; color: ' + MUTED60 + ';', text: 'Hver registrering er en observert pris hos en butikk på en gitt dato. «Offisiell» er hentet fra kjedenes prisdata; «Skannet» er registrert av fellesskapet fra en kvittering og kan inneholde feil.' })
        ])
      : h('p', { style: 'font-size: 15px; color: ' + MUTED70 + ';', text: (hist === 'loading' || hist == null) ? 'Laster registreringer …' : 'Ingen registreringer ennå.' });

    // ── Størrelser: the same product in the sizes this store carries ───────
    var sizes = sizesFor(g, v.storeId);
    var sizeBlock = null;
    if (sizes.length > 1) {
      var sizeRows = sizes.map(function (s) {
        return h('div', { style: 'display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 12px 20px; border-bottom: 1px solid color-mix(in srgb, var(--color-text) 8%, transparent);' + (s === v ? ' background: color-mix(in srgb, var(--color-accent) 6%, transparent);' : '') }, [
          h('span', { style: 'font-size: 15px;' }, [s.rawName, s.storeId === v.storeId && s === v ? h('span', { style: 'margin-left: 8px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: ' + MUTED60 + ';', text: 'billigst per ' + (s.unitDim || 'enhet') }) : null]),
          s.isOffer ? h('span', { cls: 'tag tag-outline', text: '−' + pctOff(s) + ' %' }) : h('span'),
          h('span', { style: 'display: flex; flex-direction: column; align-items: flex-end; gap: 2px;' }, [
            h('span', { style: 'display: flex; align-items: baseline; gap: 8px; justify-content: flex-end;' }, [
              s.prePrice ? h('span', { style: "font-size: 12px; color: " + MUTED60 + "; text-decoration: line-through; font-feature-settings: 'tnum' 1;", text: nf(s.prePrice) }) : null,
              h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 20px; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: nf(s.price) })
            ]),
            (s.perUnit != null) ? h('span', { style: 'font-size: 12px; color: ' + MUTED60 + "; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: nfUnit(s.perUnit, s.unitDim) }) : null
          ])
        ]);
      });
      sizeBlock = h('div', {}, [
        h('div', { cls: 'blueprint', style: 'padding: 0;' }, corners().concat(sizeRows)),
        h('p', { style: 'margin: 16px 0 0; font-size: 13px; color: ' + MUTED60 + ';', text: v.storeName + ' fører denne varen i flere størrelser — sortert etter pris per liter/kilo.' })
      ]);
    }

    var sections = [];
    if (sizeBlock) sections.push({ title: 'Størrelser hos ' + v.storeName, body: sizeBlock });
    sections.push({ title: 'Prishistorikk', body: histBlock });
    sections.push({ title: 'Registreringer', body: regBlock });
    var body = sections.map(function (s, i) {
      return h('div', { style: i > 0 ? 'margin-top: 40px;' : '' }, [
        h('span', { style: KICKER, text: '0' + (i + 1) + ' · ' + s.title }), h('hr', { style: RULE }), s.body
      ]);
    });
    return h('section', { 'data-screen-label': 'Produktside' }, [head].concat(body));
  }

  // ── Scan screen (unchanged) ──────────────────────────────────────────────
  function renderScan() {
    var head = h('div', { style: 'padding: 56px 0 40px;' }, [
      h('h1', { style: H1, text: 'Skann en kvittering' }),
      h('p', { style: 'margin: 16px 0 0; max-width: 60ch; font-size: 16px; line-height: 24px;', text: 'Bidra med ekte priser: last opp eller ta bilde av en kvittering. Vi leser varelinjene med AI, du fjerner det som er feillest, og prisene lagres slik de står på kvitteringen.' })
    ]);
    var body;
    if (state.scanPhase === 'idle') {
      var uploadInput = h('input', { type: 'file', accept: 'image/*', style: 'display: none;', onChange: function (e) { onScanFile(e.target.files && e.target.files[0]); } });
      var cameraInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display: none;', onChange: function (e) { onScanFile(e.target.files && e.target.files[0]); } });
      var uploadCard = h('div', { cls: 'blueprint', style: 'padding: 28px; display: flex; flex-direction: column; gap: 12px;' }, corners().concat([
        h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 24px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Last opp bilde' }),
        h('p', { style: 'margin: 0; font-size: 15px; line-height: 22px; color: ' + MUTED78 + ';', text: 'Velg et foto av kvitteringen fra enheten din. Vi leser varelinjene automatisk med AI.' }),
        h('label', { cls: 'btn btn-primary', style: 'align-self: flex-start; cursor: pointer; margin-top: 8px;' }, ['Velg bilde', uploadInput])
      ]));
      var cameraCard = h('div', { cls: 'blueprint', style: 'padding: 28px; display: flex; flex-direction: column; gap: 12px;' }, corners().concat([
        h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 24px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Bruk kameraet' }),
        h('p', { style: 'margin: 0; font-size: 15px; line-height: 22px; color: ' + MUTED78 + ';', text: 'Ta bilde av kvitteringen direkte på mobil. Hold den flatt og i godt lys.' }),
        h('label', { cls: 'btn btn-ghost', style: 'align-self: flex-start; cursor: pointer; margin-top: 8px;' }, ['Åpne kamera', cameraInput])
      ]));
      var grid = h('div', { style: 'display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 40px;' }, [uploadCard, cameraCard]);
      var DROP_IDLE = 'color-mix(in srgb, var(--color-text) 28%, transparent)';
      var dropHi = function (e, on) { e.preventDefault(); e.currentTarget.style.background = on ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'transparent'; e.currentTarget.style.borderColor = on ? 'var(--color-accent)' : DROP_IDLE; };
      var dropZone = h('div', {
        style: 'border: 1px dashed ' + DROP_IDLE + '; padding: 22px; background: transparent; transition: background 0.12s ease, border-color 0.12s ease;',
        onDragEnter: function (e) { dropHi(e, true); }, onDragOver: function (e) { dropHi(e, true); },
        onDragLeave: function (e) { dropHi(e, false); },
        onDrop: function (e) { dropHi(e, false); var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) onScanFile(f); }
      }, [
        h('p', { style: 'margin: 0 0 20px; font-size: 14px; color: ' + MUTED70 + ';', text: 'Dra og slipp et bilde av kvitteringen her — eller lim det inn (Ctrl/⌘+V), eller bruk knappene under.' }),
        grid
      ]);
      body = h('div', { style: 'max-width: 820px;' }, [
        state.scanError ? h('p', { style: 'margin: 0 0 16px; font-size: 14px; line-height: 20px; color: var(--color-accent-800);', text: state.scanError }) : null,
        dropZone
      ]);
    } else if (state.scanPhase === 'scanning') {
      var preview = state.scanImageUrl ? h('div', { style: 'position: relative; aspect-ratio: 3 / 4; max-height: 320px; background: var(--color-accent-900); overflow: hidden; margin-bottom: 16px;' }, [
        h('img', { src: state.scanImageUrl, alt: 'Kvittering under lesing', style: 'width: 100%; height: 100%; object-fit: contain; opacity: 0.9;' }),
        h('div', { style: 'position: absolute; left: 0; right: 0; top: 4%; height: 2px; background: color-mix(in srgb, var(--color-bg) 85%, transparent); box-shadow: 0 0 8px var(--color-bg); animation: scanline 2.6s ease-in-out infinite;' })
      ]) : null;
      body = h('div', { cls: 'blueprint', style: 'max-width: 520px; padding: 24px;' }, corners().concat([
        preview,
        h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 22px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Leser kvitteringen …' }),
        h('p', { style: 'margin: 10px 0 16px; font-size: 15px; color: ' + MUTED78 + ';', text: (state.scanStep || 'Leser kvitteringen med AI …') + ' Dette tar vanligvis noen sekunder.' }),
        h('div', { style: 'height: 4px; background: var(--color-accent-200); overflow: hidden;' }, [h('div', { style: 'height: 100%; width: 38%; background: var(--color-accent); animation: mlbar 1.15s ease-in-out infinite;' })])
      ]));
    } else if (state.scanPhase === 'review') {
      var controls = h('div', { style: 'display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end;' }, [
        h('label', { style: 'display: flex; flex-direction: column; gap: 6px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;' }, [
          'Butikk',
          h('select', { cls: 'input', 'data-focus-id': 'scan-store', style: 'min-height: 38px; min-width: 180px;', value: state.scanStore, onChange: function (e) {
            setState({ scanStore: e.target.value });
          } }, ALL_STORES.map(function (s) { return h('option', { value: s.name, selected: s.name === state.scanStore ? 'selected' : false, text: s.name }); }))
        ]),
        h('label', { style: 'display: flex; flex-direction: column; gap: 6px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;' }, [
          'Dato',
          h('input', { cls: 'input', type: 'date', 'data-focus-id': 'scan-date', style: 'min-height: 38px; min-width: 160px;', value: state.scanDate || '', max: new Date().toISOString().slice(0, 10), onInput: function (e) { setState({ scanDate: e.target.value }); } })
        ])
      ]);
      // The lines stand exactly as the scanner read them off the receipt. A
      // contributor can drop one that was misread, but not rewrite its name or
      // its price: an editable field makes every price in the leksikon only as
      // trustworthy as whoever typed last, and a single absurd number is enough
      // to wreck a product's history. Removal is the whole correction budget.
      var rows = h('div', { style: 'display: flex; flex-direction: column; gap: 10px;' }, state.scanItems.map(function (it, i) {
        var hint = (it.unit && it.quantity) ? (String(it.quantity).replace('.', ',') + ' ' + it.unit + ' · pris per ' + it.unit + (it.lineTotal ? ' (betalt ' + nf(Number(it.lineTotal)) + ')' : '')) : null;
        var raw = String(it.price == null ? '' : it.price).replace(',', '.').trim();
        var priceNum = raw === '' ? NaN : Number(raw);
        var name = it.name || 'Uten navn';
        return h('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }, [
          h('div', { style: 'display: grid; grid-template-columns: 1fr auto 38px; gap: 10px; align-items: baseline;' }, [
            h('span', { style: 'font-size: 15px; line-height: 22px; overflow-wrap: anywhere;', text: name }),
            h('span', { style: "font-size: 15px; line-height: 22px; text-align: right; font-feature-settings: 'tnum' 1;", text: isFinite(priceNum) ? nf(priceNum) : '—' }),
            h('button', { type: 'button', cls: 'btn btn-ghost btn-icon', 'aria-label': 'Fjern ' + name + ' fra kvitteringen', title: 'Fjern varelinjen', 'data-focus-id': 'scan-remove-' + i, style: 'min-height: 38px;', onClick: function () { setState({ scanItems: state.scanItems.filter(function (x, j) { return j !== i; }) }); }, text: '✕' })
          ]),
          hint ? h('span', { style: 'font-size: 12px; color: ' + MUTED60 + '; padding-left: 2px;', text: hint }) : null
        ]);
      }));
      var empty = !state.scanItems.length;
      var actions = h('div', { style: 'display: flex; gap: 10px; align-items: center; flex-wrap: wrap;' }, [
        h('button', { type: 'button', cls: 'btn btn-primary', onClick: submitScan, disabled: (state.scanSubmitting || empty) ? 'disabled' : false, text: state.scanSubmitting ? 'Lagrer …' : (empty ? 'Ingen varelinjer igjen' : 'Legg til ' + state.scanItems.length + ' priser i databasen') }),
        h('button', { type: 'button', cls: 'btn btn-ghost', onClick: resetScan, text: 'Forkast' }),
        state.scanError ? h('span', { style: 'font-size: 13px; color: var(--color-accent-800);', text: state.scanError }) : null
      ]);
      body = h('div', { style: 'max-width: 820px;' }, [
        h('span', { style: KICKER, text: 'Se over varelinjene' }),
        h('hr', { style: RULE }),
        state.scanNote ? h('p', { style: 'margin: 0 0 4px; font-size: 14px; line-height: 20px; color: ' + MUTED70 + ';', text: state.scanNote }) : null,
        h('p', { style: 'margin: 0 0 16px; font-size: 14px; line-height: 20px; color: ' + MUTED70 + ';', text: 'Navn og pris kommer fra kvitteringen og kan ikke endres — det holder prisene ekte. Er en linje feillest, fjerner du den med ✕.' }),
        h('div', { cls: 'blueprint', style: 'padding: 24px; display: flex; flex-direction: column; gap: 16px;' }, corners().concat([controls, rows, actions]))
      ]);
    } else if (state.scanPhase === 'done') {
      var dd = state.scanDate ? (state.scanDate.slice(8, 10) + '.' + state.scanDate.slice(5, 7) + '.' + state.scanDate.slice(0, 4)) : '';
      var doneMsg = (state.doneMsgN || state.scanItems.length) + ' priser registrert hos ' + state.scanStore + (dd ? ' (' + dd + ')' : '') + '.';
      // Link the contributed lines to the products they already match in the
      // leksikon, so a contributor can jump straight to what they registered.
      var matched = [], mseen = {};
      (state.scanItems || []).forEach(function (it) {
        if (!it || !it.name) return;
        var k = ckey(it.name), g = GROUP_BY_KEY[k];
        if (g && !mseen[k]) { mseen[k] = 1; matched.push(g); }
      });
      var matchBlock = matched.length ? h('div', { style: 'margin-top: 22px;' }, [
        h('span', { style: 'display: block; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: ' + MUTED60 + '; margin-bottom: 10px;', text: 'Se varene i leksikonet' }),
        h('div', { style: 'display: flex; flex-wrap: wrap; gap: 8px;' }, matched.slice(0, 8).map(function (g) {
          return h('button', Object.assign({ type: 'button', cls: 'btn btn-secondary', style: 'min-height: 32px; padding: 4px 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em;' }, activate(openGroup(g.key), 'Åpne ' + g.name + ' i leksikonet')), g.name);
        }))
      ]) : null;
      body = h('div', { cls: 'blueprint', style: 'max-width: 560px; padding: 28px;' }, corners().concat([
        h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 26px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Takk for bidraget' }),
        h('p', { style: 'margin: 12px 0 0; font-size: 15px; line-height: 22px;', text: doneMsg + ' Prisene er lagret i databasen og dukker opp i leksikonet etter neste oppdatering.' }),
        matchBlock,
        h('div', { style: 'display: flex; gap: 10px; margin-top: 24px;' }, [
          h('button', { type: 'button', cls: 'btn btn-primary', onClick: nav('home'), text: 'Til leksikonet' }),
          h('button', { type: 'button', cls: 'btn btn-ghost', onClick: resetScan, text: 'Skann en ny kvittering' })
        ])
      ]));
    }
    return h('section', { 'data-screen-label': 'Skann kvittering' }, [head, body]);
  }

  // ── Handleliste: saved products + per-store basket comparison ─────────────
  // Resolve the saved entries against today's catalogue. An entry names a
  // product *and* the size the shopper picked, so every price below — the row,
  // the per-store sum, the "billigst" tag — is that size, not whatever pack
  // happens to be cheapest.
  function listItems() {
    var out = [], gone = 0;
    state.list.forEach(function (e) {
      var p = parseEntry(e), g = GROUP_BY_KEY[p.key];
      if (!g) { gone++; return; }
      var variants = bestPerStore(g, p.size);
      if (!variants.length) { gone++; return; }
      var first = variants[0];
      out.push({
        id: p.id, key: p.key, size: p.size, sizeLabel: sizeLabel(p.size), qty: p.qty, g: g, name: g.name,
        variants: variants, minPrice: variants.reduce(function (m, v) { return Math.min(m, v.price); }, Infinity),
        unitPrice: first.perUnit != null ? first.perUnit : null, unitDim: first.perUnit != null ? first.unitDim : null,
        storeCount: variants.length
      });
    });
    return { items: out, gone: gone };
  }

  // The basket over time — one line per chain, the same thing section 02
  // totals, just on every measurement date instead of today.
  //
  // A line is a real basket: only that chain's own recorded prices, only the
  // points recorded for the pack size the entry is pinned to, and only dates
  // where the chain has a price for *every* item. Summing across chains, or
  // across sizes, produces a number nobody can shop at — which is what the
  // single "cheapest per item" line used to show, well below the per-store
  // totals right above it.
  //
  // A chain that never has the whole list is left out rather than drawn on a
  // partial basket, since a missing item reads as a price drop. Prices carry
  // forward from a chain's last observation of an item until it's seen again.
  function listStoreSeries(items, histBy, stores) {
    var loading = false, dates = {}, noSize = [], scaledStores = {};
    // item → store → date → price
    var perItem = (items || []).map(function (it) {
      var rows = (histBy || {})[it.key];
      if (rows === 'loading' || rows == null) { loading = true; return null; }
      // Two passes per store. Exact-size measurements are the truth and are
      // used alone when a store has any — a week where only another pack was
      // recorded then carries the last real price forward rather than jumping
      // to a different pack's. Only a store that never once recorded this size
      // falls back to scaling, which is the difference between a line that
      // wobbles and a chain that is absent from the chart entirely.
      var exact = {}, approx = {}, matched = 0;
      (rows || []).forEach(function (r) {
        if (!r || !r.observed_at) return;
        var at = priceAtSize(r, it.size);
        if (!at) return;
        matched++;
        var into = at.scaled ? approx : exact;
        var m = into[r.store_id] || (into[r.store_id] = {});
        if (m[r.observed_at] == null || at.price < m[r.observed_at].price) m[r.observed_at] = at;
      });
      var byStore = {};
      Object.keys(exact).forEach(function (st) { byStore[st] = exact[st]; });
      Object.keys(approx).forEach(function (st) {
        if (byStore[st]) return;                       // a real measurement wins
        byStore[st] = approx[st];
        if (STORE_NAME[st]) scaledStores[STORE_NAME[st]] = 1;
      });
      Object.keys(byStore).forEach(function (st) {
        Object.keys(byStore[st]).forEach(function (d) { dates[d] = 1; });
      });
      if (!matched && (rows || []).length) noSize.push(it.name);
      return byStore;
    });
    if (loading) return { series: [], loading: true, incomplete: [], noSize: [], scaled: [] };

    var all = Object.keys(dates).sort();
    var series = [], incomplete = [];
    (stores || []).forEach(function (s) {
      var last = items.map(function () { return null; }), pts = [];
      all.forEach(function (d) {
        var sum = 0, have = 0;
        perItem.forEach(function (byStore, i) {
          var m = byStore && byStore[s.id];
          if (m && m[d] != null) last[i] = m[d];
          // Each item counts as many times as the shopper wants it.
          if (last[i] != null) { sum += last[i].price * (items[i].qty || 1); have++; }
        });
        if (have === items.length && items.length) pts.push({ date: d, value: Math.round(sum * 100) / 100 });
      });
      if (pts.length) series.push({ id: s.id, name: s.name, color: s.color || 'var(--color-accent)', dash: s.dash || '', points: pts });
      else incomplete.push(s.name);
    });
    return { series: series, loading: false, incomplete: incomplete, noSize: noSize, scaled: Object.keys(scaledStores) };
  }

  // − N + on a list row. A plain number input would be fewer elements, but the
  // list is used one-handed in a shop, so the two targets are the point.
  function qtyStepper(it) {
    var btn = function (label, to, aria, enabled) {
      return h('button', {
        type: 'button', 'aria-label': aria, title: aria, disabled: enabled ? false : 'disabled',
        style: 'width: 28px; height: 28px; padding: 0; font-size: 15px; line-height: 1; border: 1px solid var(--color-divider); background: transparent;'
          + ' color: ' + (enabled ? 'var(--color-text)' : MUTED60) + '; cursor: ' + (enabled ? 'pointer' : 'default') + ';',
        onClick: function (e) { e.stopPropagation(); if (enabled) setEntryQty(it, to); }
      }, label);
    };
    return h('span', {
      style: 'display: inline-flex; align-items: center; gap: 6px;',
      role: 'group', 'aria-label': 'Antall ' + it.name
    }, [
      btn('−', it.qty - 1, 'Én mindre ' + it.name, it.qty > 1),
      h('span', {
        style: "min-width: 1.6em; text-align: center; font-feature-settings: 'tnum' 1; font-weight: 600; font-size: 15px;",
        'aria-live': 'polite', text: String(it.qty)
      }),
      btn('+', it.qty + 1, 'Én mer ' + it.name, it.qty < MAX_QTY)
    ]);
  }

  function renderList() {
    var resolved = listItems(), items = resolved.items, missing = resolved.gone;
    var count = state.list.length;

    // "Del liste": copy a URL that encodes the current list.
    var shareBtn = count ? h('button', { type: 'button', cls: 'btn btn-secondary', style: 'margin-top: 20px;', onClick: function () {
      var url = listShareUrl();
      var mark = function () { state.listShareCopied = true; render(); setTimeout(function () { state.listShareCopied = false; render(); }, 2000); };
      try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(mark, mark); else mark(); } catch (e) { mark(); }
    }, text: state.listShareCopied ? '✓ Delingslenke kopiert' : '↗ Del liste' }) : null;

    var head = h('div', { style: 'padding: 56px 0 24px;' }, [
      h('h1', { style: H1, text: 'Handlelisten din' }),
      h('p', { style: 'margin: 16px 0 0; max-width: 60ch; font-size: 16px; line-height: 24px; color: ' + MUTED70 + ';', text: count ? 'Varene du har stjernemerket, i din rekkefølge, og hva hele lista koster i hver butikk. Lagret lokalt i nettleseren din — del den med en lenke.' : 'Stjernemerk varer i leksikonet, så samler de seg her — og du ser hvilken butikk som er billigst for hele lista.' }),
      shareBtn
    ]);

    // A shared list opened via #/liste?d=… : preview + import (never clobbers
    // the visitor's own list silently).
    var sharedBanner = null;
    if (state.sharedList && state.sharedList.length) {
      var sentries = state.sharedList.map(function (k) { return parseEntry(k); });
      var sNames = sentries.map(function (p) { var g = GROUP_BY_KEY[p.key]; return g ? g.name + (p.size !== 'alle' ? ' (' + sizeLabel(p.size) + ')' : '') : null; }).filter(Boolean);
      var newCount = sentries.filter(function (p) { return state.list.indexOf(p.id) < 0; }).length;
      var importShared = function () {
        sentries.forEach(function (p) { if (state.list.indexOf(p.id) < 0) state.list.push(p.id); });
        saveList(); state.sharedList = null; go('#/liste'); window.scrollTo(0, 0);
      };
      var dismissShared = function () { state.sharedList = null; go('#/liste'); };
      sharedBanner = h('div', { cls: 'blueprint', style: 'padding: 20px 22px; margin-bottom: 32px; display: flex; flex-direction: column; gap: 12px; background: color-mix(in srgb, var(--color-accent) 5%, transparent);' }, corners().concat([
        h('span', { style: KICKER + ' margin-bottom: 0;', text: 'Delt handleliste' }),
        h('p', { style: 'margin: 0; font-size: 15px; line-height: 22px;', text: 'Noen har delt en handleliste med ' + sentries.length + (sentries.length === 1 ? ' vare' : ' varer') + (sNames.length ? ': ' + sNames.slice(0, 10).join(', ') + (sNames.length > 10 ? ' m.fl.' : '') + '.' : '.') }),
        h('div', { style: 'display: flex; gap: 10px; flex-wrap: wrap;' }, [
          h('button', { type: 'button', cls: 'btn btn-primary', onClick: importShared, text: newCount ? 'Legg til i handlelisten (' + newCount + ' nye)' : 'Alt ligger allerede i lista di' }),
          h('button', { type: 'button', cls: 'btn btn-ghost', onClick: dismissShared, text: 'Lukk' })
        ])
      ]));
    }

    if (!count) {
      return h('section', { 'data-screen-label': 'Handleliste' }, [head, sharedBanner,
        h('div', { style: 'margin-top: 8px;' }, [
          h('a', { href: '#/', onClick: nav('home'), cls: 'btn btn-primary', text: 'Til leksikonet' })
        ])
      ]);
    }

    // Per-store totals: for each store, sum its price for every listed item it
    // carries in the chosen size, and count coverage. `lines` keeps the
    // products behind the sum and `missing` names what the store doesn't
    // carry, so an expanded row explains both halves of "har N av M".
    var totals = {};
    STORES.forEach(function (s) { totals[s.name] = { name: s.name, sum: 0, have: 0, id: s.id, lines: [], missing: [] }; });
    items.forEach(function (it) {
      var seen = {}, qty = it.qty || 1;
      it.variants.forEach(function (v) {
        var t = totals[v.storeName];
        if (!t) return;
        seen[v.storeName] = 1;
        // What the basket costs, so a quantity has to count that many times.
        t.sum += v.price * qty; t.have += 1;
        t.lines.push({ key: it.key, name: it.name, sizeLabel: it.sizeLabel, size: it.size, qty: qty, price: v.price, perUnit: v.perUnit, unitDim: v.unitDim, isOffer: v.isOffer, best: it.storeCount > 1 && v.price <= it.minPrice });
      });
      STORES.forEach(function (s) { if (!seen[s.name] && totals[s.name]) totals[s.name].missing.push(it.name); });
    });
    var cheapestTotal = items.reduce(function (m, it) { return m + it.minPrice * (it.qty || 1); }, 0);
    var storeRanks = Object.keys(totals).map(function (n) { return totals[n]; })
      .filter(function (t) { return t.have > 0; })
      .sort(function (a, b) { return (b.have - a.have) || (a.sum - b.sum); });

    // Price view for the list: kilo-/literpris (jamførpris) or pack price, and
    // an option to hide the items that carry no comparable price at all. The
    // order is the shopper's own — drag the rows — so there is no sort here.
    var listKilo = state.listPriceMode !== 'enhet';
    var noUnit = items.filter(function (it) { return it.unitPrice == null; }).length;
    var visible = state.listOnlyUnit ? items.filter(function (it) { return it.unitPrice != null; }) : items;

    var LPMODES = [['kilo', 'Per kg/l'], ['enhet', 'Enhetspris']];
    var listPriceModeControl = h('label', { style: 'display: flex; align-items: center; gap: 8px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: ' + MUTED70 + '; white-space: nowrap;' }, [
      'Vis pris',
      h('div', { role: 'group', 'aria-label': 'Vis pris per', style: 'display: inline-flex; border: 1px solid var(--color-divider);' }, LPMODES.map(function (o, idx) {
        var on = listKilo === (o[0] === 'kilo');
        return h('button', { type: 'button', 'aria-pressed': on ? 'true' : 'false', onClick: function () { setState({ listPriceMode: o[0] }); }, style: 'min-height: 34px; padding: 4px 12px; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; cursor: pointer; border: 0;' + (idx > 0 ? ' border-left: 1px solid var(--color-divider);' : '') + (on ? ' background: var(--color-accent); color: var(--color-bg);' : ' background: transparent; color: var(--color-text);'), text: o[1] });
      }))
    ]);
    var onlyUnitControl = noUnit ? h('button', { type: 'button', cls: 'btn ' + (state.listOnlyUnit ? 'btn-primary' : 'btn-ghost'), 'aria-pressed': state.listOnlyUnit ? 'true' : 'false', onClick: function () { setState({ listOnlyUnit: !state.listOnlyUnit }); }, style: 'min-height: 34px; padding: 4px 14px; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase;', text: 'Bare med kg/l-pris' }) : null;
    var listControls = h('div', { style: 'display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: center; justify-content: space-between; margin-bottom: 20px;' }, [
      onlyUnitControl || h('span', {}),
      listPriceModeControl
    ]);

    var itemRows = visible.map(function (it, idx) {
      var best = it.variants[0];
      var hasUnit = it.unitPrice != null;
      var priceTxt = nf(it.minPrice) + (hasUnit ? ' · ' + nfUnit(it.unitPrice, it.unitDim) : '');
      var whereTxt = it.storeCount > 1 ? 'billigst hos ' + best.storeName + ' · ' + it.storeCount + ' butikker' : best.storeName;
      // The size is its own control: tap it to swap pack size without losing
      // the item's place in the list.
      var sizeBtn = h('button', {
        type: 'button', cls: 'btn btn-ghost',
        'aria-label': 'Endre størrelse for ' + it.name + ', nå ' + it.sizeLabel.toLowerCase(),
        title: 'Endre størrelse',
        style: 'min-height: 22px; padding: 0 6px; font-size: 12px; letter-spacing: 0.02em; color: var(--color-accent-700);',
        onClick: editEntrySize(it)
      }, (it.size === 'alle' ? 'alle størrelser' : it.sizeLabel) + ' ▾');
      // In kg/l view the jamførpris leads and the pack price sits beneath; an
      // item without one says so rather than showing a bare pack price that
      // looks comparable but isn't.
      var lead = (listKilo && hasUnit) ? nfUnit(it.unitPrice, it.unitDim) : nf(it.minPrice);
      var sub = (listKilo && hasUnit) ? nf(it.minPrice) : (hasUnit ? nfUnit(it.unitPrice, it.unitDim) : (listKilo ? 'ingen kg/l-pris' : ''));
      return h('div', { 'data-lid': it.id, cls: 'row-hover', style: 'display: grid; grid-template-columns: auto auto 1fr auto auto; gap: 10px; align-items: center; padding: 12px 16px 12px 8px; border-bottom: 1px solid color-mix(in srgb, var(--color-text) 8%, transparent);' }, [
        dragHandle(it, idx, visible.length),
        h('button', { type: 'button', cls: 'btn btn-ghost', 'aria-label': 'Fjern ' + it.name + ' fra handlelisten', title: 'Fjern fra handlelisten', style: 'width: 34px; height: 34px; padding: 0; font-size: 16px; color: var(--color-accent-700);', onClick: function () { removeFromList(it.key); render(); }, text: '★' }),
        // The name opens the product; the size button below it is its own
        // control, so it sits outside the clickable name rather than nested in
        // it (a button inside a button is neither clickable nor announceable).
        h('span', { style: 'display: block; min-width: 0;' }, [
          h('span', Object.assign({ style: 'cursor: pointer; display: block;' }, activate(openGroup(it.key), it.name + ', ' + it.sizeLabel + ', ' + priceTxt)), [
            h('span', { style: NAME_STYLE, text: it.name })
          ]),
          h('span', { style: 'display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; font-size: 13px; color: ' + MUTED60 + ';' }, [
            sizeBtn, h('span', { text: '· ' + whereTxt })
          ])
        ]),
        qtyStepper(it),
        h('span', { style: 'display: flex; flex-direction: column; align-items: flex-end; gap: 2px;' }, [
          h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 20px; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: lead }),
          sub ? h('span', { style: 'font-size: 12px; color: ' + MUTED60 + "; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: sub }) : null,
          // The line total only earns its space once it differs from the unit
          // price above it.
          it.qty > 1 ? h('span', { style: 'font-size: 12px; font-weight: 600; color: var(--color-accent-700);' + " font-feature-settings: 'tnum' 1; white-space: nowrap;", text: it.qty + ' × = ' + nf(it.minPrice * it.qty) }) : null
        ])
      ]);
    });

    var hiddenNote = (state.listOnlyUnit && noUnit)
      ? noUnit + (noUnit === 1 ? ' vare uten' : ' varer uten') + ' kg-/literpris er skjult (pakningen oppgir ingen mengde). De teller fortsatt med i butikksummene under.'
      : '';
    var listBlock = h('div', {}, [
      h('span', { style: KICKER, text: '01 · Varene dine (' + items.length + ')' }),
      h('hr', { style: RULE }),
      listControls,
      h('div', { cls: 'blueprint', style: 'padding: 0;' }, corners().concat(itemRows.length ? itemRows : [
        h('p', { style: 'margin: 0; padding: 20px; font-size: 14px; color: ' + MUTED60 + ';', text: 'Ingen av varene i lista har en kg-/literpris. Slå av filteret for å se dem.' })
      ])),
      h('p', { style: 'margin: 16px 0 0; font-size: 13px; color: ' + MUTED60 + ';', text: 'Dra i ⠿ for å legge lista i den rekkefølgen du går gjennom butikken — rekkefølgen lagres. Piltastene flytter også, når håndtaket har fokus.' }),
      hiddenNote ? h('p', { style: 'margin: 8px 0 0; font-size: 13px; color: ' + MUTED60 + ';', text: hiddenNote }) : null,
      missing ? h('p', { style: 'margin: 8px 0 0; font-size: 13px; color: ' + MUTED60 + ';', text: missing + (missing === 1 ? ' vare' : ' varer') + ' i lista finnes ikke i leksikonet i valgt størrelse akkurat nå (kan ha gått ut av sortimentet) og telles ikke med.' }) : null
    ]);

    // Each store row opens to show what makes up its sum — the listed products
    // at that store's own price — plus what it doesn't carry, which is the
    // other half of "har N av M".
    var compRows = storeRanks.map(function (t, i) {
      var full = t.have === items.length;
      var open = state.listOpenStore === t.id;
      var toggle = function () { setState({ listOpenStore: open ? null : t.id }); };
      var headRow = h('div', Object.assign({
        cls: 'row-hover',
        style: 'display: grid; grid-template-columns: auto 1fr auto auto; gap: 12px; align-items: center; padding: 14px 20px; cursor: pointer;',
        'aria-expanded': open ? 'true' : 'false'
      }, activate(toggle, (open ? 'Skjul' : 'Vis') + ' varene ' + t.name + ' fører, ' + nf(t.sum) + ' for ' + t.have + ' av ' + items.length)), [
        h('span', { 'aria-hidden': 'true', style: 'font-size: 12px; color: ' + MUTED60 + '; width: 12px; display: inline-block;' + (open ? ' transform: rotate(90deg);' : ''), text: '▶' }),
        h('span', { style: 'display: flex; align-items: center; gap: 12px;' }, [
          storeLine((STORE_STYLE[t.id] || {}).color || 'var(--color-accent)', (STORE_STYLE[t.id] || {}).dash || '', 18),
          h('span', { style: NAME_STYLE, text: t.name })
        ]),
        h('span', { cls: 'tag ' + (full ? 'tag-accent' : 'tag-neutral'), text: 'har ' + t.have + ' av ' + items.length }),
        h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 22px; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: nf(t.sum) })
      ]);

      var panel = null;
      if (open) {
        var lines = t.lines.map(function (ln) {
          var hasUnit = ln.perUnit != null;
          var lead = (listKilo && hasUnit) ? nfUnit(ln.perUnit, ln.unitDim) : nf(ln.price);
          var sub = (listKilo && hasUnit) ? nf(ln.price) : (hasUnit ? nfUnit(ln.perUnit, ln.unitDim) : '');
          return h('div', { cls: 'row-hover', style: 'display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: center; padding: 9px 20px 9px 44px;' }, [
            h('span', Object.assign({ style: 'cursor: pointer; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;' }, activate(openGroup(ln.key), 'Åpne ' + ln.name + ' i leksikonet')), [
              h('span', { style: 'font-size: 14px;', text: ln.name }),
              ln.size !== 'alle' ? h('span', { style: 'font-size: 12px; color: ' + MUTED60 + ';', text: ln.sizeLabel }) : null,
              ln.best ? h('span', { cls: 'tag tag-accent', style: 'font-size: 10px;', text: 'billigst' }) : null,
              ln.isOffer ? h('span', { cls: 'tag tag-outline', style: 'font-size: 10px;', text: 'tilbud' }) : null
            ]),
            h('span', { style: 'display: flex; flex-direction: column; align-items: flex-end;' }, [
              h('span', { style: "font-size: 15px; font-weight: 600; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: lead }),
              sub ? h('span', { style: 'font-size: 12px; color: ' + MUTED60 + "; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: sub }) : null
            ])
          ]);
        });
        if (t.missing.length) {
          lines.push(h('p', { style: 'margin: 0; padding: 10px 20px 12px 44px; font-size: 13px; line-height: 20px; color: ' + MUTED60 + ';', text: 'Fører ikke: ' + t.missing.join(', ') + '.' }));
        }
        panel = h('div', { style: 'border-top: 1px dashed color-mix(in srgb, var(--color-text) 12%, transparent); padding: 4px 0 2px; background: color-mix(in srgb, var(--color-text) 3%, transparent);' }, lines);
      }

      return h('div', { style: 'border-bottom: 1px solid color-mix(in srgb, var(--color-text) 8%, transparent);' + (i === 0 ? ' background: color-mix(in srgb, var(--color-accent) 6%, transparent);' : '') }, [headRow, panel]);
    });

    var compBlock = h('div', { style: 'margin-top: 40px;' }, [
      h('span', { style: KICKER, text: '02 · Hva lista koster per butikk' }),
      h('hr', { style: RULE }),
      h('div', { cls: 'blueprint', style: 'padding: 0;' }, corners().concat(compRows)),
      h('p', { style: 'margin: 16px 0 0; font-size: 13px; color: ' + MUTED60 + ';', text: 'Trykk på en butikk for å se varene og prisene bak summen. Summen gjelder bare varene hver butikk faktisk fører (se «har N av ' + items.length + '»), så en lav sum kan bety at butikken mangler varer. Handler du hver vare der den er billigst, lander lista på ' + nf(cheapestTotal) + '.' })
    ]);

    // ── 03 · Handleliste prishistorikk ────────────────────────────────────
    // One line per chain — the same basket section 02 prices today, on every
    // measurement date. Nothing is summed across chains or across sizes.
    var ts = listStoreSeries(items, state.listHistory, STORES);
    var dTxt = function (d) { return d.slice(8, 10) + '.' + d.slice(5, 7) + '.' + d.slice(0, 4); };
    var histBody;
    if (ts.loading) {
      histBody = h('p', { style: 'font-size: 15px; color: ' + MUTED70 + ';', text: 'Laster prishistorikk for lista …' });
    } else if (!ts.series.length) {
      histBody = h('p', { style: 'font-size: 15px; line-height: 22px; color: ' + MUTED70 + ';', text: ts.noSize.length
        ? 'Ingen målepunkter i valgt størrelse for ' + ts.noSize.slice(0, 3).join(', ') + (ts.noSize.length > 3 ? ' m.fl.' : '') + '. Hver uke lagres bare den billigste pakningen per butikk, så en bestemt størrelse mangler de ukene den ikke var billigst — sett varen til «alle størrelser» for å ta med alt.'
        : 'Ingen butikk har ennå en registrert pris på alle ' + items.length + ' varene på samme dato. Historikken bygges opp uke for uke, så kurvene kommer når hele lista har vært prissatt samtidig hos én kjede.' });
    } else {
      // Headline: the cheapest complete basket at its own last measurement.
      var best = ts.series.map(function (s) { return { s: s, last: s.points[s.points.length - 1], first: s.points[0] }; })
        .sort(function (a, b) { return a.last.value - b.last.value; })[0];
      var diff = best.last.value - best.first.value;
      var c = chartFrom(ts.series);
      var caption = 'Hva hele lista ville kostet i hver kjede på hver måledato — kjedens egne registrerte priser, i størrelsen du har valgt per vare. '
        + 'Bare datoer der kjeden har en registrert pris på alle ' + items.length + ' varene er med, og en pris føres videre til den måles på nytt. '
        + (ts.incomplete.length ? ts.incomplete.join(', ') + (ts.incomplete.length === 1 ? ' er utelatt — den har' : ' er utelatt — de har') + ' ikke hatt hele lista registrert på én dato. ' : '')
        // A scaled line is arithmetic on a real measurement, not a price the
        // chain ever charged — so it must never pass for one.
        + (ts.scaled.length ? 'For ' + ts.scaled.join(', ') + ' er prisen regnet om fra en annen pakningsstørrelse (bare den billigste pakningen lagres per butikk per dag), så ' + (ts.scaled.length === 1 ? 'den linja' : 'de linjene') + ' er et anslag. ' : '')
        + 'Siste punkt er siste måling, ikke nødvendigvis dagens pris i seksjon 02.';
      histBody = h('div', {}, [
        h('div', { style: 'display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: baseline; margin-bottom: 16px;' }, [
          h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 30px; font-feature-settings: 'tnum' 1;", text: nf(best.last.value) }),
          h('span', { style: 'font-size: 14px; color: ' + MUTED70 + ';', text: 'billigst hos ' + best.s.name }),
          h('span', { style: 'font-size: 14px; color: ' + (Math.abs(diff) < 0.005 ? MUTED70 : (diff > 0 ? 'var(--color-accent-900)' : 'var(--color-accent-700)')) + ';', text: (Math.abs(diff) < 0.005 ? 'uendret' : (diff > 0 ? '+' : '−') + nf(Math.abs(diff))) + ' siden ' + dTxt(best.first.date) }),
          h('span', { style: 'font-size: 13px; color: ' + MUTED60 + ';', text: 'målt ' + dTxt(best.last.date) }),
          // An estimated line can beat a measured one purely because the pack
          // it was scaled from is dearer per litre, so the "cheapest" claim
          // must not be read as this week's answer — that's section 02's job.
          ts.scaled.length ? h('span', { style: 'font-size: 13px; color: var(--color-accent-700);', text: '· inneholder anslag — se 02 for dagens priser' }) : null
        ]),
        chartBlock(c, null, caption, 'Prishistorikk for handlelisten, per butikk')
      ]);
    }
    var histBlock = h('div', { style: 'margin-top: 40px;' }, [
      h('span', { style: KICKER, text: '03 · Handleliste prishistorikk' }),
      h('hr', { style: RULE }),
      histBody
    ]);

    return h('section', { 'data-screen-label': 'Handleliste' }, [head, sharedBanner, listBlock, compBlock, histBlock]);
  }

  // ── Om / kilder / personvern ─────────────────────────────────────────────
  function aboutSection(kicker, num, children) {
    return h('div', { style: 'margin-top: 40px;' }, [
      h('span', { style: KICKER, text: num + ' · ' + kicker }), h('hr', { style: RULE })
    ].concat(children));
  }
  function bullet(strongTxt, rest) {
    // `rest` may be a string or an array of nodes/strings — flatten it so h()
    // never receives a nested array as a single child (appendChild needs a Node).
    var kids = [strongTxt ? h('strong', { text: strongTxt + ' ' }) : null];
    kids = kids.concat(Array.isArray(rest) ? rest : [rest]);
    return h('li', { style: 'margin: 0 0 10px; font-size: 15px; line-height: 23px;' }, kids);
  }

  function renderAbout() {
    var P = 'margin: 0 0 12px; font-size: 15px; line-height: 23px; max-width: 68ch;';
    var UL = 'margin: 0; padding-left: 20px; max-width: 68ch;';
    var head = h('div', { style: 'padding: 56px 0 8px;' }, [
      h('h1', { style: H1, text: 'Om Prisboka' }),
      h('p', { style: 'margin: 16px 0 0; max-width: 68ch; font-size: 16px; line-height: 24px; color: ' + MUTED70 + ';', text: 'Et matvareleksikon med ekte priser fra norske dagligvarekjeder — og hvor prisen er på vei. Gratis, uten konto.' })
    ]);

    var what = aboutSection('Hva er dette', '01', [
      h('p', { style: P }, ['Prisboka samler priser på matvarer fra ', h('strong', { text: storeListText() }), ' på ett sted, så du kan sammenligne før du handler. Søk opp en vare, se hva den koster i hver butikk, hvilken pakning som er billigst per kilo/liter, og hvordan prisen har beveget seg.']),
      h('p', { style: P + ' color: ' + MUTED70 + ';', text: 'Prisboka er et uavhengig hobbyprosjekt og er ikke tilknyttet, eid av eller godkjent av noen av kjedene.' })
    ]);

    var sources = aboutSection('Kilder', '02', [
      h('p', { style: P, text: 'Prisene hentes automatisk hver uke, og suppleres med priser fellesskapet bidrar med:' }),
      h('ul', { style: UL }, [
        bullet('Tilbudsaviser', '— ukens tilbud fra kjedenes egne tilbudsaviser.'),
        bullet('Kvitteringsskann', '— priser fellesskapet bidrar med fra kvitteringene sine, merket «Skannet» i prishistorikken.')
      ]),
      h('p', { style: 'margin: 14px 0 0; font-size: 14px; line-height: 22px; color: ' + MUTED60 + '; max-width: 68ch;', text: 'En butikk vises først når den har nok priser til at en sammenligning betyr noe — noen kjeder samles inn, men ligger foreløpig under grensen. Coop-kjedene (Extra, Prix, Mega, Obs) mangler helt fordi Coop ikke publiserer hyllepriser noe sted — de finnes bare i ukens kundeavis. Skanner du en kvittering derfra, blir prisene lagret og teller mot grensen, så kjeden dukker opp av seg selv når den er stor nok.' }),
      h('p', { style: 'margin: 14px 0 0; font-size: 14px; line-height: 22px; color: ' + MUTED60 + '; max-width: 68ch;', text: 'Prisene kan være unøyaktige eller utdaterte, og kan variere mellom butikker i samme kjede. Sjekk alltid prisen i butikken før du handler.' })
    ]);

    var privacy = aboutSection('Personvern', '03', [
      h('ul', { style: UL }, [
        bullet('Ingen konto og ingen sporing.', 'Vi bruker ikke informasjonskapsler for annonser eller analyse, og selger ikke data.'),
        bullet('Handlelisten din', 'lagres bare lokalt i nettleseren din (localStorage) — den sendes aldri til oss. En delt liste ligger kun i lenken du selv deler.'),
        bullet('Kvitteringsskanning:', 'bildet sendes til Google Gemini for tekstgjenkjenning og lagres ikke hos oss. IP-adressen din lagres midlertidig for å hindre misbruk (rate-limiting).'),
        bullet('Priser du bidrar med', 'blir en del av det offentlige leksikonet. Ikke skann kvitteringer med personlig informasjon du ikke vil dele — ta bare med varelinjene.')
      ])
    ]);

    var contact = aboutSection('Kontakt', '04', [
      h('p', { style: P }, [
        'Feil pris, en vare som er gruppert rart, eller noe annet som skurrer — send en e-post til ',
        h('a', { href: 'mailto:' + SUPPORT_EMAIL, text: SUPPORT_EMAIL }),
        '. Prisboka er et hobbyprosjekt, så svaret kan ta noen dager.'
      ]),
      h('p', { style: 'margin: 14px 0 0; font-size: 14px; line-height: 22px; color: ' + MUTED60 + '; max-width: 68ch;' }, [
        'Produktbildene er hentet fra kjedenes egne bildetjenester og kan være beskyttet av opphavsrett. Er du rettighetshaver og vil ha et bilde fjernet, si fra på samme adresse, så tar vi det ned.'
      ])
    ]);

    return h('section', { 'data-screen-label': 'Om' }, [head, what, sources, privacy, contact]);
  }

  // Site footer — attribution + links, on every screen.
  function renderFooter() {
    var sep = function () { return h('span', { style: 'color: ' + MUTED60 + ';', text: ' · ' }); };
    return h('footer', { style: 'border-top: 1px solid var(--color-divider); margin-top: 24px;' }, [
      h('div', { style: 'max-width: 1160px; margin: 0 auto; padding: 28px 24px 48px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: baseline; justify-content: space-between; font-size: 13px; color: ' + MUTED70 + ';' }, [
        h('span', { style: 'display: flex; flex-wrap: wrap; gap: 4px; align-items: baseline;' }, [
          h('a', { href: '#/om', onClick: nav('om'), text: 'Om' }), sep(),
          h('a', { href: '#/om', onClick: nav('om'), text: 'Kilder' }), sep(),
          h('a', { href: '#/om', onClick: nav('om'), text: 'Personvern' }), sep(),
          h('a', { href: 'mailto:' + SUPPORT_EMAIL, text: 'Kontakt' })
        ]),
        h('span', { style: 'color: ' + MUTED60 + '; max-width: 62ch;', text: 'Ekte priser fra ' + storeListText() + '. Uavhengig prosjekt — ikke tilknyttet kjedene. Sjekk prisen i butikk.' })
      ])
    ]);
  }

  // ── Shells ───────────────────────────────────────────────────────────────
  function centeredCard(children) {
    return h('div', { style: 'max-width: 1160px; margin: 0 auto; padding: 96px 24px;' }, [
      h('div', { cls: 'blueprint', style: 'max-width: 520px; padding: 28px;' }, corners().concat(children))
    ]);
  }
  function loadingScreen() {
    var frag = document.createDocumentFragment();
    frag.appendChild(renderNav());
    frag.appendChild(centeredCard([
      h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 22px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Laster leksikonet …' }),
      h('p', { style: 'margin: 10px 0 0; font-size: 15px; color: ' + MUTED70 + ';', text: 'Henter ekte priser fra tilbudsavisene.' })
    ]));
    return frag;
  }
  function errorScreen() {
    var frag = document.createDocumentFragment();
    frag.appendChild(renderNav());
    frag.appendChild(centeredCard([
      h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 22px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Kunne ikke laste leksikonet' }),
      h('p', { style: 'margin: 10px 0 16px; font-size: 15px; color: ' + MUTED70 + ';', text: 'Vi fikk ikke kontakt med databasen. Sjekk nettforbindelsen og prøv igjen.' }),
      h('button', { type: 'button', cls: 'btn btn-primary', onClick: function () { setState({ phase: 'loading' }); boot(); }, text: 'Prøv igjen' })
    ]));
    return frag;
  }

  // ── Render + focus preservation ──────────────────────────────────────────
  function captureFocus() {
    var a = document.activeElement;
    if (!a || !a.dataset || !a.dataset.focusId) return null;
    var info = { id: a.dataset.focusId };
    try { info.start = a.selectionStart; info.end = a.selectionEnd; } catch (e) { /* number/select */ }
    return info;
  }
  function restoreFocus(info) {
    if (!info) return;
    var el = document.querySelector('[data-focus-id="' + info.id + '"]');
    if (!el) return;
    el.focus();
    if (info.start != null) { try { el.setSelectionRange(info.start, info.end); } catch (e) { /* noop */ } }
  }

  var root = typeof document !== 'undefined' ? document.getElementById('app') : null;

  // Last-resort crash screen, built with raw DOM (no hyperscript / app helpers,
  // since one of those may be what threw) so it can't fail the same way.
  function renderCrash() {
    var wrap = document.createElement('div');
    wrap.setAttribute('style', 'max-width: 560px; margin: 0 auto; padding: 96px 24px; font-family: sans-serif;');
    var hd = document.createElement('h1');
    hd.textContent = 'Noe gikk galt';
    hd.setAttribute('style', 'font-size: 28px; margin: 0 0 12px; text-transform: uppercase;');
    var p = document.createElement('p');
    p.textContent = 'Vi klarte ikke å vise denne siden akkurat nå. Last siden på nytt — kommer feilen tilbake, prøv igjen om litt.';
    p.setAttribute('style', 'margin: 0 0 20px; line-height: 1.5; font-size: 15px;');
    var btn = document.createElement('button');
    btn.textContent = 'Last på nytt';
    btn.setAttribute('style', 'cursor: pointer; font: inherit; font-size: 14px; padding: 8px 16px; border: 1px solid #416180; background: #5980a6; color: #f2f2f3;');
    btn.addEventListener('click', function () { try { location.reload(); } catch (e) { /* noop */ } });
    wrap.appendChild(hd); wrap.appendChild(p); wrap.appendChild(btn);
    return wrap;
  }

  function renderInner() {
    var frag = document.createDocumentFragment();
    frag.appendChild(renderNav());
    var container = h('div', { style: 'max-width: 1160px; margin: 0 auto; padding: 0 24px 96px;' });
    if (state.view === 'gruppe') container.appendChild(renderGroup());
    else if (state.view === 'vare') container.appendChild(renderVariant());
    else if (state.view === 'scan') container.appendChild(renderScan());
    else if (state.view === 'liste') container.appendChild(renderList());
    else if (state.view === 'om') container.appendChild(renderAbout());
    else container.appendChild(renderHome());
    frag.appendChild(container);
    frag.appendChild(renderFooter());
    var picker = state.sizePicker ? sizePickerOverlay() : null;
    if (picker) {
      frag.appendChild(picker);
      // Move focus into the dialog once it's in the document.
      setTimeout(function () { var el = document.querySelector('[role="dialog"] button'); if (el) el.focus(); }, 0);
    }
    return frag;
  }

  // Any exception while building a screen used to blank the whole app (render
  // clears #app first, then threw), leaving a white page. Guard it: on failure
  // show a recoverable crash screen instead of nothing.
  function render() {
    if (dragging) return; // a rebuild mid-drag would yank the rows away
    var focus = captureFocus();
    try {
      root.textContent = '';
      if (state.phase === 'loading') { root.appendChild(loadingScreen()); return; }
      if (state.phase === 'error') { root.appendChild(errorScreen()); return; }
      root.appendChild(renderInner());
      restoreFocus(focus);
    } catch (e) {
      if (typeof console !== 'undefined' && console.error) console.error('render failed:', e);
      try { root.textContent = ''; root.appendChild(renderCrash()); } catch (e2) { /* leave the DOM as-is */ }
    }
    // The screen just built queued the photos it needs; fetch them in one round
    // trip. Outside the try so a crashed render still can't wedge the loader,
    // and safe to re-enter: once a group is asked for it is never queued again,
    // so the render this triggers on arrival flushes nothing.
    flushImages();
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  // PostgREST caps a response at 1000 rows, so page through all offers.
  // ml_catalog is the view that defines this payload: ml_offers minus the
  // columns the client never reads, and minus image_url — the photos were 29 %
  // of the bytes and are fetched per screen instead (see the image loader).
  // has_image survives so the frame can be reserved before the URL lands.
  var OFFER_SRC = '/ml_catalog';
  // group_key is deliberately absent: it is derived from product_name by
  // mlGroupKey() rather than shipped, which is 372 kB (31 %) off this payload.
  var OFFER_COLS = 'store_id,product_name,price,pre_price,unit,unit_price,unit_price_unit,offer_days,valid_until,has_image';
  var OFFER_PAGE = 1000;
  // How many offer pages are in flight at once. The catalogue is ~50 pages, and
  // fetching them one after another meant ~50 *serialised* round trips before
  // anything could paint — pure latency, seconds of it on mobile. A handful of
  // lanes fills the connection without hammering the API.
  var OFFER_LANES = 6;

  function offersPage(offset, opts) {
    return sb(OFFER_SRC + '?select=' + OFFER_COLS + '&order=external_id&limit=' + OFFER_PAGE + '&offset=' + offset, opts)
      .then(function (r) { if (!r.ok) throw new Error('offers ' + r.status); return r; });
  }

  // Row count from PostgREST's Content-Range ("0-999/49584"), which it only
  // sends when asked with `Prefer: count=exact`. Null when the header is
  // missing or unparseable — then we page the old serial way instead.
  function totalFromRange(res) {
    var h = (res.headers && typeof res.headers.get === 'function') ? res.headers.get('Content-Range') : null;
    var m = h && /\/(\d+)\s*$/.exec(h);
    var n = m ? Number(m[1]) : NaN;
    return isFinite(n) ? n : null;
  }

  // Serial fallback: keep asking for the next page until a short one comes back.
  function pageOffersFrom(all, offset) {
    return offersPage(offset).then(function (r) { return r.json(); }).then(function (rows) {
      rows = rows || [];
      pushAll(all, rows);
      if (rows.length < OFFER_PAGE) return all;
      return pageOffersFrom(all, offset + OFFER_PAGE);
    });
  }

  function pushAll(dst, src) { for (var i = 0; i < src.length; i++) dst.push(src[i]); return dst; }

  // Run thunks `lanes` at a time, preserving result order. Rejects on the first
  // failure — a half-downloaded catalogue is not one we want to show.
  function pooled(jobs, lanes) {
    return new Promise(function (resolve, reject) {
      var out = new Array(jobs.length), next = 0, done = 0, failed = false;
      if (!jobs.length) { resolve(out); return; }
      function start() {
        if (failed || next >= jobs.length) return;
        var i = next++;
        jobs[i]().then(function (v) {
          if (failed) return;
          out[i] = v;
          if (++done === jobs.length) resolve(out); else start();
        }, function (e) { if (!failed) { failed = true; reject(e); } });
      }
      for (var k = 0; k < lanes && k < jobs.length; k++) start();
    });
  }

  function fetchAllOffers() {
    // The first page doubles as the count probe, so knowing the total costs no
    // extra round trip. Everything after it goes out in parallel.
    return offersPage(0, { headers: { Prefer: 'count=exact' } }).then(function (res) {
      var total = totalFromRange(res);
      return res.json().then(function (first) {
        var all = pushAll([], first || []);
        if (all.length < OFFER_PAGE) return all;
        if (total == null) return pageOffersFrom(all, OFFER_PAGE);

        var jobs = [];
        for (var off = OFFER_PAGE; off < total; off += OFFER_PAGE) {
          jobs.push(function (o) {
            return function () { return offersPage(o).then(function (r) { return r.json(); }); };
          }(off));
        }
        return pooled(jobs, OFFER_LANES).then(function (pages) {
          var last = null;
          for (var i = 0; i < pages.length; i++) { last = pages[i] || []; pushAll(all, last); }
          // Rows can be appended between the count and the last page. If the
          // final page came back full there may be more behind it — mop up.
          if (last && last.length === OFFER_PAGE) return pageOffersFrom(all, OFFER_PAGE * (pages.length + 1));
          return all;
        });
      });
    });
  }

  // ── Cold-start cache (Cache API blob + localStorage meta) ────────────────
  // The catalogue is ~6 MB, so re-downloading it on every visit is slow on
  // mobile and burns Supabase egress. It's cached in the Cache Storage API
  // (the big offers blob — no ~5 MB localStorage cap) with a small meta record
  // in localStorage (timestamp, the tiny stores list, freshness stamp).
  //   • Within CATALOG_TTL a return visit trusts the cache and makes ZERO
  //     network calls — instant paint, no egress. (Data refreshes weekly, so a
  //     few hours stale is fine.)
  //   • An older cache still paints instantly, then revalidates in the
  //     background (stale-while-revalidate).
  //   • No Cache API (insecure context) → always revalidate, as before.
  var CATALOG_TTL = 12 * 60 * 60 * 1000; // 12 h
  // v3: the snapshot's row shape changed with ml_catalog (image_url out,
  // has_image in). A v2 snapshot would restore rows whose has_image is
  // undefined, i.e. a leksikon with every photo silently missing, so it must not
  // be reused — hence new names rather than a migration.
  var CAT_CACHE = 'prisboka-catalog-v3';
  var CAT_OFFERS_URL = '/__prisboka-offers-cache-v3'; // synthetic same-origin Cache key (never fetched)
  var CAT_META_KEY = 'prisboka_catalog_meta_v4';
  var hasCaches = (typeof caches !== 'undefined' && caches && typeof caches.open === 'function');

  // Retire superseded caches: the old localStorage blob, and the previous
  // snapshot generations. The service worker deliberately leaves every
  // 'prisboka-catalog-*' alone, so nothing else would ever reclaim the ~6 MB an
  // outdated snapshot holds.
  try {
    localStorage.removeItem('prisboka_catalog_v1');
    localStorage.removeItem('prisboka_catalog_meta');
    localStorage.removeItem('prisboka_catalog_meta_v2');
    localStorage.removeItem('prisboka_catalog_meta_v3');
  } catch (e) { /* noop */ }
  if (hasCaches) {
    try {
      caches.keys().then(function (keys) {
        keys.forEach(function (k) {
          if (k.indexOf('prisboka-catalog-') === 0 && k !== CAT_CACHE) caches.delete(k);
        });
      }).catch(function () { /* best-effort */ });
    } catch (e) { /* noop */ }
  }

  function readCatMeta() { try { return JSON.parse(localStorage.getItem(CAT_META_KEY) || 'null'); } catch (e) { return null; } }
  function writeCatMeta(o) { try { localStorage.setItem(CAT_META_KEY, JSON.stringify(o)); } catch (e) { /* best-effort */ } }
  function readCachedOffers() {
    return new Promise(function (resolve) {
      if (!hasCaches) { resolve(null); return; }
      caches.open(CAT_CACHE).then(function (c) { return c.match(CAT_OFFERS_URL); }).then(function (res) {
        if (!res) { resolve(null); return; }
        res.json().then(function (a) { resolve(Array.isArray(a) && a.length ? a : null); }, function () { resolve(null); });
      }).catch(function () { resolve(null); });
    });
  }
  function writeCachedOffers(offers) {
    if (!hasCaches) return;
    try {
      caches.open(CAT_CACHE).then(function (c) {
        c.put(CAT_OFFERS_URL, new Response(JSON.stringify(offers), { headers: { 'Content-Type': 'application/json' } }));
      }).catch(function () { /* quota — best-effort */ });
    } catch (e) { /* noop */ }
  }

  function applyCatalog(stores, offers) {
    var covered = coveredStores(offers);
    // Fail open: if nothing clears the bar (a half-written catalogue, or a
    // future where every chain is small), show everything rather than nothing.
    var narrow = Object.keys(covered).length > 0;
    buildStores(stores, narrow ? covered : null);
    buildGroups(narrow ? (offers || []).filter(function (o) { return o && covered[o.store_id]; }) : offers);
    state.phase = 'ready';
  }
  function loadFreshnessStamp() {
    // Latest recorded price point for the top bar. Loaded separately so it
    // never blocks or fails the catalogue boot.
    sb('/ml_price_history?select=observed_at&order=observed_at.desc&limit=1')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        if (rows && rows[0] && rows[0].observed_at) {
          state.lastUpdated = rows[0].observed_at;
          var m = readCatMeta() || {}; m.lastUpdated = state.lastUpdated; writeCatMeta(m);
          if (state.phase === 'ready') render();
        }
      })
      .catch(function () { /* keep the "ukentlig" fallback */ });
  }
  function revalidate() {
    Promise.all([
      sb('/ml_stores?select=*&order=sort_order').then(function (r) { if (!r.ok) throw new Error('stores ' + r.status); return r.json(); }),
      fetchAllOffers()
    ]).then(function (out) {
      var stores = out[0], offers = out[1];
      // A transient empty result must not blank out a good cached catalogue.
      if ((!offers || !offers.length) && state.phase === 'ready') return;
      applyCatalog(stores, offers);
      state.fromCache = false;
      writeCachedOffers(offers);
      writeCatMeta({ ts: Date.now(), stores: stores, lastUpdated: state.lastUpdated || (readCatMeta() || {}).lastUpdated || '' });
      route();
      loadFreshnessStamp();
    }).catch(function (e) {
      // Network failed. If we already painted from cache, keep it (offline);
      // otherwise there is nothing to show, so surface the error.
      if (state.phase === 'ready') { loadFreshnessStamp(); return; }
      state.phase = 'error'; state.errMsg = (e && e.message) || String(e);
      render();
    });
  }
  function boot() {
    var meta = readCatMeta();
    readCachedOffers().then(function (offers) {
      if (offers && meta && Array.isArray(meta.stores) && meta.stores.length) {
        // Instant paint from cache — also makes the app usable offline.
        applyCatalog(meta.stores, offers);
        state.fromCache = true;
        state.lastUpdated = meta.lastUpdated || '';
        route();
        var age = Date.now() - (meta.ts || 0);
        if (age >= 0 && age < CATALOG_TTL) return; // fresh — trust cache, skip the network (no egress)
      }
      revalidate();
    });
  }

  // Browser bootstrap — skipped under Node (unit tests import the pure helpers
  // below without a DOM). Guarded on window/document so `require('./app.js')`
  // never touches browser globals.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    va('beforeSend', analyticsBeforeSend);
    window.addEventListener('hashchange', function () { route(); trackView(); });
    document.addEventListener('paste', function (e) {
      if (state.phase !== 'ready' || state.view !== 'scan' || state.scanPhase !== 'idle') return;
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          var f = items[i].getAsFile();
          if (f) { e.preventDefault(); onScanFile(f); return; }
        }
      }
    });

    // Offline service worker (progressive enhancement). Registered here rather
    // than inline in index.html so the Content-Security-Policy can keep
    // script-src at 'self' — no 'unsafe-inline', no per-edit hash to maintain.
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js').catch(function () { /* offline support is optional */ });
      });
    }

    render();
    // Reported before boot() rather than once the catalogue is ready: a visit
    // where the data never loads is still a visit, and is the one you would
    // most want to see in the dashboard.
    trackView();
    boot();
  }

  // Node/CommonJS: expose the pure price/grouping helpers for unit tests. This
  // is a no-op in the browser (no `module`), so it never affects the app.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      cleanName: cleanName, pctOff: pctOff, baseAmount: baseAmount, mlGroupKey: mlGroupKey,
      parseAmount: parseAmount, normUnit: normUnit, foldName: foldName,
      minceKey: minceKey, ckey: ckey, canonLabel: canonLabel,
      buildStores: buildStores, buildGroups: buildGroups, searchRank: searchRank,
      popularityOf: popularityOf, pickWeeklyOffers: pickWeeklyOffers,
      coveredStores: coveredStores, staleDaysFor: staleDaysFor,
      sizeIdOf: sizeIdOf, sizeLabel: sizeLabel, sizeOptions: sizeOptions, bestPerStore: bestPerStore,
      entryId: entryId, parseEntry: parseEntry, moveEntry: moveEntry, swapEntry: swapEntry,
      chartFrom: chartFrom, rowSizeId: rowSizeId, listStoreSeries: listStoreSeries
    };
  }
})();
