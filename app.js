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
  function sb(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }, opts.headers || {});
    return fetch(SUPABASE_URL + '/rest/v1' + path, opts);
  }

  // ── Data (populated at boot) ─────────────────────────────────────────────
  var STORES = [];                 // [{id,name,color,dash,places[]}]
  var STORE_NAME = {}, STORE_STYLE = {};
  var OFFERS = [];
  var GROUPS = [], GROUP_BY_KEY = {};
  var VALID_COUNT = 0;

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

  // Make a non-native clickable element keyboard-operable (Enter/Space) and
  // announced as a button. Merge the returned props into the element.
  function activate(handler, label) {
    return {
      role: 'button', tabindex: '0', 'aria-label': label || false, onClick: handler,
      onKeydown: function (e) { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); handler(e); } }
    };
  }

  function buildStores(rows) {
    STORES = (Array.isArray(rows) ? rows : [])
      .filter(function (s) { return s && s.id != null; })
      .map(function (s) { return { id: s.id, name: s.name || String(s.id), color: s.color, dash: s.dash || '', places: s.places || [] }; });
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
      rawName: o.product_name, name: cleanName(o.product_name), serverKey: o.group_key || ckey(o.product_name),
      price: price, prePrice: o.pre_price != null ? Number(o.pre_price) : null,
      unit: o.unit || null, image: o.image_url || null, validUntil: o.valid_until || null,
      offerDays: o.offer_days || null,
      isOffer: o.pre_price != null && Number(o.pre_price) > price,
      unitDim: unitDim, perUnit: perUnit
    };
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
      var img = null; for (var i = 0; i < variants.length; i++) { if (variants[i].image) { img = variants[i].image; break; } }
      // Cheapest unit price across the group (variants are sorted unit-price
      // first, so variants[0] carries it when any variant has one).
      var cheapUnit = (variants[0] && variants[0].perUnit != null) ? variants[0].perUnit : null;
      var cheapUnitDim = cheapUnit != null ? variants[0].unitDim : null;
      return {
        key: key, name: canonLabel(key) || (variants[0] ? variants[0].name : key), variants: variants, image: img,
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
  // Stored as the client group keys (stable, derived from the product name),
  // so a saved list survives reloads and re-ingested data.
  var LIST_KEY = 'prisboka_liste';
  function loadList() {
    try {
      var a = JSON.parse(localStorage.getItem(LIST_KEY) || '[]');
      var m = {}; if (Array.isArray(a)) a.forEach(function (k) { if (k) m[k] = 1; });
      return m;
    } catch (e) { return {}; }
  }
  function saveList() { try { localStorage.setItem(LIST_KEY, JSON.stringify(Object.keys(state.list))); } catch (e) { /* private mode / quota */ } }
  function inList(k) { return !!state.list[k]; }
  function listCount() { return Object.keys(state.list).length; }
  function toggleList(k) { if (state.list[k]) delete state.list[k]; else state.list[k] = 1; saveList(); render(); }
  // A shareable list URL encodes the group keys after the hash (keys are folded
  // to [a-z0-9 ], so '~' is a safe separator) — no account, no server.
  function listShareUrl() {
    return location.href.replace(/#.*$/, '') + '#/liste?d=' + encodeURIComponent(Object.keys(state.list).join('~'));
  }

  // ── State ────────────────────────────────────────────────────────────────
  var state = {
    phase: 'loading', errMsg: '',
    view: 'home', groupKey: null, storeId: null, query: '', storeFilter: 'Alle', sort: 'relevans', priceMode: 'kilo',
    scanPhase: 'idle', scanStep: '', scanItems: [], scanStore: 'Kiwi', scanDate: '',
    scanSubmitting: false, scanError: null, scanImageUrl: null, scanNote: null,
    doneCount: 0, doneMsgN: 0,
    list: {}, copiedFor: null, lastUpdated: '', fromCache: false, sharedList: null, listShareCopied: false,
    history: {} // key -> 'loading' | [rows]
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
      setState({ scanPhase: 'review', scanItems: [{ name: '', price: '' }], scanNote: 'Filen ser ikke ut som et bilde. Skriv inn varelinjene manuelt.', scanError: null });
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
          setState({ scanPhase: 'review', scanItems: [{ name: '', price: '' }], scanNote: null, scanError: (r.body && r.body.error) || 'Kunne ikke lese kvitteringen. Prøv igjen eller skriv inn manuelt.' });
          return;
        }
        var data = r.body || {};
        var items = (data.items || []).map(function (it) {
          return { name: it.name || '', price: (it.price != null ? String(it.price) : ''), unit: it.unit || null, quantity: (it.quantity != null ? it.quantity : null), lineTotal: (it.lineTotal != null ? it.lineTotal : null) };
        });
        var patch = { scanPhase: 'review', scanError: null };
        patch.scanDate = (data.purchaseDate && /^\d{4}-\d{2}-\d{2}$/.test(data.purchaseDate)) ? data.purchaseDate : new Date().toISOString().slice(0, 10);
        if (data.store) patch.scanStore = data.store;
        if (items.length) {
          patch.scanItems = items;
          patch.scanNote = 'Fant ' + items.length + ' varelinjer' + (data.storeName ? ' fra ' + data.storeName : '') + '. Kontroller dem før du lagrer.';
        } else {
          patch.scanItems = [{ name: '', price: '' }];
          patch.scanNote = 'Fant ingen varelinjer på bildet — skriv dem inn manuelt, eller prøv et tydeligere bilde av hele kvitteringen.';
        }
        setState(patch);
      })
      .catch(function () {
        setState({ scanPhase: 'review', scanItems: [{ name: '', price: '' }], scanError: 'Kunne ikke lese bildet nå. Sjekk nettforbindelsen og prøv igjen, eller skriv inn manuelt.' });
      });
  }
  function addScanRow() { setState({ scanItems: state.scanItems.concat([{ name: '', price: '' }]) }); }
  function resetScan() {
    if (state.scanImageUrl) URL.revokeObjectURL(state.scanImageUrl);
    setState({ scanPhase: 'idle', scanItems: [], scanImageUrl: null, scanNote: null, scanError: null });
  }
  function submitScan() {
    if (state.scanSubmitting || !state.scanItems.length) return;
    var storeObj = STORES.filter(function (x) { return x.name === state.scanStore; })[0];
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
  function imgBox(src, alt, height) {
    return src ? h('div', { style: 'height: ' + height + '; background: #fff; display: flex; align-items: center; justify-content: center; overflow: hidden; border-bottom: 1px solid var(--color-divider);' }, [
      h('img', { src: src, alt: alt, loading: 'lazy', style: 'max-width: 90%; max-height: 100%; object-fit: contain; mix-blend-mode: multiply;' })
    ]) : null;
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
      state.view = 'gruppe'; state.groupKey = r.groupKey;
    } else if (r.view === 'vare') {
      if (!GROUP_BY_KEY[r.groupKey]) { location.hash = '#/'; return; }
      state.view = 'vare'; state.groupKey = r.groupKey; state.storeId = r.storeId;
      loadHistory(GROUP_BY_KEY[r.groupKey]);
    } else if (r.view === 'scan') {
      state.view = 'scan';
    } else if (r.view === 'liste') {
      state.view = 'liste';
      state.sharedList = (r.shared && r.shared.length) ? r.shared : null;
    } else if (r.view === 'om') {
      state.view = 'om';
    } else {
      state.view = 'home';
    }
    render();
  }
  var HASH_FOR = { home: '#/', scan: '#/skann', liste: '#/liste', om: '#/om' };
  function go(hash) { if (location.hash === hash || (hash === '#/' && !location.hash)) route(); else location.hash = hash; }
  function nav(view) { return function (e) { if (e && e.preventDefault) e.preventDefault(); go(HASH_FOR[view] || '#/'); window.scrollTo(0, 0); }; }
  function openGroup(key) { return function () { go('#/gruppe/' + encodeURIComponent(key)); window.scrollTo(0, 0); }; }
  function openVariant(key, store) { return function () { go('#/vare/' + encodeURIComponent(key) + '/' + encodeURIComponent(store)); window.scrollTo(0, 0); }; }

  function loadHistory(g) {
    if (!g) return;
    var key = g.key;
    if (state.history[key]) return;
    state.history[key] = 'loading';
    // History rows are keyed by the servers' own group_key; a client group may
    // merge several of them, so fetch by the set of server keys it contains.
    var keys = (g.serverKeys && g.serverKeys.length) ? g.serverKeys : [key];
    var inList = keys.map(function (k) { return '"' + String(k).replace(/"/g, '') + '"'; }).join(',');
    sb('/ml_price_history?select=store_id,price,pre_price,is_offer,observed_at,source&group_key=in.(' + encodeURIComponent(inList) + ')&order=observed_at.asc')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) { state.history[key] = rows || []; if (state.view === 'vare' && state.groupKey === key) render(); })
      .catch(function () { state.history[key] = []; if (state.view === 'vare') render(); });
  }

  // ── Shared style bits ────────────────────────────────────────────────────
  var MUTED60 = 'color-mix(in srgb, var(--color-text) 60%, transparent)';
  var MUTED70 = 'color-mix(in srgb, var(--color-text) 70%, transparent)';
  var MUTED78 = 'color-mix(in srgb, var(--color-text) 78%, transparent)';
  var KICKER = 'display: block; font-size: 13px; line-height: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: var(--color-accent-700); margin-bottom: 12px;';
  var RULE = 'height: 1px; border: 0; margin: 0 0 24px; background: var(--color-divider);';
  var NAME_STYLE = 'font-family: var(--font-heading); font-weight: 600; font-size: 18px; letter-spacing: 0.02em; text-transform: uppercase;';
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

  function renderNav() {
    return h('nav', { cls: 'nav', 'data-screen-label': 'Topplinje', style: 'padding-inline: max(24px, calc((100% - 1160px) / 2 + 24px));' }, [
      h('span', Object.assign({ cls: 'nav-brand', style: 'cursor: pointer;', text: 'Prisboka' }, activate(nav('home'), 'Prisboka — til forsiden'))),
      h('a', { href: '#/', onClick: nav('home'), text: 'Leksikon' }),
      h('a', { href: '#/liste', onClick: nav('liste'), text: 'Handleliste' + (listCount() ? ' (' + listCount() + ')' : '') }),
      h('a', { href: '#/skann', onClick: nav('scan'), text: 'Bidra med priser' }),
      h('a', { href: '#/om', onClick: nav('om'), text: 'Om' }),
      h('span', { style: 'flex: 1;' }),
      h('span', { style: 'font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; color: ' + MUTED70 + "; font-feature-settings: 'tnum' 1;", text: VALID_COUNT + ' ekte priser · ' + (state.lastUpdated ? 'sist oppdatert ' + dateDM(state.lastUpdated) : 'oppdatert ukentlig') }),
      h('button', { type: 'button', cls: 'btn btn-primary', onClick: nav('scan'), text: 'Skann kvittering' })
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
    var CAP = 150;
    var shown = filtered.slice(0, CAP);

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

    // Ukas beste tilbud
    var offers = [];
    GROUPS.forEach(function (g) { g.variants.forEach(function (v) { if (v.isOffer) offers.push({ g: g, v: v }); }); });
    offers.sort(function (a, b) { return pctOff(b.v) - pctOff(a.v); });
    var bestSection = null;
    if (!q && offers.length) {
      bestSection = h('div', { style: 'padding-bottom: 48px;' }, [
        h('span', { style: KICKER, text: '01 · Ukas beste tilbud' }),
        h('hr', { style: RULE }),
        h('div', { style: 'display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 28px;' }, offers.slice(0, 8).map(function (o) {
          var v = o.v;
          return h('div', Object.assign({ cls: 'blueprint card-hover', style: 'padding: 0; cursor: pointer; display: flex; flex-direction: column;' }, activate(openGroup(o.g.key), o.g.name + ', tilbud hos ' + v.storeName + ', ' + nf(v.price))), corners().concat([
            cardStar(o.g.key),
            imgBox(v.image, v.name, '150px'),
            h('div', { style: 'padding: 14px 16px; display: flex; flex-direction: column; gap: 6px;' }, [
              h('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px;' + (v.image ? '' : ' padding-right: 32px;') }, [
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
        imgBox(g.image, g.name, '150px'),
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
      g.image ? h('div', { cls: 'blueprint', style: 'flex: none; width: 190px; height: 190px; background: #fff; display: flex; align-items: center; justify-content: center; overflow: hidden;' }, corners().concat([
        h('img', { src: g.image, alt: g.name, style: 'max-width: 82%; max-height: 82%; object-fit: contain; mix-blend-mode: multiply;' })
      ])) : null
    ]);

    var rows = g.variants.map(function (v) {
      var vu = v.validUntil ? 'Gyldig til ' + v.validUntil.slice(8, 10) + '.' + v.validUntil.slice(5, 7) : '';
      var vd = v.offerDays ? 'Gjelder ' + v.offerDays : '';
      var nSizes = sizesFor(g, v.storeId).length;
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
      h('div', { cls: 'blueprint', style: 'padding: 0;' }, corners().concat(rows)),
      h('p', { style: 'margin: 16px 0 0; font-size: 13px; color: ' + MUTED60 + ';', text: 'Prisene sammenlignes per liter/kilo. Trykk på en butikk for å se størrelsene den har og prishistorikken.' })
    ]);

    return h('section', { 'data-screen-label': 'Produktgruppe' }, [head, table]);
  }

  // ── Variant page: price history ──────────────────────────────────────────
  function historyChart(rows) {
    var pl = 46, pr = 14, pt = 14, pb = 24, W = 760, H = 260;
    var dates = [], seen = {};
    rows.forEach(function (r) { if (!seen[r.observed_at]) { seen[r.observed_at] = 1; dates.push(r.observed_at); } });
    dates.sort();
    var di = {}; dates.forEach(function (d, i) { di[d] = i; });
    var lo = Infinity, hi = -Infinity;
    rows.forEach(function (r) { var p = Number(r.price); if (p < lo) lo = p; if (p > hi) hi = p; });
    var pad = (hi - lo) * 0.15 || 2; lo -= pad; hi += pad;
    var n = dates.length;
    var x = function (i) { return n <= 1 ? (pl + (W - pl - pr) / 2) : pl + (i / (n - 1)) * (W - pl - pr); };
    var y = function (v) { return pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb); };
    var byStore = {}; rows.forEach(function (r) { (byStore[r.store_id] || (byStore[r.store_id] = [])).push(r); });
    var lines = Object.keys(byStore).map(function (s) {
      var pts = byStore[s].slice().sort(function (a, b) { return a.observed_at < b.observed_at ? -1 : 1; });
      var poly = pts.map(function (r) { return x(di[r.observed_at]).toFixed(1) + ',' + y(Number(r.price)).toFixed(1); });
      var last = pts[pts.length - 1];
      return { store: s, storeName: STORE_NAME[s] || s, color: (STORE_STYLE[s] || {}).color || 'var(--color-accent)', dash: (STORE_STYLE[s] || {}).dash || '', points: poly.join(' '), lastX: x(di[last.observed_at]).toFixed(1), lastY: y(Number(last.price)).toFixed(1) };
    });
    var grid = []; for (var i = 0; i < 4; i++) { var gv = lo + (i / 3) * (hi - lo), gy = y(gv); grid.push({ y: gy.toFixed(1), ty: (gy + 3.5).toFixed(1), label: Math.round(gv) + ' kr' }); }
    var ticks = dates.map(function (d, i) { return { x: x(i).toFixed(1), label: d.slice(8, 10) + '.' + d.slice(5, 7) }; });
    return { W: W, H: H, lines: lines, grid: grid, ticks: ticks, single: n <= 1 };
  }

  function renderVariant() {
    var g = GROUP_BY_KEY[state.groupKey];
    if (!g) return notFoundView('Denne varen finnes ikke i leksikonet lenger — den kan ha gått ut av ukas sortiment. Søk den opp på nytt fra forsiden.');
    var v = g.variants.filter(function (x) { return x.storeId === state.storeId; })[0] || g.variants[0];

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
      g.image ? h('div', { cls: 'blueprint', style: 'flex: none; width: 190px; height: 190px; background: #fff; display: flex; align-items: center; justify-content: center; overflow: hidden;' }, corners().concat([
        h('img', { src: v.image || g.image, alt: v.name, style: 'max-width: 82%; max-height: 82%; object-fit: contain; mix-blend-mode: multiply;' })
      ])) : null
    ]);

    var hist = state.history[g.key];
    var chartBlock;
    if (hist === 'loading' || hist == null) {
      chartBlock = h('p', { style: 'font-size: 15px; color: ' + MUTED70 + ';', text: 'Laster prishistorikk …' });
    } else if (!hist.length) {
      chartBlock = h('p', { style: 'font-size: 15px; color: ' + MUTED70 + ';', text: 'Ingen prishistorikk ennå. Den bygges opp fra uke til uke.' });
    } else {
      var c = historyChart(hist);
      var legend = c.lines.map(function (l) {
        return h('span', { style: 'display: inline-flex; align-items: center; gap: 8px; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; opacity: ' + (l.store === v.storeId ? '1' : '0.55') + ';' }, [storeLine(l.color, l.dash, 26), l.storeName]);
      });
      var kids = [];
      c.grid.forEach(function (gl) {
        kids.push(h('line', { x1: '46', x2: '748', y1: gl.y, y2: gl.y, stroke: 'var(--color-divider)', 'stroke-width': '1' }));
        kids.push(h('text', { x: '40', y: gl.ty, 'text-anchor': 'end', 'font-size': '11', fill: MUTED60, 'font-family': 'var(--font-body)', text: gl.label }));
      });
      c.ticks.forEach(function (t) { kids.push(h('text', { x: t.x, y: String(c.H - 6), 'text-anchor': 'middle', 'font-size': '11', fill: MUTED60, 'font-family': 'var(--font-body)', text: t.label })); });
      c.lines.forEach(function (l) {
        var emph = l.store === v.storeId;
        kids.push(h('polyline', { points: l.points, fill: 'none', stroke: l.color, 'stroke-width': emph ? '2.8' : '1.6', 'stroke-dasharray': l.dash, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: emph ? '1' : '0.5' }));
        kids.push(h('circle', { cx: l.lastX, cy: l.lastY, r: emph ? '4' : '3', fill: l.color, opacity: emph ? '1' : '0.5' }));
      });
      var svg = h('svg', { viewBox: '0 0 ' + c.W + ' ' + c.H, style: 'width: 100%; height: auto; display: block;', role: 'img', 'aria-label': 'Prishistorikk' }, kids);
      chartBlock = h('div', { cls: 'blueprint', style: 'padding: 24px;' }, corners().concat([
        h('div', { style: 'display: flex; flex-wrap: wrap; gap: 20px; margin-bottom: 16px;' }, legend),
        svg,
        h('p', { style: 'margin: 16px 0 0; font-size: 13px; color: ' + MUTED60 + ';', text: c.single ? 'Ett målepunkt så langt — prishistorikken bygges opp hver uke fra tilbudsavisene.' : 'Ukentlige målepunkter fra tilbudsavisene.' })
      ]));
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
    sections.push({ title: 'Prishistorikk', body: chartBlock });
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
      h('p', { style: 'margin: 16px 0 0; max-width: 60ch; font-size: 16px; line-height: 24px;', text: 'Bidra med ekte priser: last opp eller ta bilde av en kvittering. Vi leser varelinjene med AI, du kontrollerer dem, og prisene lagres.' })
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
      body = h('div', { style: 'max-width: 820px;' }, [dropZone]);
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
          } }, STORES.map(function (s) { return h('option', { value: s.name, selected: s.name === state.scanStore ? 'selected' : false, text: s.name }); }))
        ]),
        h('label', { style: 'display: flex; flex-direction: column; gap: 6px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;' }, [
          'Dato',
          h('input', { cls: 'input', type: 'date', 'data-focus-id': 'scan-date', style: 'min-height: 38px; min-width: 160px;', value: state.scanDate || '', max: new Date().toISOString().slice(0, 10), onInput: function (e) { setState({ scanDate: e.target.value }); } })
        ])
      ]);
      var rows = h('div', { style: 'display: flex; flex-direction: column; gap: 10px;' }, state.scanItems.map(function (it, i) {
        var hint = (it.unit && it.quantity) ? (String(it.quantity).replace('.', ',') + ' ' + it.unit + ' · pris per ' + it.unit + (it.lineTotal ? ' (betalt ' + nf(Number(it.lineTotal)) + ')' : '')) : null;
        return h('div', { style: 'display: flex; flex-direction: column; gap: 4px;' }, [
          h('div', { style: 'display: grid; grid-template-columns: 1fr 120px 38px; gap: 10px; align-items: center;' }, [
            h('input', { cls: 'input', 'aria-label': 'Varenavn', 'data-focus-id': 'scan-name-' + i, style: 'min-height: 38px;', value: it.name, onInput: function (e) { var items = state.scanItems.slice(); items[i] = Object.assign({}, items[i], { name: e.target.value }); setState({ scanItems: items }); } }),
            h('input', { cls: 'input', type: 'number', step: '0.1', 'aria-label': 'Pris i kroner', 'data-focus-id': 'scan-price-' + i, style: "min-height: 38px; text-align: right; font-feature-settings: 'tnum' 1;", value: it.price, onInput: function (e) { var items = state.scanItems.slice(); items[i] = Object.assign({}, items[i], { price: e.target.value }); setState({ scanItems: items }); } }),
            h('button', { type: 'button', cls: 'btn btn-ghost btn-icon', 'aria-label': 'Fjern varelinje', style: 'min-height: 38px;', onClick: function () { setState({ scanItems: state.scanItems.filter(function (x, j) { return j !== i; }) }); }, text: '✕' })
          ]),
          hint ? h('span', { style: 'font-size: 12px; color: ' + MUTED60 + '; padding-left: 2px;', text: hint }) : null
        ]);
      }));
      var addRowBtn = h('button', { type: 'button', cls: 'btn btn-ghost', onClick: addScanRow, style: 'align-self: flex-start;', text: '+ Legg til varelinje' });
      var actions = h('div', { style: 'display: flex; gap: 10px; align-items: center; flex-wrap: wrap;' }, [
        h('button', { type: 'button', cls: 'btn btn-primary', onClick: submitScan, disabled: state.scanSubmitting ? 'disabled' : false, text: state.scanSubmitting ? 'Lagrer …' : 'Legg til ' + state.scanItems.length + ' priser i databasen' }),
        h('button', { type: 'button', cls: 'btn btn-ghost', onClick: resetScan, text: 'Forkast' }),
        state.scanError ? h('span', { style: 'font-size: 13px; color: var(--color-accent-800);', text: state.scanError }) : null
      ]);
      body = h('div', { style: 'max-width: 820px;' }, [
        h('span', { style: KICKER, text: 'Kontroller varelinjene' }),
        h('hr', { style: RULE }),
        state.scanNote ? h('p', { style: 'margin: 0 0 16px; font-size: 14px; line-height: 20px; color: ' + MUTED70 + ';', text: state.scanNote }) : null,
        h('div', { cls: 'blueprint', style: 'padding: 24px; display: flex; flex-direction: column; gap: 16px;' }, corners().concat([controls, rows, addRowBtn, actions]))
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
  function renderList() {
    var keys = Object.keys(state.list);

    // "Del liste": copy a URL that encodes the current list.
    var shareBtn = keys.length ? h('button', { type: 'button', cls: 'btn btn-secondary', style: 'margin-top: 20px;', onClick: function () {
      var url = listShareUrl();
      var mark = function () { state.listShareCopied = true; render(); setTimeout(function () { state.listShareCopied = false; render(); }, 2000); };
      try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(mark, mark); else mark(); } catch (e) { mark(); }
    }, text: state.listShareCopied ? '✓ Delingslenke kopiert' : '↗ Del liste' }) : null;

    var head = h('div', { style: 'padding: 56px 0 24px;' }, [
      h('h1', { style: H1, text: 'Handlelisten din' }),
      h('p', { style: 'margin: 16px 0 0; max-width: 60ch; font-size: 16px; line-height: 24px; color: ' + MUTED70 + ';', text: keys.length ? 'Varene du har stjernemerket, og hva hele lista koster i hver butikk. Lagret lokalt i nettleseren din — del den med en lenke.' : 'Stjernemerk varer i leksikonet, så samler de seg her — og du ser hvilken butikk som er billigst for hele lista.' }),
      shareBtn
    ]);

    // A shared list opened via #/liste?d=… : preview + import (never clobbers
    // the visitor's own list silently).
    var sharedBanner = null;
    if (state.sharedList && state.sharedList.length) {
      var skeys = state.sharedList;
      var sNames = skeys.map(function (k) { var g = GROUP_BY_KEY[k]; return g ? g.name : null; }).filter(Boolean);
      var newCount = skeys.filter(function (k) { return !state.list[k]; }).length;
      var importShared = function () { skeys.forEach(function (k) { state.list[k] = 1; }); saveList(); state.sharedList = null; go('#/liste'); window.scrollTo(0, 0); };
      var dismissShared = function () { state.sharedList = null; go('#/liste'); };
      sharedBanner = h('div', { cls: 'blueprint', style: 'padding: 20px 22px; margin-bottom: 32px; display: flex; flex-direction: column; gap: 12px; background: color-mix(in srgb, var(--color-accent) 5%, transparent);' }, corners().concat([
        h('span', { style: KICKER + ' margin-bottom: 0;', text: 'Delt handleliste' }),
        h('p', { style: 'margin: 0; font-size: 15px; line-height: 22px;', text: 'Noen har delt en handleliste med ' + skeys.length + (skeys.length === 1 ? ' vare' : ' varer') + (sNames.length ? ': ' + sNames.slice(0, 10).join(', ') + (sNames.length > 10 ? ' m.fl.' : '') + '.' : '.') }),
        h('div', { style: 'display: flex; gap: 10px; flex-wrap: wrap;' }, [
          h('button', { type: 'button', cls: 'btn btn-primary', onClick: importShared, text: newCount ? 'Legg til i handlelisten (' + newCount + ' nye)' : 'Alt ligger allerede i lista di' }),
          h('button', { type: 'button', cls: 'btn btn-ghost', onClick: dismissShared, text: 'Lukk' })
        ])
      ]));
    }

    if (!keys.length) {
      return h('section', { 'data-screen-label': 'Handleliste' }, [head, sharedBanner,
        h('div', { style: 'margin-top: 8px;' }, [
          h('a', { href: '#/', onClick: nav('home'), cls: 'btn btn-primary', text: 'Til leksikonet' })
        ])
      ]);
    }

    // Resolve saved keys; some may no longer be in the catalogue.
    var items = [], missing = 0;
    keys.forEach(function (k) { var g = GROUP_BY_KEY[k]; if (g) items.push(g); else missing++; });

    // Per-store totals: for each store, sum the cheapest representative variant
    // of every listed item the store carries, and count coverage.
    var totals = {};
    STORES.forEach(function (s) { totals[s.name] = { name: s.name, sum: 0, have: 0, id: s.id }; });
    items.forEach(function (g) {
      g.variants.forEach(function (v) {
        var t = totals[v.storeName];
        if (t) { t.sum += v.price; t.have += 1; }
      });
    });
    var cheapestTotal = items.reduce(function (m, g) { return m + g.minPrice; }, 0);
    var storeRanks = Object.keys(totals).map(function (n) { return totals[n]; })
      .filter(function (t) { return t.have > 0; })
      .sort(function (a, b) { return (b.have - a.have) || (a.sum - b.sum); });

    var itemRows = items.map(function (g) {
      var best = g.variants[0];
      var priceTxt = nf(g.minPrice) + (g.unitPrice != null ? ' · ' + nfUnit(g.unitPrice, g.unitDim) : '');
      var whereTxt = g.storeCount > 1 ? 'billigst hos ' + best.storeName + ' · ' + g.storeCount + ' butikker' : best.storeName;
      return h('div', { cls: 'row-hover', style: 'display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; padding: 12px 16px 12px 12px; border-bottom: 1px solid color-mix(in srgb, var(--color-text) 8%, transparent);' }, [
        h('button', { type: 'button', cls: 'btn btn-ghost', 'aria-label': 'Fjern ' + g.name + ' fra handlelisten', title: 'Fjern fra handlelisten', style: 'width: 34px; height: 34px; padding: 0; font-size: 16px; color: var(--color-accent-700);', onClick: function () { toggleList(g.key); }, text: '★' }),
        h('span', Object.assign({ style: 'cursor: pointer; display: block;' }, activate(openGroup(g.key), g.name + ', ' + priceTxt)), [
          h('span', { style: NAME_STYLE, text: g.name }),
          h('span', { style: 'display: block; font-size: 13px; color: ' + MUTED60 + ';', text: whereTxt })
        ]),
        h('span', { style: 'display: flex; flex-direction: column; align-items: flex-end; gap: 2px;' }, [
          h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 20px; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: nf(g.minPrice) }),
          g.unitPrice != null ? h('span', { style: 'font-size: 12px; color: ' + MUTED60 + "; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: nfUnit(g.unitPrice, g.unitDim) }) : null
        ])
      ]);
    });

    var listBlock = h('div', {}, [
      h('span', { style: KICKER, text: '01 · Varene dine (' + items.length + ')' }),
      h('hr', { style: RULE }),
      h('div', { cls: 'blueprint', style: 'padding: 0;' }, corners().concat(itemRows)),
      missing ? h('p', { style: 'margin: 16px 0 0; font-size: 13px; color: ' + MUTED60 + ';', text: missing + (missing === 1 ? ' vare' : ' varer') + ' i lista finnes ikke i leksikonet akkurat nå (kan ha gått ut av sortimentet) og telles ikke med.' }) : null
    ]);

    var compRows = storeRanks.map(function (t, i) {
      var full = t.have === items.length;
      return h('div', { style: 'display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; padding: 14px 20px; border-bottom: 1px solid color-mix(in srgb, var(--color-text) 8%, transparent);' + (i === 0 ? ' background: color-mix(in srgb, var(--color-accent) 6%, transparent);' : '') }, [
        h('span', { style: 'display: flex; align-items: center; gap: 12px;' }, [
          storeLine((STORE_STYLE[t.id] || {}).color || 'var(--color-accent)', (STORE_STYLE[t.id] || {}).dash || '', 18),
          h('span', { style: NAME_STYLE, text: t.name })
        ]),
        h('span', { cls: 'tag ' + (full ? 'tag-accent' : 'tag-neutral'), text: 'har ' + t.have + ' av ' + items.length }),
        h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 22px; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: nf(t.sum) })
      ]);
    });

    var compBlock = h('div', { style: 'margin-top: 40px;' }, [
      h('span', { style: KICKER, text: '02 · Hva lista koster per butikk' }),
      h('hr', { style: RULE }),
      h('div', { cls: 'blueprint', style: 'padding: 0;' }, corners().concat(compRows)),
      h('p', { style: 'margin: 16px 0 0; font-size: 13px; color: ' + MUTED60 + ';', text: 'Summen gjelder bare varene hver butikk faktisk fører (se «har N av ' + items.length + '»), så en lav sum kan bety at butikken mangler varer. Handler du hver vare der den er billigst, lander lista på ' + nf(cheapestTotal) + '.' })
    ]);

    return h('section', { 'data-screen-label': 'Handleliste' }, [head, sharedBanner, listBlock, compBlock]);
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
  function extLink(href, txt) { return h('a', { href: href, target: '_blank', rel: 'noopener', text: txt }); }

  function renderAbout() {
    var P = 'margin: 0 0 12px; font-size: 15px; line-height: 23px; max-width: 68ch;';
    var UL = 'margin: 0; padding-left: 20px; max-width: 68ch;';
    var head = h('div', { style: 'padding: 56px 0 8px;' }, [
      h('h1', { style: H1, text: 'Om Prisboka' }),
      h('p', { style: 'margin: 16px 0 0; max-width: 68ch; font-size: 16px; line-height: 24px; color: ' + MUTED70 + ';', text: 'Et matvareleksikon med ekte priser fra norske dagligvarekjeder — og hvor prisen er på vei. Gratis, uten konto.' })
    ]);

    var what = aboutSection('Hva er dette', '01', [
      h('p', { style: P }, ['Prisboka samler priser på matvarer fra ', h('strong', { text: 'Rema 1000, Kiwi, Extra og Meny' }), ' (og Oda) på ett sted, så du kan sammenligne før du handler. Søk opp en vare, se hva den koster i hver butikk, hvilken pakning som er billigst per kilo/liter, og hvordan prisen har beveget seg.']),
      h('p', { style: P + ' color: ' + MUTED70 + ';', text: 'Prisboka er et uavhengig hobbyprosjekt og er ikke tilknyttet, eid av eller godkjent av noen av kjedene.' })
    ]);

    var sources = aboutSection('Kilder', '02', [
      h('p', { style: P, text: 'Prisene hentes automatisk hver uke fra offentlige kilder, og suppleres med priser fellesskapet bidrar med:' }),
      h('ul', { style: UL }, [
        bullet('Tilbudsaviser', '— ukens tilbud fra kjedenes tilbudsaviser.'),
        bullet('Skannede kvitteringer', '— priser fellesskapet bidrar med ved å skanne kvitteringer, merket «Skannet» i prishistorikken.')
      ]),
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

    var contact = aboutSection('Kildekode', '04', [
      h('p', { style: P }, ['Prisboka er åpen kildekode. Koden ligger på ', extLink('https://github.com/sindre31/matvareleksikon', 'GitHub'), '.'])
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
          h('a', { href: '#/om', onClick: nav('om'), text: 'Personvern' })
        ]),
        h('span', { style: 'color: ' + MUTED60 + '; max-width: 62ch;', text: 'Ekte priser fra Rema 1000, Kiwi, Extra, Meny og Oda. Uavhengig prosjekt — ikke tilknyttet kjedene. Sjekk prisen i butikk.' })
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
    return frag;
  }

  // Any exception while building a screen used to blank the whole app (render
  // clears #app first, then threw), leaving a white page. Guard it: on failure
  // show a recoverable crash screen instead of nothing.
  function render() {
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
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  // PostgREST caps a response at 1000 rows, so page through all offers.
  // Only the columns the client actually reads (valid_from and the offer-level
  // source column were fetched but never used — dropped to trim the payload).
  var OFFER_COLS = 'store_id,product_name,group_key,price,pre_price,unit,unit_price,unit_price_unit,offer_days,image_url,valid_until';
  function fetchAllOffers() {
    return new Promise(function (resolve, reject) {
      var all = [];
      (function page(offset) {
        sb('/ml_offers?select=' + OFFER_COLS + '&order=external_id&limit=1000&offset=' + offset)
          .then(function (r) { if (!r.ok) throw new Error('offers ' + r.status); return r.json(); })
          .then(function (rows) { all = all.concat(rows || []); if (!rows || rows.length < 1000 || offset >= 40000) resolve(all); else page(offset + 1000); })
          .catch(reject);
      })(0);
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
  var CAT_CACHE = 'prisboka-catalog-v1';
  var CAT_OFFERS_URL = '/__prisboka-offers-cache'; // synthetic same-origin Cache key (never fetched)
  var CAT_META_KEY = 'prisboka_catalog_meta_v2';
  var hasCaches = (typeof caches !== 'undefined' && caches && typeof caches.open === 'function');

  // Retire the old localStorage cache keys (superseded by the Cache API blob).
  try { localStorage.removeItem('prisboka_catalog_v1'); localStorage.removeItem('prisboka_catalog_meta'); } catch (e) { /* noop */ }

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
    buildStores(stores);
    buildGroups(offers);
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
    window.addEventListener('hashchange', route);
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

    render();
    boot();
  }

  // Node/CommonJS: expose the pure price/grouping helpers for unit tests. This
  // is a no-op in the browser (no `module`), so it never affects the app.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      cleanName: cleanName, pctOff: pctOff, baseAmount: baseAmount,
      parseAmount: parseAmount, normUnit: normUnit, foldName: foldName,
      minceKey: minceKey, ckey: ckey, canonLabel: canonLabel,
      buildStores: buildStores, buildGroups: buildGroups, searchRank: searchRank
    };
  }
})();
