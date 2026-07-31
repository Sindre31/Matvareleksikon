'use strict';
/*
 * Feilrapportering — the checks that stand between a shopper's correction and
 * the public catalogue.
 *
 * These matter more than most client-side validation: three reports that agree
 * on the same value UPDATE the leksikon by themselves (ml_report_apply in
 * supabase/schema-changes.sql), so a draft that slips through as the wrong
 * number is a wrong price on the site, not just a bad request. The table's
 * CHECK constraints are the backstop; this is the same rule stated where the
 * shopper can be told what to fix.
 *
 * Run: `node --test` (no dependencies, no build step).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../app.js');

test('parsePrice — accepts what a phone keyboard produces', () => {
  assert.equal(lib.parsePrice('24,90'), 24.9);
  assert.equal(lib.parsePrice('24.90'), 24.9);
  assert.equal(lib.parsePrice('kr 24,90'), 24.9);
  assert.equal(lib.parsePrice(' 24 '), 24);
  assert.equal(lib.parsePrice('9,5'), 9.5);
});

test('parsePrice — rejects everything that is not a price', () => {
  assert.equal(lib.parsePrice(''), null);
  assert.equal(lib.parsePrice(null), null);
  assert.equal(lib.parsePrice('gratis'), null);
  assert.equal(lib.parsePrice('-5'), null);
  assert.equal(lib.parsePrice('0'), null);            // a price of zero is a typo, not an offer
  assert.equal(lib.parsePrice('24,905'), null);       // more precision than øre
  assert.equal(lib.parsePrice('1e3'), null);
  assert.equal(lib.parsePrice('12,90 kr for 2'), null);
});

const draft = (over) => Object.assign({
  kind: 'pris', storeId: 'kiwi', rawName: 'Tine Lettmelk 1,75 l', groupKey: 'lettmelk tine',
  price: 32.9, priceValue: '', nameValue: '', comment: '', reporter: 'r1'
}, over);

test('reportPayload — a price correction becomes the row the table expects', () => {
  const { payload, error } = lib.reportPayload(draft({ priceValue: '29,90', comment: '  sto 29,90 på hylla  ' }));
  assert.equal(error, undefined);
  assert.deepEqual(payload, {
    kind: 'pris', store_id: 'kiwi', product_name: 'Tine Lettmelk 1,75 l',
    group_key: 'lettmelk tine', shown_price: 32.9,
    correct_price: 29.9, correct_name: null,
    comment: 'sto 29,90 på hylla', reporter: 'r1'
  });
});

test('reportPayload — a name correction carries the name, not a price', () => {
  const { payload } = lib.reportPayload(draft({ kind: 'produkt', nameValue: '  Tine  Lettmelk   1,5 l ' }));
  assert.equal(payload.kind, 'produkt');
  assert.equal(payload.correct_name, 'Tine Lettmelk 1,5 l');   // whitespace collapsed, as the trigger does
  assert.equal(payload.correct_price, null);
});

test('reportPayload — an unparseable or out-of-range price is refused with a reason', () => {
  assert.match(lib.reportPayload(draft({ priceValue: 'billig' })).error, /riktig pris/i);
  assert.match(lib.reportPayload(draft({ priceValue: '' })).error, /riktig pris/i);
  assert.match(lib.reportPayload(draft({ priceValue: '100001' })).error, /100 000/);
});

test('reportPayload — "correcting" a value to what is already shown is not a report', () => {
  assert.match(lib.reportPayload(draft({ priceValue: '32,90' })).error, /står der nå/i);
  assert.match(
    lib.reportPayload(draft({ kind: 'produkt', nameValue: 'tine lettmelk 1,75 L' })).error,
    /står der nå/i,
  );
});

test('reportPayload — a name has to be a name', () => {
  assert.match(lib.reportPayload(draft({ kind: 'produkt', nameValue: 'x' })).error, /faktisk heter/i);
  assert.match(lib.reportPayload(draft({ kind: 'produkt', nameValue: 'a'.repeat(121) })).error, /120 tegn/);
});

test('reportPayload — a draft with no product behind it never reaches the network', () => {
  assert.match(lib.reportPayload(draft({ storeId: null, priceValue: '10' })).error, /produktinfo/i);
  assert.match(lib.reportPayload(draft({ rawName: '', priceValue: '10' })).error, /produktinfo/i);
  assert.match(lib.reportPayload().error, /produktinfo/i);
});

test('reportPayload — a comment is optional and bounded', () => {
  assert.equal(lib.reportPayload(draft({ priceValue: '10' })).payload.comment, null);
  assert.equal(lib.reportPayload(draft({ priceValue: '10', comment: 'x'.repeat(600) })).payload.comment.length, 500);
});

test('reportPayload — an unknown kind reports a price, never a half-empty row', () => {
  const { payload } = lib.reportPayload(draft({ kind: 'tull', priceValue: '10' }));
  assert.equal(payload.kind, 'pris');
  assert.equal(payload.correct_price, 10);
});

// The admin panel lists products from two different RPCs — the search and the
// override list — and they name the override columns differently. One shape.
test('normAdminProduct — both admin listings normalise to the same row', () => {
  const fromSearch = lib.normAdminProduct({
    store_id: 'meny', product_name: 'Melk 1 l', display_name: 'Melk 1 l',
    price: '21.90', ov_name: null, ov_price: null, sources: 'kassalapp', row_count: 2, open_reports: '3',
  });
  const fromOverrides = lib.normAdminProduct({
    store_id: 'meny', product_name: 'Melk 1 l', display_name: 'Helmelk 1 l',
    price: '21.90', new_name: 'Helmelk 1 l', new_price: '19.90', hidden: true,
    admin_locked: true, origin: 'admin', updated_at: '2026-07-30T10:00:00Z',
  });
  assert.equal(fromSearch.ov_name, null);
  assert.equal(fromSearch.ov_price, null);
  assert.equal(fromSearch.price, 21.9);
  assert.equal(fromSearch.open_reports, 3);
  assert.equal(fromSearch.hidden, false);

  assert.equal(fromOverrides.ov_name, 'Helmelk 1 l');
  assert.equal(fromOverrides.ov_price, 19.9);       // numeric, not the string PostgREST sends
  assert.equal(fromOverrides.hidden, true);
  assert.equal(fromOverrides.admin_locked, true);
  assert.equal(fromOverrides.open_reports, 0);
});
