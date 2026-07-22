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
