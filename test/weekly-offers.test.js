/*
 * Unit tests for the "Ukas tilbud" selection on the front page.
 *
 * The section used to be the eight steepest markdowns in the catalogue, which
 * filled it with whatever obscure line a chain happened to dump that week. It
 * now ranks a real tilbudsavis offer above an offer inferred from a price
 * history, then the staples (ost, kjøttdeig, kaffe …), then the deepest cut
 * inside a category, one card per product and a cap per category. These pin
 * exactly that.
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
// validUntil marks an offer that came from a tilbudsavis — only that feed dates
// its offers, so it is how a real offer is told from an inferred one.
function offer(storeName, price, prePrice, validUntil) {
  return {
    storeName: storeName, name: storeName + ' ' + price, price: price, prePrice: prePrice,
    isOffer: prePrice > price, validUntil: validUntil || null
  };
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

test('popularityOf — short terms are whole words, so "kompost" is not cheese', () => {
  assert.equal(lib.popularityOf('kompost jord'), null);
  assert.equal(lib.popularityOf('billigst pris'), null);      // not "ris"
  assert.equal(lib.popularityOf('jasminris ris').family, 'middag');
});

test('popularityOf — long terms match inside a compound, the way Norwegian builds words', () => {
  assert.equal(lib.popularityOf('fersk kyllingfilet').family, 'kylling');
  assert.equal(lib.popularityOf('orretfilet').family, 'fisk');
  assert.equal(lib.popularityOf('krydret svin tynnribbe').family, 'kjott');
});

test('popularityOf — four-letter terms match only as the compound head', () => {
  assert.equal(lib.popularityOf('bjorn hatting havrebrod').family, 'bakeri');  // a brød
  assert.equal(lib.popularityOf('lettmelk').family, 'meieri');
  assert.equal(lib.popularityOf('rod borg julebrus').family, 'drikke');
  // "melkesjokolade" is chocolate, not milk — and "chocolate" spells c-o-l-a.
  assert.equal(lib.popularityOf('freia melkesjokolade').family, 'snacks');
  assert.equal(lib.popularityOf('chocolate cloetta crispy eggs'), null);
});

test('popularityOf — a staple name on baby or pet food is not that staple', () => {
  assert.equal(lib.popularityOf('1 3ar laks nestle pasta'), null);
  assert.equal(lib.popularityOf('ar biff ris semper stroganoff'), null);
  assert.equal(lib.popularityOf('gold gourmet lever purina'), null);
  // the real thing still counts
  assert.equal(lib.popularityOf('laksefilet').family, 'fisk');
});

test('popularityOf — a mozzarella pizza is a pizza, not a cheese', () => {
  assert.equal(lib.popularityOf('dr mozzarella oetker pizza ristorante').family, 'pizza');
  assert.equal(lib.popularityOf('mozzarella').family, 'ost');
});

test('pickWeeklyOffers — a dated tilbudsavis offer outranks a deeper inferred one', () => {
  const groups = [
    // −50 % inferred from a price history (the ingest caps it exactly there)
    group('ristorante pizza', [offer('Meny', 35, 70)]),
    // −20 % straight out of this week's tilbudsavis
    group('gulost cheddar', [offer('Kiwi', 30, 37.4, '2099-01-01')])
  ];
  assert.deepEqual(keysOf(lib.pickWeeklyOffers(groups, 8, 2)), ['gulost cheddar', 'ristorante pizza']);
});

test('pickWeeklyOffers — within a product, the dated offer represents it', () => {
  const groups = [group('gulost cheddar', [
    offer('Meny', 20, 40),                  // −50 %, inferred
    offer('Kiwi', 30, 37.4, '2099-01-01')   // −20 %, from the avis
  ])];
  const picked = lib.pickWeeklyOffers(groups, 8, 2);
  assert.equal(picked[0].v.storeName, 'Kiwi');
  assert.equal(picked[0].avis, 1);
});

test('pickWeeklyOffers — four pizza variants still take only two slots', () => {
  const groups = [
    group('bolognese dr oetker pizza ristorante', [offer('Meny', 35, 70)]),
    group('diavola dr oetker pizza ristorante', [offer('Meny', 34, 68)]),
    group('dr mozzarella oetker pizza ristorante', [offer('Meny', 35, 70)]),
    group('dr fri gl mozzarella oetker pizza ristorante', [offer('Meny', 35, 70)]),
    group('kjottdeig storfe', [offer('Rema 1000', 50, 60)])
  ];
  const picked = lib.pickWeeklyOffers(groups, 8, 2);
  assert.equal(picked.filter((p) => p.family === 'pizza').length, 2);
  assert.ok(keysOf(picked).includes('kjottdeig storfe'));
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
