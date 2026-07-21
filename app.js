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

  function buildStores(rows) {
    STORES = rows.map(function (s) { return { id: s.id, name: s.name, color: s.color, dash: s.dash || '', places: s.places || [] }; });
    STORE_NAME = {}; STORE_STYLE = {};
    STORES.forEach(function (s) { STORE_NAME[s.id] = s.name; STORE_STYLE[s.id] = { color: s.color, dash: s.dash }; });
  }

  function buildGroups(offers) {
    OFFERS = offers || [];
    var today = new Date().toISOString().slice(0, 10);
    var valid = OFFERS.filter(function (o) { return !o.valid_until || o.valid_until >= today; });
    if (!valid.length) valid = OFFERS;
    VALID_COUNT = valid.length;
    var map = {};
    valid.forEach(function (o) {
      var key = o.group_key || (o.product_name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!key) return;
      var g = map[key] || (map[key] = { key: key, variants: {} });
      var st = o.store_id, price = Number(o.price);
      var prev = g.variants[st];
      if (!prev || price < prev.price) {
        g.variants[st] = {
          storeId: st, storeName: STORE_NAME[st] || st,
          color: (STORE_STYLE[st] || {}).color || 'var(--color-accent)', dash: (STORE_STYLE[st] || {}).dash || '',
          rawName: o.product_name, name: cleanName(o.product_name),
          price: price, prePrice: o.pre_price != null ? Number(o.pre_price) : null,
          unit: o.unit || null, image: o.image_url || null, validUntil: o.valid_until || null,
          isOffer: o.pre_price != null && Number(o.pre_price) > price
        };
      }
    });
    GROUPS = Object.keys(map).map(function (key) {
      var variants = Object.keys(map[key].variants).map(function (s) { return map[key].variants[s]; })
        .sort(function (a, b) { return a.price - b.price; });
      var img = null; for (var i = 0; i < variants.length; i++) { if (variants[i].image) { img = variants[i].image; break; } }
      return {
        key: key, name: variants[0] ? variants[0].name : key, variants: variants, image: img,
        minPrice: variants[0] ? variants[0].price : 0, storeCount: variants.length,
        onOffer: variants.some(function (v) { return v.isOffer; }),
        bestOff: variants.reduce(function (m, v) { return Math.max(m, pctOff(v)); }, 0),
        searchText: (variants.map(function (v) { return v.rawName; }).join(' ') + ' ' + key).toLowerCase()
      };
    });
    GROUP_BY_KEY = {}; GROUPS.forEach(function (g) { GROUP_BY_KEY[g.key] = g; });
  }

  // ── State ────────────────────────────────────────────────────────────────
  var state = {
    phase: 'loading', errMsg: '',
    view: 'home', groupKey: null, storeId: null, query: '', storeFilter: 'Alle',
    scanPhase: 'idle', scanStep: '', scanItems: [], scanStore: 'Kiwi', scanPlace: 'Kiwi Grünerløkka, Oslo',
    scanSubmitting: false, scanError: null, scanImageUrl: null, scanNote: null,
    doneCount: 0, doneMsgN: 0,
    history: {}, // key -> 'loading' | [rows]
    histPrice: '', histPre: '', histWeek: '', histSubmitting: false, histError: null, histMsg: null
  };
  function setState(patch) { Object.assign(state, patch); render(); }

  function nf(v) { return 'kr ' + Number(v).toFixed(2).replace('.', ','); }

  // ── Receipt OCR (Gemini vision Edge Function) — unchanged pipeline ────────
  var SCAN_FN_URL = SUPABASE_URL + '/functions/v1/ml-receipt-scan';
  var ADD_HIST_FN_URL = SUPABASE_URL + '/functions/v1/ml-add-history';

  // Monday of a given week, YYYY-MM-DD. offsetWeeks=0 → this week, 1 → last week.
  function mondayOf(offsetWeeks) {
    var d = new Date();
    d.setHours(12, 0, 0, 0);
    var day = (d.getDay() + 6) % 7; // 0 = Monday
    d.setDate(d.getDate() - day - (offsetWeeks || 0) * 7);
    return d.toISOString().slice(0, 10);
  }
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
          var nm = it.name || '';
          if (it.unit && it.quantity) nm = nm + ' (' + it.quantity + ' ' + it.unit + ')';
          return { name: nm, price: (it.price != null ? String(it.price) : '') };
        });
        var patch = { scanPhase: 'review', scanError: null };
        if (data.store) { patch.scanStore = data.store; var s = STORES.filter(function (x) { return x.name === data.store; })[0]; if (s) patch.scanPlace = s.places[0]; }
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

  function addHistoryPoint(g, v) {
    if (state.histSubmitting) return;
    var raw = String(state.histPrice == null ? '' : state.histPrice).replace(',', '.').trim();
    var price = raw === '' ? NaN : Number(raw);
    if (!(price > 0)) { setState({ histError: 'Skriv inn en gyldig pris.', histMsg: null }); return; }
    var preRaw = String(state.histPre == null ? '' : state.histPre).replace(',', '.').trim();
    var pre = preRaw === '' ? null : Number(preRaw);
    var week = state.histWeek || mondayOf(1);
    setState({ histSubmitting: true, histError: null, histMsg: null });
    fetch(ADD_HIST_FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
      body: JSON.stringify({ group_key: g.key, store_id: v.storeId, product_name: v.rawName, price: price, pre_price: (pre != null && !isNaN(pre)) ? pre : null, observed_at: week })
    })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }, function () { return { ok: res.ok, body: {} }; }); })
      .then(function (r) {
        if (!r.ok) { setState({ histSubmitting: false, histError: (r.body && r.body.error) || 'Kunne ikke lagre prispunktet.' }); return; }
        delete state.history[g.key];
        setState({ histSubmitting: false, histPrice: '', histPre: '', histError: null, histMsg: 'Lagret: ' + nf(price) + ' hos ' + v.storeName + ' (uke fra ' + week + '). Grafen er oppdatert.' });
        loadHistory(g.key);
      })
      .catch(function () { setState({ histSubmitting: false, histError: 'Nettverksfeil. Prøv igjen.' }); });
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
      if (state.groupKey !== r.groupKey || state.storeId !== r.storeId) {
        state.histPrice = ''; state.histPre = ''; state.histWeek = ''; state.histError = null; state.histMsg = null;
      }
      state.view = 'vare'; state.groupKey = r.groupKey; state.storeId = r.storeId;
      loadHistory(r.groupKey);
    } else if (r.view === 'scan') {
      state.view = 'scan';
    } else {
      state.view = 'home';
    }
    render();
  }
  var HASH_FOR = { home: '#/', scan: '#/skann' };
  function go(hash) { if (location.hash === hash || (hash === '#/' && !location.hash)) route(); else location.hash = hash; }
  function nav(view) { return function (e) { if (e && e.preventDefault) e.preventDefault(); go(HASH_FOR[view] || '#/'); window.scrollTo(0, 0); }; }
  function openGroup(key) { return function () { go('#/gruppe/' + encodeURIComponent(key)); window.scrollTo(0, 0); }; }
  function openVariant(key, store) { return function () { go('#/vare/' + encodeURIComponent(key) + '/' + encodeURIComponent(store)); window.scrollTo(0, 0); }; }

  function loadHistory(key) {
    if (state.history[key]) return;
    state.history[key] = 'loading';
    sb('/ml_price_history?select=store_id,price,pre_price,is_offer,observed_at&group_key=eq.' + encodeURIComponent(key) + '&order=observed_at.asc')
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

  function renderNav() {
    return h('nav', { cls: 'nav', 'data-screen-label': 'Topplinje', style: 'padding-inline: max(24px, calc((100% - 1160px) / 2 + 24px));' }, [
      h('span', { cls: 'nav-brand', onClick: nav('home'), style: 'cursor: pointer;', text: 'Prisboka' }),
      h('a', { href: '#/', onClick: nav('home'), text: 'Leksikon' }),
      h('a', { href: '#/skann', onClick: nav('scan'), text: 'Bidra med priser' }),
      h('span', { style: 'flex: 1;' }),
      h('span', { style: 'font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; color: ' + MUTED70 + "; font-feature-settings: 'tnum' 1;", text: VALID_COUNT + ' ekte priser · oppdatert ukentlig' }),
      h('button', { type: 'button', cls: 'btn btn-primary', onClick: nav('scan'), text: 'Skann kvittering' })
    ]);
  }

  // ── Home ─────────────────────────────────────────────────────────────────
  function renderHome() {
    var q = state.query.trim().toLowerCase();
    var sf = state.storeFilter || 'Alle';
    var filtered = GROUPS.filter(function (g) {
      if (sf !== 'Alle' && !g.variants.some(function (v) { return v.storeName === sf; })) return false;
      if (q && g.searchText.indexOf(q) === -1) return false;
      return true;
    }).sort(function (a, b) { return (b.onOffer - a.onOffer) || a.name.localeCompare(b.name, 'nb'); });
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
          return h('div', { cls: 'blueprint card-hover', onClick: openGroup(o.g.key), style: 'padding: 0; cursor: pointer; display: flex; flex-direction: column;' }, corners().concat([
            imgBox(v.image, v.name, '150px'),
            h('div', { style: 'padding: 14px 16px; display: flex; flex-direction: column; gap: 6px;' }, [
              h('div', { style: 'display: flex; justify-content: space-between; align-items: center; gap: 8px;' }, [
                h('span', { cls: 'tag tag-outline', text: v.storeName }),
                h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 15px; color: var(--color-accent-900);', text: '−' + pctOff(v) + ' %' })
              ]),
              h('span', { style: NAME_STYLE, text: v.name }),
              h('div', { style: 'display: flex; align-items: baseline; gap: 8px;' }, [
                h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 24px; font-feature-settings: 'tnum' 1;", text: nf(v.price) }),
                v.prePrice ? h('span', { style: "font-size: 13px; color: " + MUTED60 + "; text-decoration: line-through; font-feature-settings: 'tnum' 1;", text: nf(v.prePrice) }) : null
              ])
            ])
          ]));
        }))
      ]);
    }

    var chips = h('div', { style: 'display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 32px;' }, ['Alle', 'Rema 1000', 'Kiwi', 'Extra', 'Meny'].map(function (c) {
      return h('button', { type: 'button', cls: 'btn ' + (c === sf ? 'btn-primary' : 'btn-ghost'), onClick: function () { setState({ storeFilter: c }); }, style: 'min-height: 34px; padding: 4px 14px; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase;', text: c });
    }));

    var grid = h('div', { style: 'display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 32px;' }, shown.map(function (g) {
      var priceTxt = g.storeCount > 1 ? 'fra ' + nf(g.minPrice) : nf(g.minPrice);
      var whereTxt = g.storeCount > 1 ? 'hos ' + g.storeCount + ' butikker' : g.variants[0].storeName;
      return h('div', { cls: 'blueprint card-hover', onClick: openGroup(g.key), style: 'padding: 0; cursor: pointer; display: flex; flex-direction: column;' }, corners().concat([
        imgBox(g.image, g.name, '150px'),
        h('div', { style: 'padding: 16px 18px 18px; display: flex; flex-direction: column; gap: 6px;' }, [
          h('div', { style: 'display: flex; gap: 8px; align-items: center; min-height: 20px;' }, [
            g.onOffer ? offerTag() : h('span', { style: 'font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600; color: ' + MUTED60 + ';', text: whereTxt })
          ]),
          h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 22px; line-height: 1.1; letter-spacing: 0.02em; text-transform: uppercase;', text: g.name }),
          h('div', { style: 'display: flex; align-items: baseline; gap: 10px; margin-top: 6px;' }, [
            h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 24px; font-feature-settings: 'tnum' 1;", text: priceTxt })
          ]),
          h('span', { style: 'font-size: 13px; color: ' + MUTED60 + ';', text: g.storeCount > 1 ? whereTxt : (g.onOffer ? whereTxt : '') })
        ])
      ]));
    }));

    var catalog = h('div', {}, [
      h('span', { style: KICKER, text: q ? 'Treff i leksikonet (' + filtered.length + ')' : (bestSection ? '02 · Hele leksikonet (' + filtered.length + ' varer)' : 'Hele leksikonet (' + filtered.length + ' varer)') }),
      h('hr', { style: 'height: 1px; border: 0; margin: 0 0 20px; background: var(--color-divider);' }),
      chips, grid,
      filtered.length > CAP ? h('p', { style: 'margin-top: 24px; font-size: 14px; color: ' + MUTED70 + ';', text: 'Viser de første ' + CAP + ' av ' + filtered.length + ' varer — søk for å finne flere.' }) : null,
      filtered.length === 0 ? h('p', { style: 'font-size: 15px; color: ' + MUTED70 + ';', text: 'Ingen treff på «' + state.query + '». Prøv et annet søk, eller bidra med priser ved å skanne en kvittering.' }) : null
    ]);

    return h('section', { 'data-screen-label': 'Hovedside' }, [hero, bestSection, catalog]);
  }

  // ── Group page: similar products + where sold ────────────────────────────
  function renderGroup() {
    var g = GROUP_BY_KEY[state.groupKey];
    if (!g) { go('#/'); return h('div'); }
    var head = h('div', { style: 'padding: 40px 0 24px; display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start;' }, [
      h('div', { style: 'flex: 1; min-width: 260px;' }, [
        h('a', { href: '#/', onClick: nav('home'), style: 'font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;', text: '← Tilbake til leksikonet' }),
        h('div', { style: 'display: flex; flex-wrap: wrap; align-items: baseline; gap: 16px; margin-top: 20px;' }, [
          h('h1', { style: H1, text: g.name }),
          g.onOffer ? offerTag() : null
        ]),
        h('p', { style: 'margin: 12px 0 0; font-size: 15px; color: ' + MUTED70 + ';', text: g.storeCount > 1 ? ('Selges hos ' + g.storeCount + ' butikker · billigst ' + nf(g.minPrice)) : ('Selges hos ' + g.variants[0].storeName + ' · ' + nf(g.minPrice)) })
      ]),
      g.image ? h('div', { cls: 'blueprint', style: 'flex: none; width: 190px; height: 190px; background: #fff; display: flex; align-items: center; justify-content: center; overflow: hidden;' }, corners().concat([
        h('img', { src: g.image, alt: g.name, style: 'max-width: 82%; max-height: 82%; object-fit: contain; mix-blend-mode: multiply;' })
      ])) : null
    ]);

    var rows = g.variants.map(function (v) {
      var vu = v.validUntil ? 'Gyldig til ' + v.validUntil.slice(8, 10) + '.' + v.validUntil.slice(5, 7) : '';
      return h('div', { cls: 'row-hover', onClick: openVariant(g.key, v.storeId), style: 'display: grid; grid-template-columns: 1fr auto auto; gap: 12px; align-items: center; cursor: pointer; padding: 14px 20px; border-bottom: 1px solid color-mix(in srgb, var(--color-text) 8%, transparent);' }, [
        h('span', { style: 'display: flex; align-items: center; gap: 12px;' }, [
          storeLine(v.color, v.dash, 18),
          h('span', {}, [
            h('span', { style: NAME_STYLE, text: v.storeName }),
            h('span', { style: 'display: block; font-size: 13px; color: ' + MUTED60 + ';', text: v.rawName + (vu ? ' · ' + vu : '') })
          ])
        ]),
        v.isOffer ? h('span', { cls: 'tag tag-outline', text: '−' + pctOff(v) + ' %' }) : h('span'),
        h('span', { style: 'display: flex; align-items: baseline; gap: 8px; justify-content: flex-end;' }, [
          v.prePrice ? h('span', { style: "font-size: 13px; color: " + MUTED60 + "; text-decoration: line-through; font-feature-settings: 'tnum' 1;", text: nf(v.prePrice) }) : null,
          h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 22px; font-feature-settings: 'tnum' 1; white-space: nowrap;", text: nf(v.price) + (v.unit ? '/' + v.unit : '') })
        ])
      ]);
    });

    var table = h('div', {}, [
      h('span', { style: KICKER, text: '01 · Selges hos' }),
      h('hr', { style: RULE }),
      h('div', { cls: 'blueprint', style: 'padding: 0;' }, corners().concat(rows)),
      h('p', { style: 'margin: 16px 0 0; font-size: 13px; color: ' + MUTED60 + ';', text: 'Trykk på en butikk for å se prishistorikk. Kilde: tilbudsaviser (eTilbudsavis).' })
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
    if (!g) { go('#/'); return h('div'); }
    var v = g.variants.filter(function (x) { return x.storeId === state.storeId; })[0] || g.variants[0];

    var head = h('div', { style: 'padding: 40px 0 24px; display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start;' }, [
      h('div', { style: 'flex: 1; min-width: 260px;' }, [
        h('a', { href: '#/gruppe/' + encodeURIComponent(g.key), onClick: function (e) { e.preventDefault(); openGroup(g.key)(); }, style: 'font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;', text: '← ' + g.name }),
        h('div', { style: 'display: flex; flex-wrap: wrap; align-items: baseline; gap: 16px; margin-top: 20px;' }, [
          h('h1', { style: H1, text: v.storeName }),
          v.isOffer ? offerTag() : null
        ]),
        h('p', { style: 'margin: 12px 0 0; font-size: 15px; color: ' + MUTED70 + ';', text: v.rawName + (v.validUntil ? ' · gyldig til ' + v.validUntil.slice(8, 10) + '.' + v.validUntil.slice(5, 7) : '') }),
        h('div', { style: 'display: flex; align-items: baseline; gap: 12px; margin-top: 14px;' }, [
          h('span', { style: "font-family: var(--font-heading); font-weight: 600; font-size: 40px; font-feature-settings: 'tnum' 1;", text: nf(v.price) + (v.unit ? '/' + v.unit : '') }),
          v.prePrice ? h('span', { style: "font-size: 16px; color: " + MUTED60 + "; text-decoration: line-through; font-feature-settings: 'tnum' 1;", text: nf(v.prePrice) }) : null
        ])
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

    // ── Add a known earlier price ──────────────────────────────────────────
    var defaultWeek = state.histWeek || mondayOf(1);
    var weekOpts = [{ v: mondayOf(0), label: mondayOf(0) + ' (denne uka)' }];
    for (var wi = 1; wi <= 9; wi++) weekOpts.push({ v: mondayOf(wi), label: mondayOf(wi) + (wi === 1 ? ' (forrige uke)' : '') });
    var labelStyle = 'display: block; font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; color: ' + MUTED70 + '; margin-bottom: 6px;';
    var histForm = h('div', { cls: 'blueprint', style: 'padding: 24px;' }, corners().concat([
      h('p', { style: 'margin: 0 0 4px; font-size: 15px; line-height: 22px; max-width: 62ch;', text: 'Vet du hva ' + v.storeName + ' tok for «' + v.rawName + '» en tidligere uke? Legg det inn som et målepunkt, så vises det i grafen over.' }),
      h('div', { style: 'display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; margin-top: 18px;' }, [
        h('label', { style: 'flex: 1 1 200px;' }, [
          h('span', { style: labelStyle, text: 'Uke' }),
          h('select', { cls: 'input', style: 'min-height: 40px; width: 100%;', value: defaultWeek, onChange: function (e) { setState({ histWeek: e.target.value }); } },
            weekOpts.map(function (o) { return h('option', { value: o.v, selected: o.v === defaultWeek ? 'selected' : false, text: o.label }); }))
        ]),
        h('label', { style: 'flex: 0 1 130px;' }, [
          h('span', { style: labelStyle, text: 'Pris (kr)' }),
          h('input', { cls: 'input', type: 'number', step: '0.1', min: '0', 'data-focus-id': 'hist-price', style: "min-height: 40px; width: 100%; text-align: right; font-feature-settings: 'tnum' 1;", value: state.histPrice, onInput: function (e) { setState({ histPrice: e.target.value }); } })
        ]),
        h('label', { style: 'flex: 0 1 150px;' }, [
          h('span', { style: labelStyle, text: 'Førpris (valgfri)' }),
          h('input', { cls: 'input', type: 'number', step: '0.1', min: '0', 'data-focus-id': 'hist-pre', style: "min-height: 40px; width: 100%; text-align: right; font-feature-settings: 'tnum' 1;", value: state.histPre, onInput: function (e) { setState({ histPre: e.target.value }); } })
        ]),
        h('button', { type: 'button', cls: 'btn btn-primary', style: 'min-height: 40px;', disabled: state.histSubmitting ? 'disabled' : false, onClick: function () { addHistoryPoint(g, v); }, text: state.histSubmitting ? 'Lagrer …' : 'Legg til' })
      ]),
      state.histError ? h('p', { style: 'margin: 14px 0 0; font-size: 13px; color: var(--color-accent-800); font-weight: 600;', text: state.histError }) : null,
      state.histMsg ? h('p', { style: 'margin: 14px 0 0; font-size: 13px; color: ' + MUTED78 + ';', text: state.histMsg }) : null,
      h('p', { style: 'margin: 14px 0 0; font-size: 12px; color: ' + MUTED60 + ';', text: 'Førpris fyller du bare ut hvis prisen den uka var et tilbud.' })
    ]));

    return h('section', { 'data-screen-label': 'Produktside' }, [head,
      h('div', {}, [h('span', { style: KICKER, text: '01 · Prishistorikk' }), h('hr', { style: RULE }), chartBlock]),
      h('div', { style: 'margin-top: 40px;' }, [h('span', { style: KICKER, text: '02 · Legg til en tidligere pris' }), h('hr', { style: RULE }), histForm])
    ]);
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
            var s = STORES.filter(function (x) { return x.name === e.target.value; })[0];
            setState({ scanStore: e.target.value, scanPlace: s ? s.places[0] : state.scanPlace });
          } }, STORES.map(function (s) { return h('option', { value: s.name, selected: s.name === state.scanStore ? 'selected' : false, text: s.name }); }))
        ]),
        h('label', { style: 'display: flex; flex-direction: column; gap: 6px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;' }, [
          'Sted',
          h('input', { cls: 'input', 'data-focus-id': 'scan-place', style: 'min-height: 38px; min-width: 220px;', value: state.scanPlace, onInput: function (e) { setState({ scanPlace: e.target.value }); } })
        ])
      ]);
      var rows = h('div', { style: 'display: flex; flex-direction: column; gap: 8px;' }, state.scanItems.map(function (it, i) {
        return h('div', { style: 'display: grid; grid-template-columns: 1fr 120px 38px; gap: 10px; align-items: center;' }, [
          h('input', { cls: 'input', 'aria-label': 'Varenavn', 'data-focus-id': 'scan-name-' + i, style: 'min-height: 38px;', value: it.name, onInput: function (e) { var items = state.scanItems.slice(); items[i] = Object.assign({}, items[i], { name: e.target.value }); setState({ scanItems: items }); } }),
          h('input', { cls: 'input', type: 'number', step: '0.1', 'aria-label': 'Pris i kroner', 'data-focus-id': 'scan-price-' + i, style: "min-height: 38px; text-align: right; font-feature-settings: 'tnum' 1;", value: it.price, onInput: function (e) { var items = state.scanItems.slice(); items[i] = Object.assign({}, items[i], { price: e.target.value }); setState({ scanItems: items }); } }),
          h('button', { type: 'button', cls: 'btn btn-ghost btn-icon', 'aria-label': 'Fjern varelinje', style: 'min-height: 38px;', onClick: function () { setState({ scanItems: state.scanItems.filter(function (x, j) { return j !== i; }) }); }, text: '✕' })
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
        h('p', { style: 'margin: 12px 0 0; font-size: 15px; line-height: 22px;', text: doneMsg + ' Prisene er lagret i databasen.' }),
        h('div', { style: 'display: flex; gap: 10px; margin-top: 20px;' }, [
          h('button', { type: 'button', cls: 'btn btn-primary', onClick: nav('home'), text: 'Til leksikonet' }),
          h('button', { type: 'button', cls: 'btn btn-ghost', onClick: resetScan, text: 'Skann en ny kvittering' })
        ])
      ]));
    }
    return h('section', { 'data-screen-label': 'Skann kvittering' }, [head, body]);
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

  var root = document.getElementById('app');
  function render() {
    var focus = captureFocus();
    root.textContent = '';
    if (state.phase === 'loading') { root.appendChild(loadingScreen()); return; }
    if (state.phase === 'error') { root.appendChild(errorScreen()); return; }
    var frag = document.createDocumentFragment();
    frag.appendChild(renderNav());
    var container = h('div', { style: 'max-width: 1160px; margin: 0 auto; padding: 0 24px 96px;' });
    if (state.view === 'gruppe') container.appendChild(renderGroup());
    else if (state.view === 'vare') container.appendChild(renderVariant());
    else if (state.view === 'scan') container.appendChild(renderScan());
    else container.appendChild(renderHome());
    frag.appendChild(container);
    root.appendChild(frag);
    restoreFocus(focus);
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  // PostgREST caps a response at 1000 rows, so page through all offers.
  var OFFER_COLS = 'store_id,product_name,group_key,price,pre_price,unit,image_url,valid_from,valid_until,source';
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
  function boot() {
    Promise.all([
      sb('/ml_stores?select=*&order=sort_order').then(function (r) { if (!r.ok) throw new Error('stores ' + r.status); return r.json(); }),
      fetchAllOffers()
    ]).then(function (out) {
      buildStores(out[0]);
      buildGroups(out[1]);
      state.phase = 'ready';
      route();
    }).catch(function (e) {
      state.phase = 'error'; state.errMsg = (e && e.message) || String(e);
      render();
    });
  }

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
})();
