/*
 * Prisboka — Matvareleksikon med pristrender
 * ------------------------------------------------------------------
 * Runnable, dependency-free implementation of the Claude Design prototype
 * `design/Matvareleksikon.dc.html`. The original ran on the `dc-runtime`
 * (React + an `x-dc` template interpreter). This file ports the same data
 * model, computations and interactions to plain JavaScript and renders the
 * three screens (home / product / scan) directly into #app, using the
 * "Industry" design system (styles.css) unchanged.
 *
 * The state shape, STORES/PRODUCTS data, priceAt()/chartFor()/scanReceipt()
 * and the value derivations mirror the prototype's `Component` class 1:1, so
 * numbers and behaviour match the design.
 */
(function () {
  "use strict";

  // ── Static data (verbatim from the prototype) ────────────────────────────
  var STORES = [
    { name: 'Rema 1000', mul: 0.97, color: 'var(--color-accent-900)', dash: '', places: ['Rema 1000 Torshov, Oslo', 'Rema 1000 Lade, Trondheim', 'Rema 1000 Danmarksplass, Bergen'] },
    { name: 'Kiwi', mul: 0.96, color: 'var(--color-accent-600)', dash: '', places: ['Kiwi Grünerløkka, Oslo', 'Kiwi Bryn, Oslo', 'Kiwi Solsiden, Trondheim'] },
    { name: 'Extra', mul: 0.99, color: 'var(--color-accent-400)', dash: '6 4', places: ['Extra Storo, Oslo', 'Extra Lagunen, Bergen', 'Extra Byåsen, Trondheim'] },
    { name: 'Meny', mul: 1.13, color: 'var(--color-text)', dash: '2 4', places: ['Meny Majorstuen, Oslo', 'Meny Bergen Storsenter', 'Meny Solsiden, Trondheim'] }
  ];
  var MONTHS = ['aug', 'sep', 'okt', 'nov', 'des', 'jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul'];
  var PRODUCTS = [
    { id: 'melk', name: 'Lettmelk', unit: '1 l, 1,0 % fett', cat: 'Meieri', base: 24.9, trend: 0.09 },
    { id: 'brod', name: 'Grovbrød', unit: '750 g, hel', cat: 'Bakevarer', base: 42.0, trend: 0.06 },
    { id: 'egg', name: 'Egg', unit: '12 stk, frittgående', cat: 'Meieri', base: 54.9, trend: 0.14 },
    { id: 'smor', name: 'Smør', unit: '500 g, meierismør', cat: 'Meieri', base: 66.0, trend: 0.07 },
    { id: 'norvegia', name: 'Norvegia', unit: '1 kg, skorpefri', cat: 'Meieri', base: 139.0, trend: 0.05 },
    { id: 'banan', name: 'Bananer', unit: 'per kg', cat: 'Frukt og grønt', base: 26.5, trend: -0.08 },
    { id: 'tomat', name: 'Tomater', unit: 'per kg, klase', cat: 'Frukt og grønt', base: 44.9, trend: -0.12 },
    { id: 'potet', name: 'Poteter', unit: '2,5 kg, mandel', cat: 'Frukt og grønt', base: 39.9, trend: 0.03 },
    { id: 'kaffe', name: 'Kaffe, filtermalt', unit: '250 g', cat: 'Tørrvarer', base: 62.9, trend: 0.18 },
    { id: 'pasta', name: 'Spagetti', unit: '500 g', cat: 'Tørrvarer', base: 18.9, trend: -0.04 },
    { id: 'ris', name: 'Jasminris', unit: '1 kg', cat: 'Tørrvarer', base: 36.9, trend: 0.02 },
    { id: 'havregryn', name: 'Havregryn', unit: '1 kg, lettkokte', cat: 'Tørrvarer', base: 23.9, trend: -0.03 },
    { id: 'kjottdeig', name: 'Kjøttdeig', unit: '400 g, 14 % fett', cat: 'Kjøtt og fisk', base: 66.9, trend: 0.11 },
    { id: 'laks', name: 'Laksefilet', unit: '4 × 125 g', cat: 'Kjøtt og fisk', base: 132.0, trend: 0.16 },
    { id: 'kylling', name: 'Kyllingfilet', unit: '550 g', cat: 'Kjøtt og fisk', base: 109.0, trend: 0.04 },
    { id: 'pizza', name: 'Frossenpizza', unit: '575 g, familie', cat: 'Frysevarer', base: 56.9, trend: -0.06 },
    { id: 'cola', name: 'Cola', unit: '1,5 l, inkl. pant', cat: 'Drikke', base: 36.9, trend: 0.08 },
    { id: 'appelsinjuice', name: 'Appelsinjuice', unit: '1 l, uten fruktkjøtt', cat: 'Drikke', base: 32.9, trend: 0.21 }
  ];
  PRODUCTS.forEach(function (p, i) { p.seed = i + 1; p.regs = 140 + ((i * 97) % 340); });

  // ── Component state ──────────────────────────────────────────────────────
  var state = {
    view: 'home', productId: null, query: '', cat: 'Alle',
    scanPhase: 'idle', scanPct: 0, scanStep: '', scanItems: [],
    scanStore: 'Kiwi', scanPlace: 'Kiwi Grünerløkka, Oslo',
    doneCount: 0, doneMsgN: 0,
    chartMonths: 12 // prototype prop `chartMonths` (enum 6|12, default 12)
  };
  var timers = [];

  function setState(patch) {
    Object.assign(state, patch);
    render();
  }

  // ── Computations (verbatim math) ─────────────────────────────────────────
  function priceAt(p, si, m) {
    var s = STORES[si];
    var noise = 0.025 * Math.sin(m * 1.7 + p.seed * 2.3 + si) + 0.015 * Math.sin(m * 0.9 + si * 4 + p.seed);
    var v = p.base * s.mul * (1 + p.trend * (m / 11)) * (1 + noise);
    return Math.round(v * 10) / 10;
  }
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
    for (si = 0; si < 4; si++) for (m = start; m < 12; m++) { v = priceAt(p, si, m); lo = Math.min(lo, v); hi = Math.max(hi, v); }
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
  function scanReceipt() {
    timers.forEach(clearTimeout); timers = [];
    setState({ scanPhase: 'scanning', scanPct: 0, scanStep: 'Retter opp bildet …' });
    var steps = [[30, 'Retter opp bildet …'], [62, 'Finner varelinjene …'], [88, 'Matcher mot leksikonet …'], [100, 'Ferdig']];
    steps.forEach(function (step, i) {
      timers.push(setTimeout(function () {
        if (step[0] === 100) {
          setState({ scanPhase: 'review', scanItems: [
            { name: 'Lettmelk 1 l', price: '23.90' }, { name: 'Grovbrød 750 g', price: '44.90' },
            { name: 'Bananer 1,04 kg', price: '27.60' }, { name: 'Egg 12 stk', price: '56.90' },
            { name: 'Kaffe filtermalt 250 g', price: '69.90' } ] });
        } else {
          setState({ scanPct: step[0], scanStep: step[1] });
        }
      }, 500 + i * 650));
    });
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

  // ── Derived values, mirroring the prototype's renderVals() ───────────────
  function open(id) { return function () { setState({ view: 'product', productId: id }); window.scrollTo(0, 0); }; }
  function nav(view) { return function (e) { if (e && e.preventDefault) e.preventDefault(); setState({ view: view }); window.scrollTo(0, 0); }; }

  function homeVals() {
    var q = state.query.trim().toLowerCase();
    var cat = state.cat || 'Alle';
    var filtered = PRODUCTS.filter(function (p) {
      return (cat === 'Alle' || p.cat === cat) && (!q || (p.name + ' ' + p.cat + ' ' + p.unit).toLowerCase().indexOf(q) !== -1);
    }).map(function (p) {
      var prices = STORES.map(function (s, si) { return priceAt(p, si, 11); });
      var avgNow = prices.reduce(function (a, b) { return a + b; }) / 4;
      var avgPrev = STORES.map(function (s, si) { return priceAt(p, si, 10); }).reduce(function (a, b) { return a + b; }) / 4;
      return { name: p.name, cat: p.cat, unit: p.unit, regs: p.regs, from: 'fra ' + nf(Math.min.apply(null, prices)), pct: fmtPct((avgNow / avgPrev - 1) * 100), open: open(p.id) };
    });
    var changes = PRODUCTS.map(function (p) {
      var now = STORES.map(function (s, si) { return priceAt(p, si, 11); }).reduce(function (a, b) { return a + b; }) / 4;
      var prev = STORES.map(function (s, si) { return priceAt(p, si, 10); }).reduce(function (a, b) { return a + b; }) / 4;
      return { p: p, pct: (now / prev - 1) * 100, now: now, prev: prev };
    }).sort(function (a, b) { return b.pct - a.pct; });
    var mkChange = function (c, i) { return { idx: '0' + (i + 1), name: c.p.name, unit: c.p.unit, fromTo: nf(c.prev) + ' → ' + nf(c.now), pct: fmtPct(c.pct), open: open(c.p.id) }; };
    var uniqueCats = ['Alle']; PRODUCTS.forEach(function (p) { if (uniqueCats.indexOf(p.cat) === -1) uniqueCats.push(p.cat); });
    return {
      totalRegs: (PRODUCTS.reduce(function (a, p) { return a + p.regs; }, 0) + state.doneCount).toLocaleString('nb-NO').replace(/\s/g, ' '),
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

  function renderNav(v) {
    return h('nav', { cls: 'nav', 'data-screen-label': 'Topplinje', style: 'padding-inline: max(24px, calc((100% - 1160px) / 2 + 24px));' }, [
      h('span', { cls: 'nav-brand', onClick: nav('home'), style: 'cursor: pointer;', text: 'Prisboka' }),
      h('a', { href: '#', onClick: nav('home'), text: 'Leksikon' }),
      h('a', { href: '#', onClick: nav('scan'), text: 'Bidra med priser' }),
      h('span', { style: 'flex: 1;' }),
      h('span', { style: 'font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; color: ' + MUTED70 + "; font-feature-settings: 'tnum' 1;", text: v.totalRegs + ' priser · fellesskapsregistrert' }),
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
        'Hver pris i boka er sett på en hylle og registrert av noen som handlet der. Søk opp en vare, se hva den koster hos Rema 1000, Kiwi, Extra og Meny — og hvor prisen er på vei.'
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
        h('a', { href: '#', onClick: nav('scan'), text: 'Skann kvitteringen' }),
        ' og legg den til.'
      ]) : null
    ]);

    return h('section', { 'data-screen-label': 'Hovedside' }, [hero, changes, catalog]);
  }

  function renderProduct() {
    var p = PRODUCTS.filter(function (x) { return x.id === state.productId; })[0];
    if (!p) { setState({ view: 'home' }); return h('div'); }
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
      h('a', { href: '#', onClick: nav('home'), style: 'font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;', text: '← Tilbake til leksikonet' }),
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
      h('div', { cls: 'blueprint', style: 'padding: 0;' }, corners().concat([tableHeader]).concat(tableRows))
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
      var fileInput = h('input', { type: 'file', accept: 'image/*,.pdf', style: 'display: none;', onChange: function () { scanReceipt(); } });
      var uploadCard = h('div', { cls: 'blueprint', style: 'padding: 28px; display: flex; flex-direction: column; gap: 12px;' }, corners().concat([
        h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 24px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Last opp bilde' }),
        h('p', { style: 'margin: 0; font-size: 15px; line-height: 22px; color: ' + MUTED78 + ';', text: 'Velg et foto av kvitteringen fra enheten din. JPG, PNG eller PDF.' }),
        h('label', { cls: 'btn btn-primary', style: 'align-self: flex-start; cursor: pointer; margin-top: 8px;' }, ['Velg fil', fileInput])
      ]));
      var cameraCard = h('div', { cls: 'blueprint', style: 'padding: 28px; display: flex; flex-direction: column; gap: 12px;' }, corners().concat([
        h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 24px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Bruk kameraet' }),
        h('p', { style: 'margin: 0; font-size: 15px; line-height: 22px; color: ' + MUTED78 + ';', text: 'Ta bilde av kvitteringen direkte. Hold den flatt og i godt lys.' }),
        h('button', { type: 'button', cls: 'btn btn-ghost', onClick: function () { setState({ scanPhase: 'camera' }); }, style: 'align-self: flex-start; margin-top: 8px;', text: 'Åpne kamera' })
      ]));
      body = h('div', { style: 'display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 40px; max-width: 820px;' }, [uploadCard, cameraCard]);
    } else if (state.scanPhase === 'camera') {
      body = h('div', { cls: 'blueprint', style: 'max-width: 520px; padding: 24px;' }, corners().concat([
        h('div', { style: 'position: relative; aspect-ratio: 3 / 4; background: var(--color-accent-900); display: flex; align-items: center; justify-content: center; overflow: hidden;' }, [
          h('div', { style: 'position: absolute; inset: 16px; border: 1px dashed color-mix(in srgb, var(--color-bg) 60%, transparent);' }),
          h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 20px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-bg); opacity: 0.75;', text: 'Søker — hold kvitteringen i ro' }),
          h('div', { style: 'position: absolute; left: 16px; right: 16px; height: 2px; background: color-mix(in srgb, var(--color-bg) 80%, transparent); animation: scanline 2.6s ease-in-out infinite;' })
        ]),
        h('div', { style: 'display: flex; gap: 10px; margin-top: 16px;' }, [
          h('button', { type: 'button', cls: 'btn btn-primary', onClick: function () { scanReceipt(); }, text: 'Ta bilde' }),
          h('button', { type: 'button', cls: 'btn btn-ghost', onClick: function () { setState({ scanPhase: 'idle', scanItems: [] }); }, text: 'Avbryt' })
        ]),
        h('p', { style: 'margin: 12px 0 0; font-size: 13px; color: ' + MUTED60 + ';', text: 'Kameraet er simulert i denne prototypen.' })
      ]));
    } else if (state.scanPhase === 'scanning') {
      body = h('div', { cls: 'blueprint', style: 'max-width: 520px; padding: 28px;' }, corners().concat([
        h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 22px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Leser kvitteringen …' }),
        h('p', { style: 'margin: 10px 0 16px; font-size: 15px; color: ' + MUTED78 + ';', text: state.scanStep }),
        h('div', { style: 'height: 4px; background: var(--color-accent-200);' }, [
          h('div', { style: 'height: 100%; background: var(--color-accent); width: ' + state.scanPct + '%;' })
        ])
      ]));
    } else if (state.scanPhase === 'review') {
      var controls = h('div', { style: 'display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end;' }, [
        h('label', { style: 'display: flex; flex-direction: column; gap: 6px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 600;' }, [
          'Butikk',
          h('select', { cls: 'input', 'data-focus-id': 'scan-store', style: 'min-height: 38px; min-width: 180px;', value: state.scanStore, onChange: function (e) {
            var s = STORES.filter(function (x) { return x.name === e.target.value; })[0];
            setState({ scanStore: e.target.value, scanPlace: s ? s.places[0] : state.scanPlace });
          } }, ['Rema 1000', 'Kiwi', 'Extra', 'Meny'].map(function (nm) {
            return h('option', { value: nm, selected: nm === state.scanStore ? 'selected' : false, text: nm });
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
      var actions = h('div', { style: 'display: flex; gap: 10px; align-items: center;' }, [
        h('button', { type: 'button', cls: 'btn btn-primary', onClick: function () {
          setState({ scanPhase: 'done', doneCount: state.doneCount + state.scanItems.length, doneMsgN: state.scanItems.length });
        }, text: 'Legg til ' + state.scanItems.length + ' priser i databasen' }),
        h('button', { type: 'button', cls: 'btn btn-ghost', onClick: function () { setState({ scanPhase: 'idle', scanItems: [] }); }, text: 'Forkast' })
      ]);
      body = h('div', { style: 'max-width: 820px;' }, [
        h('span', { style: KICKER, text: 'Kontroller varelinjene' }),
        h('hr', { style: RULE }),
        h('div', { cls: 'blueprint', style: 'padding: 24px; display: flex; flex-direction: column; gap: 16px;' }, corners().concat([controls, rows, actions]))
      ]);
    } else if (state.scanPhase === 'done') {
      var doneMsg = (state.doneMsgN || state.scanItems.length) + ' priser registrert ved ' + state.scanPlace + '.';
      body = h('div', { cls: 'blueprint', style: 'max-width: 560px; padding: 28px;' }, corners().concat([
        h('span', { style: 'font-family: var(--font-heading); font-weight: 600; font-size: 26px; letter-spacing: 0.02em; text-transform: uppercase;', text: 'Takk for bidraget' }),
        h('p', { style: 'margin: 12px 0 0; font-size: 15px; line-height: 22px;', text: doneMsg + ' Prisene er ført inn i leksikonet og teller med i månedens statistikk.' }),
        h('div', { style: 'display: flex; gap: 10px; margin-top: 20px;' }, [
          h('button', { type: 'button', cls: 'btn btn-primary', onClick: nav('home'), text: 'Til leksikonet' }),
          h('button', { type: 'button', cls: 'btn btn-ghost', onClick: function () { setState({ scanPhase: 'idle', scanItems: [] }); }, text: 'Skann en ny kvittering' })
        ])
      ]));
    }

    return h('section', { 'data-screen-label': 'Skann kvittering' }, [head, body]);
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
    var v = homeVals();
    var frag = document.createDocumentFragment();
    frag.appendChild(renderNav(v));
    var container = h('div', { style: 'max-width: 1160px; margin: 0 auto; padding: 0 24px 96px;' });
    if (state.view === 'home') container.appendChild(renderHome(v));
    else if (state.view === 'product') container.appendChild(renderProduct());
    else if (state.view === 'scan') container.appendChild(renderScan());
    frag.appendChild(container);
    root.textContent = '';
    root.appendChild(frag);
    restoreFocus(focus);
  }

  render();
})();
