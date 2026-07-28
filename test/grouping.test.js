/*
 * Unit tests for the pure price/grouping helpers in app.js.
 *
 * These cover the hardest, most regression-prone logic: parsing a comparable
 * amount out of a product name, the cross-store grouping key (word-order and
 * house-brand independence), and the category-aware mince keying. Everything
 * here is DOM-free — app.js only runs its browser bootstrap when `window` and
 * `document` exist, so requiring it under Node just exposes the helpers.
 *
 * Run: `node --test` (no dependencies, no build step).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../app.js');

test('pctOff — rounded percentage off, 0 without a before-price', () => {
  assert.equal(lib.pctOff({ price: 30, prePrice: 40 }), 25);
  assert.equal(lib.pctOff({ price: 32.9, prePrice: 49.9 }), 34);
  assert.equal(lib.pctOff({ price: 30, prePrice: null }), 0);
  assert.equal(lib.pctOff({ price: 30, prePrice: 0 }), 0);
});

test('baseAmount — normalises to base units (l, kg) or null', () => {
  assert.deepEqual(lib.baseAmount('1.5', 'l'), { value: 1.5, dim: 'l' });
  assert.deepEqual(lib.baseAmount('500', 'g'), { value: 0.5, dim: 'kg' });
  assert.deepEqual(lib.baseAmount('33', 'cl'), { value: 0.33, dim: 'l' });
  assert.equal(lib.baseAmount('0', 'l'), null);      // non-positive
  assert.equal(lib.baseAmount('2', 'stk'), null);    // not a weight/volume unit
});

test('parseAmount — largest single size token wins, dim preserved', () => {
  assert.deepEqual(lib.parseAmount('Melk 1,5 l'), { value: 1.5, dim: 'l' });
  assert.deepEqual(lib.parseAmount('Kjøttdeig 400 g'), { value: 0.4, dim: 'kg' });
  // several sizes stated → the largest is the pack size
  assert.deepEqual(lib.parseAmount('Saft 0,5 l eller 1 l'), { value: 1, dim: 'l' });
  assert.equal(lib.parseAmount('Tacosaus medium'), null);
});

test('parseAmount — fraction sizes ("1/4 l" = 0.25 l), not the "4l" token', () => {
  assert.deepEqual(lib.parseAmount('Lettmelk 0,5% 1/4l Tine'), { value: 0.25, dim: 'l' });
  assert.deepEqual(lib.parseAmount('Fløte 1/2 l'), { value: 0.5, dim: 'l' });
  assert.deepEqual(lib.parseAmount('Rømme 3/4 kg'), { value: 0.75, dim: 'kg' });
});

test('parseAmount — multipacks multiply out to the total amount', () => {
  assert.deepEqual(lib.parseAmount('Cola 6 x 33 cl'), { value: 1.98, dim: 'l' });
  assert.deepEqual(lib.parseAmount('Vann 4 x 1.5l'), { value: 6, dim: 'l' });
});

test('parseAmount — counts fall back to pieces', () => {
  assert.deepEqual(lib.parseAmount('Egg 12 stk'), { value: 12, dim: 'stk' });
  assert.deepEqual(lib.parseAmount('Yoghurt 4-pk'), { value: 4, dim: 'stk' });
});

test('normUnit — source unit labels fold to l/kg/stk or null', () => {
  assert.equal(lib.normUnit('liter'), 'l');
  assert.equal(lib.normUnit('KG'), 'kg');
  assert.equal(lib.normUnit('pakke'), 'stk');
  assert.equal(lib.normUnit('dl'), null);
});

test('foldName — folds Norwegian letters and strips sizes/percent', () => {
  assert.equal(lib.foldName('Kjøttdeig 400g Storfe 14%'), 'kjottdeig storfe');
  assert.equal(lib.foldName('Knuste Tomater 400 g'), 'knuste tomater');
});

test('ckey — grouping is word-order independent', () => {
  assert.equal(lib.ckey('Knuste tomater 400g'), lib.ckey('Tomater knuste 400g'));
});

test('ckey — house brands are stripped, national brand words kept', () => {
  assert.equal(lib.ckey('First Price Tacosaus'), 'tacosaus');
  assert.equal(lib.ckey('Eldorado Tacosaus'), 'tacosaus');
  // a branded product where the brand *is* the product stays distinct
  assert.notEqual(lib.ckey('Old El Paso Tacosaus'), lib.ckey('Santa Maria Tacosaus'));
});

test('minceKey — raw mince keys by meat type; storfe is the default', () => {
  assert.equal(lib.minceKey('kjottdeig storfe'), 'kjottdeig storfe');
  assert.equal(lib.minceKey('kjottdeig'), 'kjottdeig storfe');
  assert.equal(lib.minceKey('kjottdeig svin'), 'kjottdeig svin');
  assert.equal(lib.minceKey('kjottdeig storfe og svin'), 'kjottdeig blandet');
  assert.equal(lib.minceKey('karbonadedeig'), 'karbonadedeig');
});

test('minceKey — non-mince and disguised products are excluded', () => {
  assert.equal(lib.minceKey('knuste tomater'), null);
  assert.equal(lib.minceKey('kjottdeig lasagne'), null);   // ready meal
  assert.equal(lib.minceKey('vegetar kjottdeig'), null);   // veg imitation
});

test('ckey — pork and beef mince land in distinct groups regardless of brand', () => {
  assert.equal(lib.ckey('Rema 1000 Kjøttdeig av storfe 400g 14%'), 'kjottdeig storfe');
  assert.equal(lib.ckey('Gilde Kjøttdeig Svin 400g'), 'kjottdeig svin');
  assert.notEqual(
    lib.ckey('Rema 1000 Kjøttdeig av storfe 400g'),
    lib.ckey('Gilde Kjøttdeig Svin 400g')
  );
});

test('canonLabel — friendly titles for the canonical mince keys', () => {
  assert.equal(lib.canonLabel('kjottdeig storfe'), 'Kjøttdeig av storfe');
  assert.equal(lib.canonLabel('kjottdeig blandet'), 'Kjøttdeig blandet');
  assert.equal(lib.canonLabel('karbonadedeig'), 'Karbonadedeig');
  assert.equal(lib.canonLabel('karbonadedeig svin'), 'Karbonadedeig av svin');
  assert.equal(lib.canonLabel('knuste tomater'), null);   // not a mince key
});

test('cleanName — strips size tokens and title-cases', () => {
  assert.equal(lib.cleanName('MELK 1,5 L'), 'Melk');
  assert.equal(lib.cleanName('tomater'), 'Tomater');
});

// ── buildGroups — the cross-store aggregation the leksikon is built on ──────
// buildGroups reads the store lookup that buildStores populates, so seed a
// couple of stores first. Offer rows mimic the shape returned by PostgREST.
const STORES = [
  { id: 'kiwi', name: 'Kiwi', color: '#0a0', dash: '', sort_order: 1 },
  { id: 'rema', name: 'Rema 1000', color: '#c00', dash: '4 3', sort_order: 2 }
];
function offer(store_id, product_name, price, extra) {
  return Object.assign({ store_id, product_name, price }, extra || {});
}
function byKey(groups, key) { return groups.find((g) => g.key === key); }

test('buildGroups — the same product across stores folds into one group', () => {
  lib.buildStores(STORES);
  const groups = lib.buildGroups([
    offer('kiwi', 'Lettmelk 1 l', 18.9),
    offer('rema', 'Lettmelk 1L', 17.9),
    offer('kiwi', 'Helmelk 1 l', 19.9)
  ]);
  const melk = byKey(groups, 'lettmelk');
  assert.ok(melk, 'lettmelk group exists');
  assert.equal(melk.storeCount, 2, 'both stores in one group');
  assert.equal(melk.minPrice, 17.9);
  // helmelk stays a separate group
  assert.ok(byKey(groups, 'helmelk'));
});

test('buildGroups — per store the representative is cheapest per unit, not per pack', () => {
  lib.buildStores(STORES);
  const groups = lib.buildGroups([
    // Same store, two sizes: the big carton is dearer per pack but cheaper per litre.
    offer('kiwi', 'Lettmelk 0,5 l', 12),   // 24,00/l
    offer('kiwi', 'Lettmelk 1,5 l', 27)    // 18,00/l  ← best value
  ]);
  const melk = byKey(groups, 'lettmelk');
  assert.equal(melk.storeCount, 1);
  assert.equal(melk.variants[0].price, 27, 'the better per-litre pack represents the store');
  assert.equal(melk.unitPrice, 18);
  assert.equal(melk.unitDim, 'l');
});

test('buildGroups — "billigst per X" is only claimed when every store is unit-comparable', () => {
  lib.buildStores(STORES);
  const comparable = lib.buildGroups([
    offer('kiwi', 'Lettmelk 1 l', 18.9),
    offer('rema', 'Lettmelk 1 l', 17.9)
  ]);
  const g1 = byKey(comparable, 'lettmelk');
  assert.equal(g1.compDim, 'l', 'both stated in litres → comparable');
  assert.equal(g1.minUnit, 17.9);

  // One store has no parseable size → the per-unit claim must be withheld.
  const mixed = lib.buildGroups([
    offer('kiwi', 'Lettmelk 1 l', 18.9),
    offer('rema', 'Lettmelk', 17.9)
  ]);
  const g2 = byKey(mixed, 'lettmelk');
  assert.equal(g2.compDim, null, 'a store without a size blocks the per-unit claim');
  assert.equal(g2.minUnit, null);
});

test('buildGroups — offer flags come from a before-price above the price', () => {
  lib.buildStores(STORES);
  const groups = lib.buildGroups([
    offer('kiwi', 'Lettmelk 1 l', 15, { pre_price: 20 }),   // 25 % off
    offer('rema', 'Lettmelk 1 l', 18)
  ]);
  const melk = byKey(groups, 'lettmelk');
  assert.equal(melk.onOffer, true);
  assert.equal(melk.bestOff, 25);
});

test('buildGroups — expired offers are dropped while any live offer remains', () => {
  lib.buildStores(STORES);
  const groups = lib.buildGroups([
    offer('kiwi', 'Lettmelk 1 l', 18, { valid_until: '2020-01-01' }),  // long expired
    offer('rema', 'Lettmelk 1 l', 17, { valid_until: '2999-01-01' })   // live
  ]);
  const melk = byKey(groups, 'lettmelk');
  assert.equal(melk.storeCount, 1, 'only the live offer survives');
  assert.equal(melk.minPrice, 17);
});

// ── coveredStores — which chains carry enough prices to be compared ─────────
// The leksikon is the chains with real shelf-price coverage. Oda (1 237) and
// Coop Extra (120) fall under MIN_STORE_PRICES; Extra has no way past it, as
// Coop publishes no shelf prices anywhere.

test('coveredStores — counts usable prices per store, skipping expired and junk rows', () => {
  const rows = [
    offer('kiwi', 'Lettmelk 1 l', 18.9),
    offer('kiwi', 'Helmelk 1 l', 19.9, { valid_until: '2999-01-01' }),
    offer('kiwi', 'Kaffe', 59, { valid_until: '2020-01-01' }),   // expired → not counted
    offer('kiwi', 'Ødelagt rad', 0),                             // no real price → not counted
    offer('rema', 'Lettmelk 1 l', 17.9)
  ];
  assert.deepEqual(lib.coveredStores(rows, 1), { kiwi: 2, rema: 1 });
});

test('coveredStores — a store below the threshold is left out', () => {
  const rows = [
    offer('kiwi', 'Lettmelk 1 l', 18.9),
    offer('kiwi', 'Helmelk 1 l', 19.9),
    offer('extra', 'Lettmelk 1 l', 16.9)   // a lone kundeavis-offer
  ];
  const covered = lib.coveredStores(rows, 2);
  assert.deepEqual(Object.keys(covered), ['kiwi']);
  assert.equal(covered.extra, undefined, 'a chain with one price is not comparable');
});

test('coveredStores — no offers, or nothing above the bar, yields an empty map (caller fails open)', () => {
  assert.deepEqual(lib.coveredStores([], 1500), {});
  assert.deepEqual(lib.coveredStores(null, 1), {});
  assert.deepEqual(lib.coveredStores([offer('kiwi', 'Lettmelk 1 l', 18.9)], 1500), {});
});

test('coveredStores — the live catalogue: the three chains with shelf prices clear the bar', () => {
  // Row counts as of the change (ml_offers, valid rows per store).
  const live = { meny: 40551, kiwi: 5785, rema: 1869, oda: 1237, extra: 120 };
  const rows = [];
  Object.keys(live).forEach((store) => {
    for (let i = 0; i < live[store]; i++) rows.push(offer(store, 'Vare ' + i + ' 1 l', 10));
  });
  assert.deepEqual(Object.keys(lib.coveredStores(rows)).sort(), ['kiwi', 'meny', 'rema']);
});

test('buildStores — `covered` narrows the leksikon while ALL_STORES keeps every chain', () => {
  const withExtra = STORES.concat([{ id: 'extra', name: 'Extra', color: '#e00', dash: '' }]);
  lib.buildStores(withExtra, { kiwi: 900, rema: 700 });
  // The hidden chain's rows must not reach the leksikon either.
  const groups = lib.buildGroups([
    offer('kiwi', 'Lettmelk 1 l', 18.9),
    offer('rema', 'Lettmelk 1 l', 17.9)
  ]);
  const melk = byKey(groups, 'lettmelk');
  assert.equal(melk.storeCount, 2);
  assert.ok(melk.variants.every((v) => v.storeName !== 'Extra'));
  // Without `covered` every chain is shown (the fail-open path, and the state
  // the other tests here rely on).
  lib.buildStores(withExtra);
});

// ── staleDaysFor — the "kan være utdatert" signal in the top bar ────────────
// The ingest runs weekly; a newest price point older than 10 days means a run
// was missed, and the site must say so rather than serve old prices silently.

test('staleDaysFor — silent inside the weekly cadence, reports the age past it', () => {
  const now = Date.parse('2026-07-25T09:00:00Z');
  assert.equal(lib.staleDaysFor('2026-07-23', now), 0, '2 days old — a normal week');
  assert.equal(lib.staleDaysFor('2026-07-16', now), 0, '9 days — still inside the grace period');
  assert.equal(lib.staleDaysFor('2026-07-15', now), 10, '10 days — a missed run, flag it');
  assert.equal(lib.staleDaysFor('2026-06-01', now), 54);
});

test('staleDaysFor — a missing or malformed stamp never flags (and never throws)', () => {
  const now = Date.parse('2026-07-25T09:00:00Z');
  assert.equal(lib.staleDaysFor('', now), 0);
  assert.equal(lib.staleDaysFor(null, now), 0);
  assert.equal(lib.staleDaysFor(undefined, now), 0);
  assert.equal(lib.staleDaysFor('ikke en dato', now), 0);
  assert.equal(lib.staleDaysFor('2026-07-26', now), 0, 'a future stamp is not stale');
});

// ── searchRank — relevance ordering of the leksikon search ──────────────────
// searchRank only reads g.name (and g.onOffer), so plain objects suffice.
const g = (name, onOffer) => ({ name, onOffer: !!onOffer });

test('searchRank — an exact name match outranks everything', () => {
  assert.ok(lib.searchRank(g('Melk'), 'melk') > lib.searchRank(g('Lettmelk'), 'melk'));
});

test('searchRank — a compound ending in the query beats one merely starting with it', () => {
  // "lettmelk" is a kind of "melk"; "melkesjokolade" only starts with it.
  assert.ok(lib.searchRank(g('Lettmelk'), 'melk') > lib.searchRank(g('Melkesjokolade'), 'melk'));
});

test('searchRank — a query after "med" is an ingredient and is demoted', () => {
  assert.ok(lib.searchRank(g('Lettmelk'), 'melk') > lib.searchRank(g('Havregrøt med melk'), 'melk'));
});

test('searchRank — within a tier the shorter (closer) name wins', () => {
  assert.ok(lib.searchRank(g('Melkesjokolade'), 'melk') > lib.searchRank(g('Melkesjokolade med nøtter ekstra'), 'melk'));
});

// ── Robustness — bad input must never throw (a shared, public site) ─────────
// These guard the "white screen" failure mode: one malformed row or a null
// argument used to be able to blow up a whole build/render.

test('parseAmount — null/empty/garbage input returns null, never throws', () => {
  assert.equal(lib.parseAmount(null), null);
  assert.equal(lib.parseAmount(undefined), null);
  assert.equal(lib.parseAmount(''), null);
  assert.equal(lib.parseAmount(123), null);
  assert.equal(lib.parseAmount('%%% ??? ---'), null);
});

test('ckey — degenerate names do not throw and yield a string', () => {
  for (const n of [null, undefined, '', '   ', '%%%', 42]) {
    assert.equal(typeof lib.ckey(n), 'string');
  }
});

test('buildStores / buildGroups — non-array input is treated as empty', () => {
  assert.doesNotThrow(() => lib.buildStores(null));
  assert.doesNotThrow(() => lib.buildStores(undefined));
  assert.deepEqual(lib.buildGroups(null), []);
  assert.deepEqual(lib.buildGroups(undefined), []);
  assert.deepEqual(lib.buildGroups('not an array'), []);
});

test('buildStores — malformed store rows are skipped, valid ones kept', () => {
  assert.doesNotThrow(() => lib.buildStores([null, undefined, {}, { id: 'kiwi', name: 'Kiwi', color: '#0a0' }]));
  // a store id without a name falls back to the id (no crash rendering it)
  lib.buildStores([{ id: 'kiwi' }]);
  const groups = lib.buildGroups([offer('kiwi', 'Lettmelk 1 l', 18.9)]);
  assert.equal(byKey(groups, 'lettmelk').variants[0].storeName, 'kiwi');
});

test('buildGroups — malformed offer rows are skipped, not fatal', () => {
  lib.buildStores(STORES);
  let groups;
  assert.doesNotThrow(() => {
    groups = lib.buildGroups([
      null,                                              // no row
      undefined,
      { store_id: 'rema' },                              // no name, no price
      offer('kiwi', 'Brød', null),                       // null price
      offer('rema', 'Ost', NaN),                         // NaN price
      offer('kiwi', 'Kaffe 500g', -5),                   // non-positive price
      { store_id: 'rema', product_name: 'Egg', price: 'abc' }, // non-numeric price
      offer('kiwi', 'Lettmelk 1 l', 18.9),               // the one good row
      { store_id: 'rema', product_name: 'Lettmelk 1 l', price: '17.9' } // numeric string is fine
    ]);
  });
  const melk = byKey(groups, 'lettmelk');
  assert.ok(melk, 'the valid rows still produce a group');
  assert.equal(melk.storeCount, 2);
  assert.equal(melk.minPrice, 17.9);
  // none of the junk leaked in as its own group
  assert.equal(byKey(groups, 'brod'), undefined);
  assert.equal(byKey(groups, 'ost'), undefined);
});

// ── Pack sizes: the unit a list entry is pinned to ─────────────────────────
test('sizeIdOf / sizeLabel — a pack size ids and reads back in Norwegian', () => {
  assert.equal(lib.sizeIdOf({ amount: 1.75, unitDim: 'l' }), '1.75l');
  assert.equal(lib.sizeLabel('1.75l'), '1,75 l');
  assert.equal(lib.sizeIdOf({ amount: 0.4, unitDim: 'kg' }), '0.4kg');
  assert.equal(lib.sizeLabel('0.4kg'), '0,4 kg');
  assert.equal(lib.sizeLabel('12stk'), '12 stk');
  // no stated amount → the catch-all bucket, never a made-up size
  assert.equal(lib.sizeIdOf({ amount: null, unitDim: null }), 'ukjent');
  assert.equal(lib.sizeLabel('ukjent'), 'Uoppgitt størrelse');
  assert.equal(lib.sizeLabel('alle'), 'Alle størrelser');
});

test('sizeOptions — every distinct size, smallest first, priced and counted', () => {
  lib.buildStores(STORES);
  const groups = lib.buildGroups([
    offer('kiwi', 'Lettmelk 1 l', 18.9),
    offer('rema', 'Lettmelk 1 l', 19.9),
    offer('kiwi', 'Lettmelk 1,75 l', 28.8),
    offer('rema', 'Lettmelk', 21)   // no stated amount
  ]);
  const opts = lib.sizeOptions(byKey(groups, 'lettmelk'));
  assert.deepEqual(opts.map((o) => o.id), ['1l', '1.75l', 'ukjent']); // 'ukjent' always last
  assert.deepEqual(opts.map((o) => o.label), ['1 l', '1,75 l', 'Uoppgitt størrelse']);
  assert.equal(opts[0].storeCount, 2);   // both chains carry the 1 l
  assert.equal(opts[0].minPrice, 18.9);
  assert.equal(opts[1].storeCount, 1);
});

test('bestPerStore — narrowing to a size compares like for like', () => {
  lib.buildStores(STORES);
  const groups = lib.buildGroups([
    offer('kiwi', 'Lettmelk 1 l', 18.9),
    offer('kiwi', 'Lettmelk 1,75 l', 28.8),   // cheaper per litre, so it wins 'alle'
    offer('rema', 'Lettmelk 1 l', 17.9)
  ]);
  const g = byKey(groups, 'lettmelk');
  // any size: Kiwi is represented by the 1,75 l (16,46/l) and leads on unit price
  assert.deepEqual(lib.bestPerStore(g, 'alle').map((v) => v.rawName), ['Lettmelk 1,75 l', 'Lettmelk 1 l']);
  // pinned to 1 l: Kiwi's 1,75 l is out of the running and Rema is cheapest
  const oneLitre = lib.bestPerStore(g, '1l');
  assert.deepEqual(oneLitre.map((v) => v.storeId), ['rema', 'kiwi']);
  assert.deepEqual(oneLitre.map((v) => v.price), [17.9, 18.9]);
  // a size only one store carries leaves only that store
  assert.deepEqual(lib.bestPerStore(g, '1.75l').map((v) => v.storeId), ['kiwi']);
  assert.deepEqual(lib.bestPerStore(g, '0.5l'), []);
});

// ── Handleliste entries: product + size, in the shopper's own order ────────
test('entryId / parseEntry — round-trip, and a legacy bare key means any size', () => {
  assert.equal(lib.entryId('lettmelk q', '1.75l'), 'lettmelk q@1.75l');
  assert.deepEqual(lib.parseEntry('lettmelk q@1.75l'), { id: 'lettmelk q@1.75l', key: 'lettmelk q', size: '1.75l' });
  // a list saved before sizes existed still resolves, as "any size"
  assert.deepEqual(lib.parseEntry('lettmelk q'), { id: 'lettmelk q@alle', key: 'lettmelk q', size: 'alle' });
  assert.equal(lib.entryId('kaffe', null), 'kaffe@alle');
});

test('moveEntry — reorders without mutating, and clamps a stray drop', () => {
  const list = ['a@alle', 'b@1l', 'c@alle'];
  assert.deepEqual(lib.moveEntry(list, 2, 0), ['c@alle', 'a@alle', 'b@1l']);
  assert.deepEqual(lib.moveEntry(list, 0, 1), ['b@1l', 'a@alle', 'c@alle']);
  assert.deepEqual(list, ['a@alle', 'b@1l', 'c@alle']);      // input untouched
  assert.deepEqual(lib.moveEntry(list, 0, 99), ['b@1l', 'c@alle', 'a@alle']); // clamped to the end
  assert.deepEqual(lib.moveEntry(list, 1, -3), ['b@1l', 'a@alle', 'c@alle']); // clamped to the start
  assert.deepEqual(lib.moveEntry(list, 7, 0), list);          // out-of-range source: no-op
});

test('swapEntry — a size change keeps the item in its slot', () => {
  const list = ['a@alle', 'b@1l', 'c@alle'];
  assert.deepEqual(lib.swapEntry(list, 'b@1l', 'b@1.75l'), ['a@alle', 'b@1.75l', 'c@alle']);
  assert.deepEqual(list, ['a@alle', 'b@1l', 'c@alle']);          // input untouched
  assert.deepEqual(lib.swapEntry(list, 'x@alle', 'x@1l'), list); // unknown entry: no-op
  // the same product can never end up in the list twice
  assert.deepEqual(lib.swapEntry(['a@alle', 'b@1l', 'a@1l'], 'b@1l', 'a@1l'), ['a@alle', 'a@1l']);
  assert.deepEqual(lib.swapEntry(['a@1l', 'b@1l'], 'b@1l', 'a@1l'), ['a@1l']);
});

test('rowSizeId — a history point is sized by the product it recorded', () => {
  // the weekly row keeps the name it came from, so the pack it measured is
  // knowable even when next week's row is a different size
  assert.equal(lib.rowSizeId({ product_name: 'Lettmelk 0,5% 1,75l Q' }), '1.75l');
  assert.equal(lib.rowSizeId({ product_name: 'Lettmelk 1 l' }), '1l');
  assert.equal(lib.rowSizeId({ product_name: 'Kjottdeig 400 g' }), '0.4kg');
  assert.equal(lib.rowSizeId({ product_name: 'Tacokrydder' }), 'ukjent');
  assert.equal(lib.rowSizeId({}), 'ukjent');
  assert.equal(lib.rowSizeId(null), 'ukjent');
});

// ── The price-history chart ────────────────────────────────────────────────
test('chartFrom — plots each series over the union of dates', () => {
  const c = lib.chartFrom([
    { id: 'kiwi', name: 'Kiwi', points: [{ date: '2026-01-01', value: 10 }, { date: '2026-01-08', value: 12 }] },
    { id: 'rema', name: 'Rema', points: [{ date: '2026-01-08', value: 11 }] }
  ]);
  assert.deepEqual(c.dates, ['2026-01-01', '2026-01-08']);
  assert.equal(c.lines.length, 2);
  assert.equal(c.single, false);
  assert.equal(c.lines[0].points.split(' ').length, 2);
  assert.ok(c.grid.every((g) => /kr$/.test(g.label)));
});

test('chartFrom — empty and single-point series stay drawable', () => {
  const empty = lib.chartFrom([]);
  assert.deepEqual(empty.lines, []);
  assert.equal(empty.single, true);
  const one = lib.chartFrom([{ id: 't', name: 'Total', points: [{ date: '2026-01-01', value: 190 }] }]);
  assert.equal(one.single, true);
  assert.equal(one.lines.length, 1);
  // a flat series still gets a padded axis rather than a zero-height one
  assert.ok(one.grid[0].label !== one.grid[3].label);
});
