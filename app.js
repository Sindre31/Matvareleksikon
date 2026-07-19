/*
 * Prisboka — Matvareleksikon med pristrender
 * ------------------------------------------------------------------
 * Runnable, dependency-free implementation of the Claude Design prototype
 * `design/Matvareleksikon.dc.html`, backed by a live Supabase database.
 *
 *  - Prices, stores and products are read from Supabase (PostgREST) at boot.
 *  - Scanned-receipt contributions are POSTed back and persist in the DB,
 *    counting toward the community total.
 *  - Screens are deep-linkable: #/ , #/produkt/:id , #/skann.
 *
 * The rendering and the price/trend computations mirror the prototype's
 * `Component` class; only the data source changed from a synthetic formula
 * to the seeded Supabase tables (which were seeded with that same formula,
 * so the numbers match the original design).
 */
(function () {
  "use strict";

  // ── Supabase (public read + anon insert; publishable key is safe client-side) ─
  var SUPABASE_URL = 'https://jiaxeedguivvhixychcg.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_trP_tgjyaPU-2eJ7n9JX4w_Q7kIvDPC';
  function sb(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }, opts.headers || {});
    return fetch(SUPABASE_URL + '/rest/v1' + path, opts);
  }

  // ── Data (populated at boot) ─────────────────────────────────────────────
  var STORES = [];       // [{ id, name, color, dash, places[] }] ordered by sort_order
  var PRODUCTS = [];      // [{ id, name, unit, cat, regs, seed }]
  var PRICES = {};        // PRICES[productId][storeIndex][monthIndex] = number
  var MONTHS = ['aug', 'sep', 'okt', 'nov', 'des', 'jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul'];

  function buildData(stores, products, priceRows) {
    STORES = stores.map(function (s) { return { id: s.id, name: s.name, color: s.color, dash: s.dash || '', places: s.places || [] }; });
    var storeIndex = {};
    STORES.forEach(function (s, i) { storeIndex[s.id] = i; });
    PRODUCTS = products.map(function (p) { return { id: p.id, name: p.name, unit: p.unit, cat: p.category, regs: p.base_regs, seed: p.sort_order + 1 }; });
    PRICES = {};
    PRODUCTS.forEach(function (p) { PRICES[p.id] = STORES.map(function () { return new Array(12); }); });
    priceRows.forEach(function (row) {
      var si = storeIndex[row.store_id];
      if (si == null || !PRICES[row.product_id]) return;
      PRICES[row.product_id][si][row.month_index] = Number(row.price);
    });
  }

  // ── Component state ──────────────────────────────────────────────────────
  var state = {
    phase: 'loading', errMsg: '',
    view: 'home', productId: null, query: '', cat: 'Alle',
    scanPhase: 'idle', scanPct: 0, scanStep: '', scanItems: [],
    scanStore: 'Kiwi', scanPlace: 'Kiwi Grünerløkka, Oslo',
    scanSubmitting: false, scanError: null, scanImageUrl: null, scanNote: null,
    bootTotal: 0, doneCount: 0, doneMsgN: 0,
    chartMonths: 12 // prototype prop `chartMonths` (enum 6|12, default 12)
  };
  var timers = [];

  function setState(patch) {
    Object.assign(state, patch);
    render();
  }

  // ── Computations (mirroring the prototype; data now from the DB) ─────────
  function priceAt(p, si, m) { return PRICES[p.id][si][m]; }
  function nf(v) { return 'kr ' + v.toFixed(2).replace('.', ','); }
  function fmtPct(v) { return (v > 0 ? '+' : '−') + Math.abs(v).toFixed(1).replace('.', ',') + ' %'; }
  function regDate(p, si) {
    var daysAgo = (p.seed * 7 + si * 3) % 9;
    var d = new Date(2026, 6, 18 - daysAgo);
    return d.getDate() + '. ' + ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli'][d.getMonth()] + ' 2026';
  }
  function chartFor(p, months) {
    var M = months, start = 12 - M;
    var pl = 46, pr = 14, pt = 14, pb = 24, W = 760, H = 300;
    var lo = Infinity, hi = -Infinity, si, m, v;
    for (si = 0; si < STORES.length; si++) for (m = start; m < 12; m++) { v = priceAt(p, si, m); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    var pad = (hi - lo) * 0.12 || 2; lo -= pad; hi += pad;
    var x = function (mm) { return pl + ((mm - start) / (M - 1)) * (W - pl - pr); };
    var y = function (vv) { return pt + (1 - (vv - lo) / (hi - lo)) * (H - pt - pb); };
    var chartLines = STORES.map(function (s, si) {
      var pts = [], lastX = 0, lastY = 0;
      for (var m = start; m < 12; m++) { var v = priceAt(p, si, m); lastX = x(m); lastY = y(v); pts.push(lastX.toFixed(1) + ',' + lastY.toFixed(1)); }
      return { points: pts.join(' '), color: s.color, dash: s.dash, lastX: lastX.toFixed(1), lastY: lastY.toFixed(1) };
    });
    var gridLines = [];
    for (var i = 0; i < 4; i++) {
      var gv = lo + (i / 3) * (hi - lo), gy = y(gv);
      gridLines.push({ y: gy.toFixed(1), ty: (gy + 3.5).toFixed(1), label: Math.round(gv) + ' kr' });
    }
    var monthTicks = [];
    for (var mt = start; mt < 12; mt++) monthTicks.push({ x: x(mt).toFixed(1), label: MONTHS[mt] + (mt < 5 ? ' 25' : ' 26') });
    return { chartLines: chartLines, gridLines: gridLines, monthTicks: monthTicks };
  }
  // ── Real OCR: Tesseract.js in the browser (no backend, no API key) ───────
  var TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var tesseractPromise = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = TESSERACT_SRC; s.async = true;
      s.onload = function () { window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract lastet ikke')); };
      s.onerror = function () { reject(new Error('Kunne ikke laste tekstgjenkjenning')); };
      document.head.appendChild(s);
    });
    return tesseractPromise;
  }

  // Downscale large photos before OCR — faster, and usually cleaner text.
  function preprocessImage(file) {
    return new Promise(function (resolve) {
      if (!/^image\//.test(file.type)) { resolve(file); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var max = 1600, w = img.naturalWidth, h = img.naturalHeight;
        if (Math.max(w, h) <= max) { URL.revokeObjectURL(url); resolve(file); return; }
        var scale = max / Math.max(w, h);
        var c = document.createElement('canvas');
        c.width = Math.round(w * scale); c.height = Math.round(h * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (blob) { resolve(blob || file); }, 'image/png');
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  // Turn raw OCR text into candidate line items (name + price).
  function parseReceiptText(text) {
    var lines = String(text || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    // Price = the last money token on the line (optionally trailed by a tax code letter/*).
    var priceRe = /(-?\d{1,4}[.,]\d{2})\s*[*A-Za-z]?\s*$/;
    // Norwegian MVA-rate column that sits between the name and the price (e.g. "… 15%  25,40").
    var vatTailRe = /[\s.]*(?:0|11|12|15|25)\s*[%xX]?\s*$/;
    // Summary / payment / footer / membership lines — never products.
    var skipRe = /(sum\b|total|totalt|å\s*betale|\bbetal|kontant|\bbank\b|bankaxept|\bkort\b|visa|mastercard|beløp|\bmva\b|moms|grunnlag|avrund|veksel|tilbake|gebyr|rabatt|kvittering|foretaksreg|org\.?\s*nr|serienr|kvitt\b|opernr|\bkasse\b|\btrumf|\bkunde|medlem|saldo|pluss|bonus|\bvarer\b|terminal|\baid\b|contactless|autoris|authorization|godkjent|velkommen|antall|takk)/i;
    // Weight / unit-price detail lines (e.g. "0,580kg x kr 49,90"): the item above already
    // carries the line total, so these must not become separate items.
    var detailRe = /(\d[.,]?\d*\s*(?:kg|hg|g|l|dl|stk)\s*[x×*]\s*kr|[x×*]\s*kr\b|kr\s*\/\s*(?:kg|l|stk)|pris\s*pr)/i;
    var items = [];
    for (var i = 0; i < lines.length && items.length < 40; i++) {
      var line = lines[i];
      if (skipRe.test(line) || detailRe.test(line)) continue;
      var m = line.match(priceRe);
      if (!m) continue;
      var price = parseFloat(m[1].replace(',', '.'));
      if (!isFinite(price) || price <= 0 || price > 100000) continue;
      var name = line.slice(0, m.index)
        .replace(vatTailRe, '')                    // drop the trailing "15%" / "25" VAT column
        .replace(/[.\s]+$/, '')
        .replace(/^\d+\s*(?:x|stk\.?)\s+/i, '')    // drop a leading "2 x " / "3 stk " quantity
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (name.replace(/[^a-zA-ZæøåÆØÅ]/g, '').length < 2) continue;
      items.push({ name: name, price: m[1].replace(',', '.') });
    }
    return items;
  }
  function detectStore(text) {
    var up = String(text || '').toUpperCase();
    if (up.indexOf('REMA') !== -1) return 'Rema 1000';
    if (up.indexOf('KIWI') !== -1) return 'Kiwi';
    if (up.indexOf('EXTRA') !== -1) return 'Extra';
    if (up.indexOf('MENY') !== -1) return 'Meny';
    return null;
  }

  var OCR_STEPS = {
    'loading tesseract core': 'Laster tekstgjenkjenning …',
    'initializing tesseract': 'Starter tekstgjenkjenning …',
    'loading language traineddata': 'Laster norsk språkmodell …',
    'initializing api': 'Klargjør …',
    'recognizing text': 'Leser varelinjene …'
  };

  function onScanFile(file) {
    if (!file) return;
    if (state.scanImageUrl) URL.revokeObjectURL(state.scanImageUrl);
    var previewUrl = /^image\//.test(file.type) ? URL.createObjectURL(file) : null;
    setState({ scanPhase: 'scanning', scanPct: 0, scanStep: 'Laster tekstgjenkjenning …', scanError: null, scanNote: null, scanImageUrl: previewUrl });
    runOcr(file);
  }

  function runOcr(file) {
    var worker = null;
    loadTesseract()
      .then(function (T) { return preprocessImage(file).then(function (img) { return { T: T, img: img }; }); })
      .then(function (ctx) {
        return ctx.T.createWorker('nor', 1, {
          logger: function (m) {
            if (!m || m.status == null) return;
            var step = OCR_STEPS[m.status] || state.scanStep;
            var pct = Math.max(0, Math.min(100, Math.round((m.progress || 0) * 100)));
            setState({ scanStep: step, scanPct: pct });
          }
        }).then(function (w) { worker = w; return w.recognize(ctx.img); });
      })
      .then(function (res) {
        var text = (res && res.data && res.data.text) || '';
        var items = parseReceiptText(text);
        var store = detectStore(text);
        var patch = { scanPhase: 'review', scanPct: 100 };
        if (store) { patch.scanStore = store; var s = STORES.filter(function (x) { return x.name === store; })[0]; if (s) patch.scanPlace = s.places[0]; }
        if (items.length) { patch.scanItems = items; patch.scanNote = 'Fant ' + items.length + ' varelinjer' + (store ? ' · gjenkjente butikk: ' + store : '') + '. Kontroller dem før du lagrer.'; }
        else { patch.scanItems = [{ name: '', price: '' }]; patch.scanNote = 'Fant ingen varelinjer automatisk — skriv dem inn manuelt, eller prøv et skarpere bilde.'; }
        setState(patch);
      })
      .catch(function () {
        setState({ scanPhase: 'review', scanItems: [{ name: '', price: '' }], scanNote: 'Kunne ikke lese bildet automatisk — skriv inn varelinjene manuelt.', scanError: null });
      })
      .then(function () { if (worker && worker.terminate) worker.terminate(); });
  }
  function addScanRow() { setState({ scanItems: state.scanItems.concat([{ name: '', price: '' }]) }); }
  function resetScan() {
    if (state.scanImageUrl) URL.revokeObjectURL(state.scanImageUrl);
    setState({ scanPhase: 'idle', scanItems: [], scanImageUrl: null, scanNote: null, scanError: null });
  }
  function submitScan() {
    if (state.scanSubmitting || !state.scanItems.length) return;
    var storeObj = STORES.filter(function (x) { return x.name === state.scanStore; })[0];
    var payload = state.scanItems.map(function (it) {
      var raw = String(it.price == null ? '' : it.price).replace(',', '.').trim();
      var price = raw === '' ? null : Number(raw);
      return { item_name: it.name, price: (price == null || isNaN(price)) ? null : price, store_id: storeObj ? storeObj.id : null, place: state.scanPlace, product_id: null };
    });
    var n = state.scanItems.length;
    setState({ scanSubmitting: true, scanError: null });
    sb('/ml_registrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); })
      .then(function () { setState({ scanPhase: 'done', doneCount: state.doneCount + n, doneMsgN: n, scanSubmitting: false }); })
      .catch(function () { setState({ scanSubmitting: false, scanError: 'Kunne ikke lagre prisene nå. Sjekk nettforbindelsen og prøv igjen.' }); });
  }

  // ── Tiny hyperscript with an SVG-aware namespace and inline-style strings ─
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
      else if (k === 'onClick') { el.addEventListener('click', val); }
      else if (k === 'onInput') { el.addEventListener('input', val); }
      else if (k === 'onChange') { el.addEventListener('change', val); }
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
  function corners() {
    return [h('i', { cls: 'corner tl' }), h('i', { cls: 'corner tr' }), h('i', { cls: 'corner bl' }), h('i', { cls: 'corner br' })];
  }
  function storeLine(color, dash, w) {
    return h('svg', { width: w, height: '6', 'aria-hidden': 'true' },
      h('line', { x1: '0', y1: '3', x2: String(w), y2: '3', stroke: color, 'stroke-width': w === 18 ? '3' : '2.5', 'stroke-dasharray': dash }));
  }

  // ── Routing (deep-linkable screens) ──────────────────────────────────────
  function parseHash() {
    var hn = (location.hash || '').replace(/^#/, '');
    if (hn.indexOf('/produkt/') === 0) return { view: 'product', productId: decodeURIComponent(hn.slice('/produkt/'.length)) };
    if (hn === '/skann') return { view: 'scan' };
    return { view: 'home' };
  }
  function route() {
    if (state.phase !== 'ready') { render(); return; }
    var r = parseHash();
    if (r.view === 'product') {
      if (!PRODUCTS.some(function (p) { return p.id === r.productId; })) { location.hash = '#/'; return; }
      state.view = 'product'; state.productId = r.productId;
    } else if (r.view === 'scan') {
      state.view = 'scan';
    } else {
      state.view = 'home';
    }
    render();
  }
  function go(hash) { if (location.hash === hash || (hash === '#/' && !location.hash)) route(); else location.hash = hash; }
  function open(id) { return function () { go('#/produkt/' + id); window.scrollTo(0, 0); }; }
  function nav(view) { return function (e) { if (e && e.preventDefault) e.preventDefault(); go(view === 'scan' ? '#/skann' : '#/'); window.scrollTo(0, 0); }; }

  // ── Derived home values ──────────────────────────────────────────────────
  function totalRegsText() { return (state.bootTotal + state.doneCount).toLocaleString('nb-NO').replace(/\s/g, ' '); }

  function homeVals() {
    var q = state.query.trim().toLowerCase();
    var cat = state.cat || 'Alle';
    var filtered = PRODUCTS.filter(function (p) {
      return (cat === 'Alle' || p.cat === cat) && (!q || (p.name + ' ' + p.cat + ' ' + p.unit).toLowerCase().indexOf(q) !== -1);
    }).map(function (p) {
      var prices = STORES.map(function (s, si) { return priceAt(p, si, 11); });
      var avgNow = prices.reduce(function (a, b) { return a + b; }) / STORES.length;
      var avgPrev = STORES.map(function (s, si) { return priceAt(p, si, 10); }).reduce(function (a, b) { return a + b; }) / STORES.length;
      return { name: p.name, cat: p.cat, unit: p.unit, regs: p.regs, from: 'fra ' + nf(Math.min.apply(null, prices)), pct: fmtPct((avgNow / avgPrev - 1) * 100), open: open(p.id) };
    });
    var changes = PRODUCTS.map(function (p) {
      var now = STORES.map(function (s, si) { return priceAt(p, si, 11); }).reduce(function (a, b) { return a + b; }) / STORES.length;
      var prev = STORES.map(function (s, si) { return priceAt(p, si, 10); }).reduce(function (a, b) { return a + b; }) / STORES.length;
      return { p: p, pct: (now / prev - 1) * 100, now: now, prev: prev };
    }).sort(function (a, b) { return b.pct - a.pct; });
    var mkChange = function (c, i) { return { idx: '0' + (i + 1), name: c.p.name, unit: c.p.unit, fromTo: nf(c.prev) + ' → ' + nf(c.now), pct: fmtPct(c.pct), open: open(c.p.id) }; };
    var uniqueCats = ['Alle']; PRODUCTS.forEach(function (p) { if (uniqueCats.indexOf(p.cat) === -1) uniqueCats.push(p.cat); });
    return {
      totalRegs: totalRegsText(),
      changesDisplay: q ? 'none' : 'block',
      filtered: filtered,
      changesUp: changes.slice(0, 4).map(mkChange),
      changesDown: changes.slice(-4).reverse().map(mkChange),
      catFilters: uniqueCats.map(function (c) {
        return { label: c, active: c === cat ? 'true' : 'false', cls: c === cat ? 'btn-primary' : 'btn-ghost', pick: function () { setState({ cat: c }); } };
      }),
      noHits: filtered.length === 0,
      query: state.query,
      catalogKicker: q ? 'Treff i leksikonet (' + filtered.length + ')' : '02 · ' + (cat === 'Alle' ? 'Hele leksikonet' : cat) + ' (' + filtered.length + ' varer)'
    };
  }

  // ── Screen renderers ─────────────────────────────────────────────────────
  var MUTED60 = 'color-mix(in srgb, var(--color-text) 60%, transparent)';
  var MUTED70 = 'color-mix(in srgb, var(--color-text) 70%, transparent)';
  var MUTED78 = 'color-mix(in srgb, var(--color-text) 78%, transparent)';
  var KICKER = 'display: block; font-size: 13px; line-height: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: var(--color-accent-700); margin-bottom: 12px;';
  var RULE = 'height: 1px; border: 0; margin: 0 0 24px; background: var(--color-divider);';
  var NAME_STYLE = 'font-family: var(--font-heading); font-weight: 600; font-size: 18px; letter-spacing: 0.02em; text-transform: uppercase;';

  function renderNav(totalText) {
    return h('nav', { cls: 'nav', 'data-screen-label': 'Topplinje', style: 'padding-inline: max(24px, calc((100% - 1160px) / 2 + 24px));' }, [
      h('span', { cls: 'nav-brand', onClick: nav('home'), style: 'cursor: pointer;', text: 'Prisboka' }),
      h('a', { href: '#/', onClick: nav('home'), text: 'Leksikon' }),
      h('a', { href: '#/skann', onClick: nav('scan'), text: 'Bidra med priser' }),
      h('span', { style: 'flex: 1;' }),
      h('span', { style: 'font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; color: ' + MUTED70 + "; font-feature-settings: 'tnum' 1;", text: totalText + ' priser · fellesskapsregistrert' }),
      h('button', { type: 'button', cls: 'btn btn-primary', onClick: nav('scan'), text: 'Skann kvittering' })
    ]);
  }

  function changeCard(title, rows, pctColor) {
    var body = h('div', {}, rows.map(function (c) {
      return h('div', { cls: 'row-hover', onClick: c.open, style: "display: grid; grid-template-columns: 34px 1fr auto auto; gap: 8px; align-items: center; cursor: pointer; padding: 10px 20px; border-bottom: 1px solid color-mix(in srgb, var(--color-text) 8%, transparent);" }, [
        h('span', { style: "font-size: 13px; font-weight: 600; color: var(--color-accent-700); font-feature-settings: 'tnum' 1;", text: c.idx }),
        h('span', {}, [
          h('span', { style: NAME_STYLE, text: c.name }),
          h('span', { style: 'display: block; font-size: 13px; color: ' + MUTED60 + ';', text: c.unit })
        ]),
        h('span', { style: "font-size: 14px; font-feature-settings: 'tnum' 1; white-space: nowrap; color: " + MUTED70 + ';', text: c.fromTo }),
        h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 20px; font-feature-settings: 'tnum' 1; color: " + pctColor + '; text-align: right; min-width: 72px;', text: c.pct })
      ]);
    }));
    var head = h('div', { style: 'padding: 12px 20px; border-bottom: 1px solid var(--color-divider); font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;' }, [
      title + ' ',
      h('span', { style: 'color: ' + MUTED60 + '; font-weight: 400;', text: '· snitt alle butikker' })
    ]);
    return h('div', { cls: 'blueprint', style: 'padding: 0;' }, corners().concat([head, body]));
  }

  function renderHome(v) {
    var hero = h('div', { style: 'padding: 72px 0 48px;' }, [
      h('h1', { style: 'margin: -0.052em 0 0; font-size: clamp(44px, 6vw, 76px); line-height: 1.04; letter-spacing: 0.01em; text-transform: uppercase;' }, ['Matvareleksikonet', h('br'), 'med prisene i klartekst']),
      h('p', { style: 'margin: 20px 0 0; max-width: 60ch; font-size: 16px; line-height: 24px;' }, [
        'Hver pris i boka er sett på en hylle og registrert av noen som handlet der. Søk opp en vare, se hva den koster hos Rema 1000, Kiwi, Extra og Meny — og hvor prisen er på vei.'
      ]),
      h('div', { style: 'display: flex; gap: 10px; margin-top: 28px; max-width: 640px;' }, [
        h('input', {
          cls: 'input', type: 'search', placeholder: 'Søk i leksikonet — f.eks. melk, brød, kaffe …',
          value: v.query, 'aria-label': 'Søk etter matvare', 'data-focus-id': 'search',
          style: 'flex: 1; min-height: 40px; font-size: 16px;',
          onInput: function (e) { setState({ query: e.target.value }); }
        }),
        h('button', { type: 'button', cls: 'btn btn-ghost', onClick: function () { setState({ query: '' }); }, text: 'Nullstill' })
      ])
    ]);

    var changes = h('div', { style: 'padding-bottom: 48px; display: ' + v.changesDisplay + ';' }, [
      h('span', { style: KICKER, text: '01 · Største prisendringer siste måned' }),
      h('hr', { style: RULE }),
      h('div', { style: 'display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 40px;' }, [
        changeCard('Opp i pris', v.changesUp, 'var(--color-accent-900)'),
        changeCard('Ned i pris', v.changesDown, 'var(--color-accent-700)')
      ])
    ]);

    var chips = h('div', { style: 'display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 32px;' }, v.catFilters.map(function (cf) {
      return h('button', { type: 'button', cls: 'btn ' + cf.cls, onClick: cf.pick, 'aria-pressed': cf.active, style: 'min-height: 34px; padding: 4px 14px; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase;', text: cf.label });
    }));

    var grid = h('div', { style: 'display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 32px;' }, v.filtered.map(function (p) {
      return h('div', { cls: 'blueprint card-hover', onClick: p.open, style: 'padding: 20px; cursor: pointer; display: flex; flex-direction: column; gap: 8px;' }, corners().concat([
        h('span', { style: 'font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: ' + MUTED60 + ';', text: p.cat }),
        h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 24px; line-height: 1.1; letter-spacing: 0.02em; text-transform: uppercase;', text: p.name }),
        h('span', { style: 'font-size: 13px; color: ' + MUTED60 + ';', text: p.unit }),
        h('div', { style: 'display: flex; align-items: baseline; gap: 10px; margin-top: 8px;' }, [
          h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 26px; font-feature-settings: 'tnum' 1;", text: p.from }),
          h('span', { cls: 'tag tag-outline', style: "font-feature-settings: 'tnum' 1;", text: p.pct + ' / mnd' })
        ]),
        h('span', { style: "font-size: 13px; color: " + MUTED60 + "; font-feature-settings: 'tnum' 1;", text: p.regs + ' registreringer' })
      ]));
    }));

    var catalog = h('div', {}, [
      h('span', { style: KICKER, text: v.catalogKicker }),
      h('hr', { style: 'height: 1px; border: 0; margin: 0 0 20px; background: var(--color-divider);' }),
      chips, grid,
      v.noHits ? h('p', { style: 'font-size: 15px; color: ' + MUTED70 + ';' }, [
        'Ingen treff på «' + v.query + '» i leksikonet ennå. Har du sett varen i butikk? ',
        h('a', { href: '#/skann', onClick: nav('scan'), text: 'Skann kvitteringen' }),
        ' og legg den til.'
      ]) : null
    ]);

    return h('section', { 'data-screen-label': 'Hovedside' }, [hero, changes, catalog]);
  }

  function renderProduct() {
    var p = PRODUCTS.filter(function (x) { return x.id === state.productId; })[0];
    if (!p) { go('#/'); return h('div'); }
    var months = state.chartMonths;
    var prices = STORES.map(function (s, si) { return priceAt(p, si, 11); });
    var minP = Math.min.apply(null, prices);
    var prod = { name: p.name, cat: p.cat, unit: p.unit, regs: p.regs, cheapest: nf(minP) + ' (' + STORES[prices.indexOf(minP)].name + ')' };
    var storeRows = STORES.map(function (s, si) {
      return { store: s.name, color: s.color, dash: s.dash, price: nf(prices[si]), date: regDate(p, si), place: s.places[(p.seed + si) % s.places.length], cheapVis: prices[si] === minP ? 'visible' : 'hidden' };
    });
    var legend = STORES.map(function (s) { return { store: s.name, color: s.color, dash: s.dash }; });
    var chart = chartFor(p, months);
    var rangeLabel = 'siste ' + months + ' måneder';

    var head = h('div', { style: 'padding: 40px 0 24px;' }, [
      h('a', { href: '#/', onClick: nav('home'), style: 'font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;', text: '← Tilbake til leksikonet' }),
      h('div', { style: 'display: flex; flex-wrap: wrap; align-items: baseline; gap: 16px; margin-top: 20px;' }, [
        h('h1', { style: 'margin: -0.052em 0 0; font-size: clamp(36px, 5vw, 60px); line-height: 1.04; letter-spacing: 0.01em; text-transform: uppercase;', text: prod.name }),
        h('span', { cls: 'tag tag-accent', text: prod.cat }),
        h('span', { style: 'font-size: 15px; color: ' + MUTED70 + ';', text: prod.unit })
      ]),
      h('p', { style: "margin: 12px 0 0; font-size: 15px; color: " + MUTED70 + "; font-feature-settings: 'tnum' 1;" }, [
        prod.regs + ' registreringer fra fellesskapet · billigst nå: ',
        h('strong', { style: 'color: var(--color-text);', text: prod.cheapest })
      ])
    ]);

    var tableHeader = h('div', { style: 'display: grid; grid-template-columns: 1fr 110px 150px 1.2fr; gap: 8px; align-items: center; padding: 12px 20px; border-bottom: 1px solid var(--color-divider); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: ' + MUTED70 + ';' }, [
      h('span', { text: 'Butikk' }), h('span', { style: 'text-align: right;', text: 'Pris' }), h('span', { text: 'Sist registrert' }), h('span', { text: 'Registrert ved' })
    ]);
    var tableRows = storeRows.map(function (r) {
      return h('div', { style: 'display: grid; grid-template-columns: 1fr 110px 150px 1.2fr; gap: 8px; align-items: center; padding: 12px 20px; border-bottom: 1px solid color-mix(in srgb, var(--color-text) 8%, transparent);' }, [
        h('span', { style: 'display: flex; align-items: center; gap: 10px;' }, [
          storeLine(r.color, r.dash, 18),
          h('span', { style: NAME_STYLE, text: r.store }),
          h('span', { cls: 'tag tag-outline', style: 'visibility: ' + r.cheapVis + ';', text: 'Billigst' })
        ]),
        h('span', { style: "text-align: right; font-family: var(--font-heading); font-weight: 600; font-size: 22px; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: r.price }),
        h('span', { style: "font-size: 14px; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: r.date }),
        h('span', { style: 'font-size: 14px; color: ' + MUTED78 + ';', text: r.place })
      ]);
    });
    var tableBlock = h('div', { style: 'padding-bottom: 40px;' }, [
      h('span', { style: KICKER, text: '01 · Pris per butikk' }),
      h('hr', { style: RULE }),
      // Horizontal scroll wrapper keeps the fixed columns intact on small screens.
      h('div', { style: 'overflow-x: auto; -webkit-overflow-scrolling: touch;' }, [
        h('div', { cls: 'blueprint', style: 'padding: 0; min-width: 560px;' }, corners().concat([tableHeader]).concat(tableRows))
      ])
    ]);

    var legendEls = legend.map(function (l) {
      return h('span', { style: 'display: inline-flex; align-items: center; gap: 8px; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600;' }, [storeLine(l.color, l.dash, 26), l.store]);
    });
    var svgKids = [];
    chart.gridLines.forEach(function (g) {
      svgKids.push(h('line', { x1: '46', x2: '748', y1: g.y, y2: g.y, stroke: 'var(--color-divider)', 'stroke-width': '1' }));
      svgKids.push(h('text', { x: '40', y: g.ty, 'text-anchor': 'end', 'font-size': '11', fill: MUTED60, 'font-family': 'var(--font-body)', text: g.label }));
    });
    chart.monthTicks.forEach(function (m) {
      svgKids.push(h('text', { x: m.x, y: '294', 'text-anchor': 'middle', 'font-size': '11', fill: MUTED60, 'font-family': 'var(--font-body)', text: m.label }));
    });
    chart.chartLines.forEach(function (ln) {
      svgKids.push(h('polyline', { points: ln.points, fill: 'none', stroke: ln.color, 'stroke-width': '2.5', 'stroke-dasharray': ln.dash, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      svgKids.push(h('circle', { cx: ln.lastX, cy: ln.lastY, r: '3.5', fill: ln.color }));
    });
    var svg = h('svg', { viewBox: '0 0 760 300', style: 'width: 100%; height: auto; display: block;', role: 'img', 'aria-label': 'Linjediagram over prisutvikling per butikk' }, svgKids);

    // Range toggle honours the prototype's `chartMonths` enum prop (6 | 12).
    var rangeToggle = h('div', { cls: 'seg', style: 'margin-left: auto;', role: 'group', 'aria-label': 'Velg tidsrom' }, [6, 12].map(function (mo) {
      return h('button', { type: 'button', cls: 'btn ' + (months === mo ? 'btn-primary' : 'btn-ghost'), onClick: function () { setState({ chartMonths: mo }); }, 'aria-pressed': months === mo ? 'true' : 'false', style: 'min-height: 30px; padding: 2px 12px; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; border: 0;', text: mo + ' mnd' });
    }));

    var chartBlock = h('div', {}, [
      h('span', { style: KICKER, text: '02 · Prisutvikling ' + rangeLabel }),
      h('hr', { style: RULE }),
      h('div', { cls: 'blueprint', style: 'padding: 24px;' }, corners().concat([
        h('div', { style: 'display: flex; flex-wrap: wrap; gap: 20px; margin-bottom: 16px; align-items: center;' }, legendEls.concat([rangeToggle])),
        svg,
        h('p', { style: 'margin: 16px 0 0; font-size: 13px; color: ' + MUTED60 + ';', text: 'Månedssnitt av fellesskapets registreringer, ' + rangeLabel + '. Kilde: kvitteringer skannet av brukerne.' })
      ]))
    ]);

    return h('section', { 'data-screen-label': 'Produktside' }, [head, tableBlock, chartBlock]);
  }

  function renderScan() {
    var head = h('div', { style: 'padding: 56px 0 40px;' }, [
      h('h1', { style: 'margin: -0.052em 0 0; font-size: clamp(36px, 5vw, 60px); line-height: 1.04; letter-spacing: 0.01em; text-transform: uppercase;', text: 'Skann en kvittering' }),
      h('p', { style: 'margin: 16px 0 0; max-width: 60ch; font-size: 16px; line-height: 24px;', text: 'Prisene i leksikonet kommer fra kvitteringer som deg og andre har lastet opp. Vi leser varelinjene, du kontrollerer dem, og prisene føres inn i databasen med butikk, sted og dato.' })
    ]);

    var body;
    if (state.scanPhase === 'idle') {
      var uploadInput = h('input', { type: 'file', accept: 'image/*', style: 'display: none;', onChange: function (e) { onScanFile(e.target.files && e.target.files[0]); } });
      var cameraInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display: none;', onChange: function (e) { onScanFile(e.target.files && e.target.files[0]); } });
      var uploadCard = h('div', { cls: 'blueprint', style: 'padding: 28px; display: flex; flex-direction: column; gap: 12px;' }, corners().concat([
        h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 24px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Last opp bilde' }),
        h('p', { style: 'margin: 0; font-size: 15px; line-height: 22px; color: ' + MUTED78 + ';', text: 'Velg et foto av kvitteringen fra enheten din. Vi leser varelinjene med tekstgjenkjenning direkte i nettleseren.' }),
        h('label', { cls: 'btn btn-primary', style: 'align-self: flex-start; cursor: pointer; margin-top: 8px;' }, ['Velg bilde', uploadInput])
      ]));
      var cameraCard = h('div', { cls: 'blueprint', style: 'padding: 28px; display: flex; flex-direction: column; gap: 12px;' }, corners().concat([
        h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 24px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Bruk kameraet' }),
        h('p', { style: 'margin: 0; font-size: 15px; line-height: 22px; color: ' + MUTED78 + ';', text: 'Ta bilde av kvitteringen direkte på mobil. Hold den flatt og i godt lys.' }),
        h('label', { cls: 'btn btn-ghost', style: 'align-self: flex-start; cursor: pointer; margin-top: 8px;' }, ['Åpne kamera', cameraInput])
      ]));
      body = h('div', { style: 'display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 40px; max-width: 820px;' }, [uploadCard, cameraCard]);
    } else if (state.scanPhase === 'scanning') {
      var preview = state.scanImageUrl
        ? h('div', { style: 'position: relative; aspect-ratio: 3 / 4; max-height: 320px; background: var(--color-accent-900); overflow: hidden; margin-bottom: 16px;' }, [
            h('img', { src: state.scanImageUrl, alt: 'Kvittering under lesing', style: 'width: 100%; height: 100%; object-fit: contain; opacity: 0.9;' }),
            h('div', { style: 'position: absolute; left: 0; right: 0; top: 4%; height: 2px; background: color-mix(in srgb, var(--color-bg) 85%, transparent); box-shadow: 0 0 8px var(--color-bg); animation: scanline 2.6s ease-in-out infinite;' })
          ])
        : null;
      body = h('div', { cls: 'blueprint', style: 'max-width: 520px; padding: 24px;' }, corners().concat([
        preview,
        h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 22px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Leser kvitteringen …' }),
        h('p', { style: 'margin: 10px 0 16px; font-size: 15px; color: ' + MUTED78 + ';', text: state.scanStep + (state.scanPct ? ' (' + state.scanPct + ' %)' : '') }),
        h('div', { style: 'height: 4px; background: var(--color-accent-200);' }, [
          h('div', { style: 'height: 100%; background: var(--color-accent); width: ' + state.scanPct + '%; transition: width 0.2s ease;' })
        ])
      ]));
    } else if (state.scanPhase === 'review') {
      var controls = h('div', { style: 'display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end;' }, [
        h('label', { style: 'display: flex; flex-direction: column; gap: 6px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;' }, [
          'Butikk',
          h('select', { cls: 'input', 'data-focus-id': 'scan-store', style: 'min-height: 38px; min-width: 180px;', value: state.scanStore, onChange: function (e) {
            var s = STORES.filter(function (x) { return x.name === e.target.value; })[0];
            setState({ scanStore: e.target.value, scanPlace: s ? s.places[0] : state.scanPlace });
          } }, STORES.map(function (s) {
            return h('option', { value: s.name, selected: s.name === state.scanStore ? 'selected' : false, text: s.name });
          }))
        ]),
        h('label', { style: 'display: flex; flex-direction: column; gap: 6px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;' }, [
          'Sted',
          h('input', { cls: 'input', 'data-focus-id': 'scan-place', style: 'min-height: 38px; min-width: 220px;', value: state.scanPlace, onInput: function (e) { setState({ scanPlace: e.target.value }); } })
        ]),
        h('span', { style: 'font-size: 13px; color: ' + MUTED60 + '; padding-bottom: 10px;', text: 'Dato: 18. juli 2026 (fra kvitteringen)' })
      ]);
      var rows = h('div', { style: 'display: flex; flex-direction: column; gap: 8px;' }, state.scanItems.map(function (it, i) {
        return h('div', { style: 'display: grid; grid-template-columns: 1fr 120px 38px; gap: 10px; align-items: center;' }, [
          h('input', { cls: 'input', 'aria-label': 'Varenavn', 'data-focus-id': 'scan-name-' + i, style: 'min-height: 38px;', value: it.name, onInput: function (e) {
            var items = state.scanItems.slice(); items[i] = Object.assign({}, items[i], { name: e.target.value }); setState({ scanItems: items });
          } }),
          h('input', { cls: 'input', type: 'number', step: '0.1', 'aria-label': 'Pris i kroner', 'data-focus-id': 'scan-price-' + i, style: "min-height: 38px; text-align: right; font-feature-settings: 'tnum' 1;", value: it.price, onInput: function (e) {
            var items = state.scanItems.slice(); items[i] = Object.assign({}, items[i], { price: e.target.value }); setState({ scanItems: items });
          } }),
          h('button', { type: 'button', cls: 'btn btn-ghost btn-icon', 'aria-label': 'Fjern varelinje', style: 'min-height: 38px;', onClick: function () {
            setState({ scanItems: state.scanItems.filter(function (x, j) { return j !== i; }) });
          }, text: '✕' })
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
      var doneMsg = (state.doneMsgN || state.scanItems.length) + ' priser registrert ved ' + state.scanPlace + '.';
      body = h('div', { cls: 'blueprint', style: 'max-width: 560px; padding: 28px;' }, corners().concat([
        h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 26px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Takk for bidraget' }),
        h('p', { style: 'margin: 12px 0 0; font-size: 15px; line-height: 22px;', text: doneMsg + ' Prisene er ført inn i leksikonet og teller med i månedens statistikk.' }),
        h('div', { style: 'display: flex; gap: 10px; margin-top: 20px;' }, [
          h('button', { type: 'button', cls: 'btn btn-primary', onClick: nav('home'), text: 'Til leksikonet' }),
          h('button', { type: 'button', cls: 'btn btn-ghost', onClick: resetScan, text: 'Skann en ny kvittering' })
        ])
      ]));
    }

    return h('section', { 'data-screen-label': 'Skann kvittering' }, [head, body]);
  }

  function centeredCard(children) {
    return h('div', { style: 'max-width: 1160px; margin: 0 auto; padding: 96px 24px;' }, [
      h('div', { cls: 'blueprint', style: 'max-width: 520px; padding: 28px;' }, corners().concat(children))
    ]);
  }
  function loadingScreen() {
    var frag = document.createDocumentFragment();
    frag.appendChild(renderNav('…'));
    frag.appendChild(centeredCard([
      h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 22px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Laster leksikonet …' }),
      h('p', { style: 'margin: 10px 0 0; font-size: 15px; color: ' + MUTED70 + ';', text: 'Henter fellesskapets priser.' })
    ]));
    return frag;
  }
  function errorScreen() {
    var frag = document.createDocumentFragment();
    frag.appendChild(renderNav('—'));
    frag.appendChild(centeredCard([
      h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 22px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Kunne ikke laste leksikonet' }),
      h('p', { style: 'margin: 10px 0 16px; font-size: 15px; color: ' + MUTED70 + ';', text: 'Vi fikk ikke kontakt med databasen. Sjekk nettforbindelsen og prøv igjen.' }),
      h('button', { type: 'button', cls: 'btn btn-primary', onClick: function () { setState({ phase: 'loading' }); boot(); }, text: 'Prøv igjen' })
    ]));
    return frag;
  }

  // ── Render + focus preservation across full re-render ────────────────────
  function captureFocus() {
    var a = document.activeElement;
    if (!a || !a.dataset || !a.dataset.focusId) return null;
    var info = { id: a.dataset.focusId };
    try { info.start = a.selectionStart; info.end = a.selectionEnd; } catch (e) { /* number/select inputs */ }
    return info;
  }
  function restoreFocus(info) {
    if (!info) return;
    var el = document.querySelector('[data-focus-id="' + info.id + '"]');
    if (!el) return;
    el.focus();
    if (info.start != null) { try { el.setSelectionRange(info.start, info.end); } catch (e) { /* noop */ } }
  }

  var root = document.getElementById('app');
  function render() {
    var focus = captureFocus();
    root.textContent = '';
    if (state.phase === 'loading') { root.appendChild(loadingScreen()); return; }
    if (state.phase === 'error') { root.appendChild(errorScreen()); return; }
    var v = homeVals();
    var frag = document.createDocumentFragment();
    frag.appendChild(renderNav(v.totalRegs));
    var container = h('div', { style: 'max-width: 1160px; margin: 0 auto; padding: 0 24px 96px;' });
    if (state.view === 'home') container.appendChild(renderHome(v));
    else if (state.view === 'product') container.appendChild(renderProduct());
    else if (state.view === 'scan') container.appendChild(renderScan());
    frag.appendChild(container);
    root.appendChild(frag);
    restoreFocus(focus);
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  function boot() {
    Promise.all([
      sb('/ml_stores?select=*&order=sort_order').then(function (r) { if (!r.ok) throw new Error('stores ' + r.status); return r.json(); }),
      sb('/ml_products?select=*&order=sort_order').then(function (r) { if (!r.ok) throw new Error('products ' + r.status); return r.json(); }),
      sb('/ml_monthly_prices?select=product_id,store_id,month_index,price&limit=2000').then(function (r) { if (!r.ok) throw new Error('prices ' + r.status); return r.json(); }),
      sb('/rpc/ml_total_regs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(function (r) { return r.ok ? r.json() : 0; })
    ]).then(function (out) {
      buildData(out[0], out[1], out[2]);
      state.bootTotal = Number(out[3]) || 0;
      state.phase = 'ready';
      route();
    }).catch(function (e) {
      state.phase = 'error'; state.errMsg = (e && e.message) || String(e);
      render();
    });
  }

  // Exposed for tests (pure helpers; no side effects).
  window.__ml = { parseReceiptText: parseReceiptText, detectStore: detectStore };

  window.addEventListener('hashchange', route);
  render();  // initial loading screen
  boot();
})();
