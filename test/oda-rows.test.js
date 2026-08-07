'use strict';
/*
 * ml-ingest-oda — the mapping from an Oda search hit to an ml_offers row.
 *
 * Oda's API states the pack size in `name_extra`, not in the product name, and
 * calls three different kinds of campaign a "discount". Both cost us real rows
 * before this was pinned:
 *
 *   • "Tine Lettmelk 1% fett" is BOTH the 1 l and the 1,75 l carton. Keying the
 *     row on a slug of the name collided on 106 slugs / 117 products, and left
 *     the survivors on screen at two prices with nothing saying why.
 *   • folding the whole of `name_extra` into the name drags purchase limits
 *     ("Maks 10 per kunde") in with the size, which shifts group_key — measured
 *     at 301 of 4 913 products, Pepsi Max and Grandiosa among them — and
 *     silently unpicks them from every other chain's rows in the same group.
 *   • `fixed_price_bundle` and `mix_and_match` quote undiscounted == price,
 *     because the saving needs three in the basket. Treating those as offers
 *     puts a 0 %-off badge on the card and feeds backfillPreviousWeek a "last
 *     week's price" identical to this week's.
 *
 * None of those fail loudly, so the properties are pinned here instead.
 *
 * Like test/offer-paging.test.js, this runs the SHIPPED code rather than a
 * copy: the helper block is lifted out of the Edge Function source and
 * evaluated. It is TypeScript, so the annotations are stripped with Node's own
 * stripper (node:module, which is why CI pins Node 22) rather than a regex that
 * would quietly mangle what it didn't understand. If the block stops evaluating
 * or stops holding what it claims, this fails instead of testing nothing.
 *
 * Run: `node --test` (no dependencies, no build step).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'functions', 'ml-ingest-oda', 'index.ts'),
  'utf8'
);

// The pure block: everything from the price floor down to the fetch layer.
// Anchored on real code landmarks, not markers planted for the test.
const START = 'const MIN_PRICE_NOK = 2;';
const END = '// ── Oda fetch, with the backoff';

function load() {
  const a = SRC.indexOf(START);
  const b = SRC.indexOf(END);
  assert.ok(a > 0 && b > a, 'could not locate the helper block in ml-ingest-oda — did its landmarks move?');
  let mod;
  try {
    // stripTypeScriptTypes replaces annotations with spaces, so the block stays
    // line-for-line the source it came from.
    const js = stripTypeScriptTypes(SRC.slice(a, b));
    mod = new Function(
      js + '\n; return { rowFrom, productName, sizeToken, prePriceOf, isPurchasable, groupKey, betterHistoryRow };'
    )();
  } catch (e) {
    assert.fail('the ml-ingest-oda helper block no longer evaluates as JS after type-stripping: ' + e.message);
  }
  for (const k of ['rowFrom', 'productName', 'sizeToken', 'prePriceOf', 'isPurchasable', 'groupKey']) {
    assert.equal(typeof mod[k], 'function', k + ' is missing from the lifted block');
  }
  return mod;
}

const oda = load();

// A search hit, shaped like the ones /api/v1/search/ actually returns.
function hit(over) {
  return Object.assign({
    id: 8143,
    full_name: 'Tine Lettmelk 1% fett',
    name_extra: '1% fett, 1,75 l',
    gross_price: '35.70',
    gross_unit_price: '20.40',
    unit_price_quantity_abbreviation: 'l',
    currency: 'NOK',
    discount: null,
    availability: { code: 'available' },
    images: [{ thumbnail: { url: 'https://images.oda.com/x.jpg' } }],
  }, over || {});
}

// ── the pack size ───────────────────────────────────────────────────────────

test('sizeToken keeps Norwegian decimal commas intact', () => {
  // Splitting name_extra on "," reads "1,75 l" as 75 litres, which would put a
  // 0,48 kr/l price on a milk carton and make Oda the cheapest chain alive.
  assert.equal(oda.sizeToken('1% fett, 1,75 l'), '1,75 l');
  assert.equal(oda.sizeToken('0,5%, 0,5 l'), '0,5 l');
});

test('sizeToken takes the pack, not the first number it meets', () => {
  assert.equal(oda.sizeToken('Middagskit, 685 g'), '685 g');
  assert.equal(oda.sizeToken('Maks 10 per kunde, 1,5 l'), '1,5 l');
  assert.equal(oda.sizeToken('12 x 85 g'), '85 g');
});

test('sizeToken ignores a percentage that is not a size', () => {
  assert.equal(oda.sizeToken('1% fett'), null);
  assert.equal(oda.sizeToken(''), null);
  assert.equal(oda.sizeToken(null), null);
});

test('productName appends the size Oda leaves out of full_name', () => {
  assert.equal(oda.productName(hit()), 'Tine Lettmelk 1% fett 1,75 l');
});

test('productName distinguishes two packs that share a full_name', () => {
  const big = oda.productName(hit({ name_extra: '1% fett, 1,75 l' }));
  const small = oda.productName(hit({ name_extra: '1% fett, 1 l' }));
  assert.notEqual(big, small);
});

test('productName does not restate a size the name already carries', () => {
  const n = oda.productName(hit({ full_name: 'Pepsi Max 1,5 l', name_extra: '1,5 l' }));
  assert.equal(n, 'Pepsi Max 1,5 l');
});

test('productName leaves group_key untouched', () => {
  // The whole reason only the size token is appended. A purchase limit folded
  // into the name would move these keys and orphan the products from the other
  // chains' rows in the same group.
  const cases = [
    ['Pepsi Max', 'Maks 10 per kunde, 1,5 l'],
    ['Grandiosa pizza Original', 'Maks 3 til nedsatt pris, Original, 575 g'],
    ['TINE Norvegia Original', 'Original, ca. 500 g'],
    ['Tine Lettmelk 1% fett', '1% fett, 1,75 l'],
  ];
  for (const [full_name, name_extra] of cases) {
    assert.equal(
      oda.groupKey(oda.productName(hit({ full_name, name_extra }))),
      oda.groupKey(full_name),
      'group_key moved for ' + JSON.stringify(full_name)
    );
  }
});

// ── what counts as an offer ─────────────────────────────────────────────────

test('prePriceOf takes a real markdown', () => {
  const d = {
    is_discounted: true, discount_type: 'price_discount',
    undiscounted_gross_price: '53.80',
  };
  assert.equal(oda.prePriceOf({ discount: d }, 26.8), 53.8);
});

test('prePriceOf rejects the bundle campaigns', () => {
  // As they arrive today: undiscounted == price, because the saving only
  // exists once three are in the basket.
  for (const t of ['fixed_price_bundle', 'mix_and_match']) {
    const d = { is_discounted: true, discount_type: t, undiscounted_gross_price: '25.80' };
    assert.equal(oda.prePriceOf({ discount: d }, 25.8), null, t + ' leaked through');
  }
});

test('prePriceOf rejects a bundle even when it does quote a higher price', () => {
  // The type gate alone has to carry this one — the above-the-price test can't.
  // No bundle in the 4 913 measured quoted a higher undiscounted price, but if
  // one starts to, it is still a conditional price and not a markdown: you pay
  // 25,80 for one of them either way, so charting 30,00 as "last week" would
  // invent a drop that never happened.
  for (const t of ['fixed_price_bundle', 'mix_and_match']) {
    const d = { is_discounted: true, discount_type: t, undiscounted_gross_price: '30.00' };
    assert.equal(oda.prePriceOf({ discount: d }, 25.8), null, t + ' leaked through');
  }
});

test('prePriceOf ignores a discount block that is not flagged discounted', () => {
  const d = { is_discounted: false, discount_type: 'price_discount', undiscounted_gross_price: '53.80' };
  assert.equal(oda.prePriceOf({ discount: d }, 26.8), null);
});

test('prePriceOf rejects a before-price that is not above the price', () => {
  const d = { is_discounted: true, discount_type: 'price_discount', undiscounted_gross_price: '20.00' };
  assert.equal(oda.prePriceOf({ discount: d }, 25.8), null);
  assert.equal(oda.prePriceOf({ discount: null }, 25.8), null);
  assert.equal(oda.prePriceOf({}, 25.8), null);
});

// ── the row ─────────────────────────────────────────────────────────────────

test('rowFrom keys on Oda\'s product id, not the name', () => {
  const a = oda.rowFrom(hit({ id: 8143, name_extra: '1% fett, 1,75 l' }));
  const b = oda.rowFrom(hit({ id: 430, name_extra: '1% fett, 1 l', gross_price: '21.50' }));
  assert.equal(a.external_id, 'oda:8143');
  assert.equal(b.external_id, 'oda:430');
  assert.notEqual(a.external_id, b.external_id, 'the two cartons collapsed into one row again');
});

test('rowFrom carries price, unit price and image', () => {
  const r = oda.rowFrom(hit());
  assert.equal(r.store_id, 'oda');
  assert.equal(r.source, 'oda');
  assert.equal(r.price, 35.7);
  assert.equal(r.unit_price, 20.4);
  assert.equal(r.unit_price_unit, 'l');
  assert.equal(r.image_url, 'https://images.oda.com/x.jpg');
  assert.equal(r.pre_price, null);
  // Oda's campaigns state no end date, so the row must not expire.
  assert.equal(r.valid_until, null);
});

test('rowFrom drops what cannot be priced or bought', () => {
  assert.equal(oda.rowFrom(hit({ gross_price: '2.00' })), null, 'placeholder price kept');
  assert.equal(oda.rowFrom(hit({ gross_price: null })), null, 'missing price kept');
  assert.equal(oda.rowFrom(hit({ id: null })), null, 'row with no stable id kept');
  assert.equal(oda.rowFrom(hit({ currency: 'SEK' })), null, 'non-NOK price kept');
  for (const code of ['sold_out', 'sold_out_supplier', 'available_later']) {
    assert.equal(oda.rowFrom(hit({ availability: { code } })), null, code + ' kept');
  }
});

test('rowFrom keeps what is purchasable', () => {
  for (const code of ['available', 'available_weekdays']) {
    assert.ok(oda.rowFrom(hit({ availability: { code } })), code + ' dropped');
  }
});

test('isPurchasable is not fooled by a missing availability block', () => {
  assert.equal(oda.isPurchasable({}), false);
});

// ── history ─────────────────────────────────────────────────────────────────

test('betterHistoryRow prefers the better value, not the smaller pack', () => {
  const litre = { price: 20.2, unit_price: 20.2, unit_price_unit: 'l', product_name: 'Melk 1 l' };
  const half = { price: 13.1, unit_price: 26.2, unit_price_unit: 'l', product_name: 'Melk 0,5 l' };
  assert.equal(oda.betterHistoryRow(litre, half), true, 'the dearer-per-litre half-litre won');
  assert.equal(oda.betterHistoryRow(half, litre), false);
});
