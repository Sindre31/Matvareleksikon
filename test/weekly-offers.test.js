/*
 * Unit tests for the "Ukas tilbud" selection on the front page.
 *
 * The section used to be the eight steepest markdowns in the catalogue, which
 * filled it with whatever obscure line a chain happened to dump that week. It
 * now ranks the way a tilbudsavis does: the staples first (ost, kjøttdeig,
 * kaffe …), the deepest cut inside a category, one card per product and a cap
 * per category. These pin exactly that.
 *
 * Run: `node --test` (no dependencies, no build step).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../app.js');

// A minimal group as buildGroups would produce it: the fields the picker reads.
function group(key, variants) {
  return { key: key, name: key, variants: variants };
}
function offer(storeName, price, prePrice) {
  return { storeName: storeName, name: storeName + ' ' + price, price: price, prePrice: prePrice, isOffer: prePrice > price };
}
function keysOf(picked) {
  return picked.map((p) => p.g.key);
}

test('popularityOf — front-page staples outrank the everyday basket, rest is 0', () => {
  assert.equal(lib.popularityOf('norvegia ost').w, 2);
  assert.equal(lib.popularityOf('kjottdeig storfe').w, 2);
  assert.equal(lib.popularityOf('friele kaffe').w, 2);
  assert.equal(lib.popularityOf('lettmelk melk').w, 1);
  assert.equal(lib.popularityOf('bacon').w, 1);
  assert.equal(lib.popularityOf('vaskemiddel omo'), null);
});

test('popularityOf — matches whole words, so "kompost" is not cheese', () => {
  assert.equal(lib.popularityOf('kompost jord'), null);
  assert.equal(lib.popularityOf('billigst pris'), null);      // not "ris"
  assert.equal(lib.popularityOf('jasminris ris').family, 'middag');
});

test('pickWeeklyOffers — a popular category beats a deeper cut elsewhere', () => {
  const groups = [
    group('vaskemiddel omo', [offer('Kiwi', 20, 100)]),   // −80 %, nobody's weekly shop
    group('norvegia ost', [offer('Rema 1000', 80, 100)])  // −20 %, front page material
  ];
  assert.deepEqual(keysOf(lib.pickWeeklyOffers(groups, 8, 2)), ['norvegia ost', 'vaskemiddel omo']);
});

test('pickWeeklyOffers — deepest cut wins inside a category', () => {
  const groups = [
    group('gulost ost', [offer('Meny', 90, 100)]),
    group('brunost ost', [offer('Kiwi', 60, 100)])
  ];
  assert.deepEqual(keysOf(lib.pickWeeklyOffers(groups, 8, 2)), ['brunost ost', 'gulost ost']);
});

test('pickWeeklyOffers — one card per product: the store with the best cut', () => {
  const groups = [group('norvegia ost', [offer('Meny', 90, 100), offer('Kiwi', 55, 100), offer('Rema 1000', 70, 100)])];
  const picked = lib.pickWeeklyOffers(groups, 8, 2);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].v.storeName, 'Kiwi');
});

test('pickWeeklyOffers — a category is capped, and the rest fills the row', () => {
  const groups = [
    group('norvegia ost', [offer('Kiwi', 50, 100)]),
    group('brunost ost', [offer('Kiwi', 55, 100)]),
    group('jarlsberg ost', [offer('Kiwi', 60, 100)]),   // third cheese — capped out
    group('vaskemiddel omo', [offer('Kiwi', 70, 100)])
  ];
  assert.deepEqual(
    keysOf(lib.pickWeeklyOffers(groups, 8, 2)),
    ['norvegia ost', 'brunost ost', 'vaskemiddel omo']
  );
});

test('pickWeeklyOffers — non-offers are skipped and the limit is honoured', () => {
  const groups = [
    group('norvegia ost', [offer('Kiwi', 100, null)]),   // full price, not an offer
    group('kjottdeig storfe', [offer('Rema 1000', 50, 100)]),
    group('friele kaffe', [offer('Meny', 60, 100)])
  ];
  assert.deepEqual(keysOf(lib.pickWeeklyOffers(groups, 1, 2)), ['kjottdeig storfe']);
});
