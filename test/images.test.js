'use strict';
/*
 * On-demand product photos.
 *
 * The catalogue no longer carries image URLs — they were 29 % of the boot
 * payload — so a row arrives with a `has_image` flag and the URL is fetched per
 * screen from ml_group_images. Two things have to hold for that to be invisible
 * to the shopper:
 *
 *   1. `hasImage` propagates from the row to the variant and to the group, so
 *      the image frame is reserved for exactly the products that will fill it.
 *      Reserving too few shifts the layout when photos land; reserving too many
 *      leaves permanent blank frames on products that have no photo at all.
 *   2. The photo picked per (group, store) is the one the catalogue already
 *      promotes — cheapest per unit — so moving to the lookup doesn't change
 *      which picture a product shows.
 *
 * buildStores/buildGroups are exported; the loader closes over module state, so
 * as in offer-paging.test.js its block is lifted out of app.js and run directly.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../app.js');

const STORES = [
  { id: 'kiwi', name: 'Kiwi', color: '#0a0', dash: '', sort_order: 1 },
  { id: 'rema', name: 'Rema 1000', color: '#c00', dash: '4 3', sort_order: 2 }
];
const byKey = (groups, key) => groups.find((g) => g.key === key);

// ── hasImage propagation ───────────────────────────────────────────────────

test('hasImage rides from the row onto the variant', () => {
  lib.buildStores(STORES);
  const g = byKey(lib.buildGroups([
    { store_id: 'kiwi', product_name: 'Lettmelk 1 l', price: 18.9, has_image: true },
    { store_id: 'rema', product_name: 'Lettmelk 1L', price: 17.9, has_image: false }
  ]), 'lettmelk');
  assert.equal(g.variants.find((v) => v.storeId === 'kiwi').hasImage, true);
  assert.equal(g.variants.find((v) => v.storeId === 'rema').hasImage, false);
});

test('a group has an image when any of its variants does', () => {
  lib.buildStores(STORES);
  const groups = lib.buildGroups([
    { store_id: 'kiwi', product_name: 'Lettmelk 1 l', price: 18.9, has_image: false },
    { store_id: 'rema', product_name: 'Lettmelk 1L', price: 17.9, has_image: true },
    { store_id: 'kiwi', product_name: 'Helmelk 1 l', price: 19.9, has_image: false }
  ]);
  assert.equal(byKey(groups, 'lettmelk').hasImage, true, 'one variant with a photo is enough');
  assert.equal(byKey(groups, 'helmelk').hasImage, false, 'no photo anywhere → no reserved frame');
});

test('a missing has_image reads as no photo rather than undefined', () => {
  lib.buildStores(STORES);
  const g = byKey(lib.buildGroups([
    { store_id: 'kiwi', product_name: 'Lettmelk 1 l', price: 18.9 }
  ]), 'lettmelk');
  assert.equal(g.hasImage, false);
  assert.equal(g.variants[0].hasImage, false);
});

test('the group keeps the server group_keys the photo lookup is keyed by', () => {
  lib.buildStores(STORES);
  const g = byKey(lib.buildGroups([
    { store_id: 'kiwi', product_name: 'Lettmelk 1 l', price: 18.9, group_key: 'lettmelk', has_image: true },
    { store_id: 'rema', product_name: 'Lettmelk 1L', price: 17.9, group_key: 'lett melk', has_image: true }
  ]), 'lettmelk');
  assert.deepEqual(g.serverKeys.slice().sort(), ['lett melk', 'lettmelk']);
});

// ── The loader ─────────────────────────────────────────────────────────────

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const START = '  var IMAGES = {};';
const END = '\n  // ── Shared style bits';

// Lift the loader out of app.js and run it with a mock PostgREST. localStorage
// and render() are browser-side, so stub both; parseAmount/normUnit come from
// the module's real exports, because the loader ranks photo rows with the very
// same functions the catalogue ranks variants with.
function loadImageLoader(sb, store) {
  const a = SRC.indexOf(START);
  const b = SRC.indexOf(END);
  assert.ok(a > 0 && b > a, 'could not locate the image loader in app.js — did its markers move?');
  const saved = store || {};
  const shim = 'var localStorage = { getItem: function () { return SAVED.get; },' +
               ' setItem: function (k, v) { SAVED.set = v; } };\n' +
               'var render = function () {};\n';
  return new Function('sb', 'parseAmount', 'normUnit', 'SAVED', shim + SRC.slice(a, b) +
    '\n; return { imageOf: imageOf, groupImage: groupImage, wantImages: wantImages,' +
    '            flushImages: flushImages, rankImg: rankImg, saved: function () { return SAVED.set; },' +
    '            count: function () { return Object.keys(IMAGES).length; } };'
  )(sb, lib.parseAmount, lib.normUnit, saved);
}

// Mock of the ml_group_images endpoint. Records the key lists it was asked for.
function mockSb(rowsFor) {
  const calls = [];
  const sb = (urlPath) => {
    const inList = decodeURIComponent(/group_key=in\.\(([^)]*)\)/.exec(urlPath)[1]);
    calls.push(inList.split(',').map((s) => s.replace(/"/g, '')));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(rowsFor()) });
  };
  return { sb, calls };
}

const row = (group_key, store_id, image_url, extra) =>
  Object.assign({ group_key, store_id, product_name: null, image_url, unit_price: null, price: 10 }, extra || {});

const settle = () => new Promise((r) => setImmediate(r));

test('rankImg — unit price wins, pack price is the fallback, nulls last', () => {
  const m = loadImageLoader(mockSb(() => []).sb);
  // No size in the name, so the unit_price column decides — and it only counts
  // when its dimension is known, hence unit_price_unit.
  const r = (extra) => Object.assign({ product_name: 'Kjeks', unit: null, unit_price_unit: 'kg' }, extra);
  assert.ok(m.rankImg(r({ unit_price: 19.9, price: 40 })) < m.rankImg(r({ unit_price: 21, price: 5 })),
    'unit price decides even when the pack is dearer');
  assert.ok(m.rankImg(r({ unit_price: null, price: 5 })) > m.rankImg(r({ unit_price: 99, price: 500 })),
    'any unit price beats none');
  assert.ok(m.rankImg(r({ unit_price: null, price: 5 })) < m.rankImg(r({ unit_price: null, price: 6 })),
    'without unit prices the cheaper pack wins');
});

test('rankImg reads the pack size out of the name before trusting unit_price', () => {
  // Regression: one product reaches us from two feeds under the same name and
  // price; only ngdata fills unit_price. Ranking on that column alone made the
  // lookup prefer the ngdata row while the catalogue — which sizes the pack
  // from "400g" and so scores both identically — had settled on the first.
  // That returned a different photo for 209 of 37 703 groups.
  const m = loadImageLoader(mockSb(() => []).sb);
  const kassal = { product_name: 'Digestive Kjeks Original 400g Sætre', price: 41.9, unit_price: null, unit: null, unit_price_unit: null };
  const ngdata = { product_name: 'Digestive Kjeks Original 400g Sætre', price: 41.9, unit_price: 104.75, unit: null, unit_price_unit: 'kg' };
  assert.equal(m.rankImg(kassal), m.rankImg(ngdata),
    'same pack, same price → same rank, whatever unit_price says');

  // And where the name carries no size, the column is still the right fallback.
  const noSize = { product_name: 'Bananer klase', price: 25, unit_price: null, unit: null, unit_price_unit: null };
  const withCol = { product_name: 'Bananer klase', price: 25, unit_price: 22, unit: null, unit_price_unit: 'kg' };
  assert.ok(m.rankImg(withCol) < m.rankImg(noSize), 'a usable unit price still beats none');
});

test('a variant resolves its photo only once the group has been fetched', async () => {
  const mock = mockSb(() => [row('melk', 'kiwi', 'https://img/melk-kiwi.jpg')]);
  const m = loadImageLoader(mock.sb);
  const v = { hasImage: true, serverKey: 'melk', storeId: 'kiwi' };

  assert.equal(m.imageOf(v), null, 'nothing before the fetch');
  m.wantImages({ hasImage: true, serverKeys: ['melk'] });
  m.flushImages();
  await settle();
  assert.equal(m.imageOf(v), 'https://img/melk-kiwi.jpg');
});

test('a variant with no photo never resolves one', async () => {
  const mock = mockSb(() => [row('melk', 'kiwi', 'https://img/melk-kiwi.jpg')]);
  const m = loadImageLoader(mock.sb);
  m.wantImages({ hasImage: true, serverKeys: ['melk'] });
  m.flushImages();
  await settle();
  assert.equal(m.imageOf({ hasImage: false, serverKey: 'melk', storeId: 'kiwi' }), null);
});

test('per store the cheapest-per-unit photo is kept', async () => {
  const mock = mockSb(() => [
    row('melk', 'kiwi', 'https://img/small.jpg', { product_name: 'Melk liten', unit_price: 25, unit_price_unit: 'l', price: 12 }),
    row('melk', 'kiwi', 'https://img/big.jpg', { product_name: 'Melk stor', unit_price: 19, unit_price_unit: 'l', price: 30 }),
    row('melk', 'rema', 'https://img/rema.jpg', { product_name: 'Melk rema', unit_price: 21, unit_price_unit: 'l', price: 20 })
  ]);
  const m = loadImageLoader(mock.sb);
  m.wantImages({ hasImage: true, serverKeys: ['melk'] });
  m.flushImages();
  await settle();

  // No rawName match, so these fall to the store-level key.
  assert.equal(m.imageOf({ hasImage: true, serverKey: 'melk', storeId: 'kiwi' }), 'https://img/big.jpg',
    'the 19/unit pack represents Kiwi, not the cheaper 12 kr pack');
  assert.equal(m.imageOf({ hasImage: true, serverKey: 'melk', storeId: 'rema' }), 'https://img/rema.jpg',
    'each store keeps its own photo');
});

test('the exact pack the catalogue chose wins over the server ranking', async () => {
  // Neither row has a unit_price, so the server ranks by pack price and would
  // return the 12 kr row. The client sized "Melk 2 l" from its name, picked it
  // as the store's representative, and must still get that pack's photo.
  const mock = mockSb(() => [
    row('melk', 'kiwi', 'https://img/1l.jpg', { product_name: 'Melk 1 l', price: 12 }),
    row('melk', 'kiwi', 'https://img/2l.jpg', { product_name: 'Melk 2 l', price: 20 })
  ]);  // 12/1 = 12 per litre beats 20/2 = 10? no: 10 < 12, so the 2 l pack ranks first
  const m = loadImageLoader(mock.sb);
  m.wantImages({ hasImage: true, serverKeys: ['melk'] });
  m.flushImages();
  await settle();

  assert.equal(
    m.imageOf({ hasImage: true, serverKey: 'melk', storeId: 'kiwi', rawName: 'Melk 2 l' }),
    'https://img/2l.jpg', 'the chosen pack, not the cheapest one');
  assert.equal(
    m.imageOf({ hasImage: true, serverKey: 'melk', storeId: 'kiwi', rawName: 'Melk 1 l' }),
    'https://img/1l.jpg', 'and the other pack keeps its own');
});

test('an unrecognised pack name falls back to the store best rather than nothing', async () => {
  const mock = mockSb(() => [
    row('melk', 'kiwi', 'https://img/best.jpg', { product_name: 'Melk 1 l', price: 19 }),
    row('melk', 'kiwi', 'https://img/other.jpg', { product_name: 'Melk 2 l', price: 60 })
  ]);  // 19 per litre vs 30 per litre
  const m = loadImageLoader(mock.sb);
  m.wantImages({ hasImage: true, serverKeys: ['melk'] });
  m.flushImages();
  await settle();

  assert.equal(
    m.imageOf({ hasImage: true, serverKey: 'melk', storeId: 'kiwi', rawName: 'Melk renamed since' }),
    'https://img/best.jpg', 'cheapest per unit stands in when the name no longer matches');
});

test('a group shows the first variant with a photo, in unit-price order', async () => {
  const mock = mockSb(() => [row('melk', 'rema', 'https://img/rema.jpg')]);
  const m = loadImageLoader(mock.sb);
  const g = {
    hasImage: true, serverKeys: ['melk'],
    variants: [
      { hasImage: false, serverKey: 'melk', storeId: 'kiwi' }, // cheapest, but no photo
      { hasImage: true, serverKey: 'melk', storeId: 'rema' }
    ]
  };
  m.wantImages(g);
  m.flushImages();
  await settle();
  assert.equal(m.groupImage(g), 'https://img/rema.jpg', 'falls through to the first variant that has one');
});

test('a group with no photo resolves to null without a lookup', () => {
  const mock = mockSb(() => []);
  const m = loadImageLoader(mock.sb);
  assert.equal(m.groupImage({ hasImage: false, serverKeys: ['melk'], variants: [] }), null);
});

test('a group is never requested twice', async () => {
  const mock = mockSb(() => [row('melk', 'kiwi', 'https://img/melk.jpg')]);
  const m = loadImageLoader(mock.sb);
  const g = { hasImage: true, serverKeys: ['melk'] };

  m.wantImages(g); m.flushImages();
  await settle();
  m.wantImages(g); m.flushImages();          // the re-render the arrival triggers
  await settle();
  assert.equal(mock.calls.length, 1, 'the render caused by the response must not refetch');
});

test('groups with no photo are never requested at all', () => {
  const mock = mockSb(() => []);
  const m = loadImageLoader(mock.sb);
  m.wantImages({ hasImage: false, serverKeys: ['melk'] });
  m.flushImages();
  assert.equal(mock.calls.length, 0);
});

test('a screenful of groups is chunked, and every key asked for once', () => {
  const mock = mockSb(() => []);
  const m = loadImageLoader(mock.sb);
  for (let i = 0; i < 58; i++) m.wantImages({ hasImage: true, serverKeys: ['g' + i] });
  m.flushImages();
  assert.equal(mock.calls.length, 2, '58 groups → 2 chunked requests, not 58');
  const asked = mock.calls.flat();
  assert.equal(asked.length, 58);
  assert.equal(new Set(asked).size, 58, 'no key requested twice');
});

test('the localStorage cap bounds what is saved, never the live map', async () => {
  // Regression: the cap used to replace IMAGES with the trimmed copy, so once a
  // session had seen more products than the cap, photos vanished from screens
  // that were showing them. Across a whole catalogue that blanked 33 772 of
  // 37 703 groups.
  const many = [];
  for (let i = 0; i < 7000; i++) many.push(row('g' + i, 'kiwi', 'https://img/' + i + '.jpg'));
  const m = loadImageLoader(mockSb(() => many).sb);
  m.wantImages({ hasImage: true, serverKeys: ['g0'] });
  m.flushImages();
  await settle();

  assert.ok(m.count() > 6000, 'every fetched photo stays in memory (' + m.count() + ')');
  assert.equal(m.imageOf({ hasImage: true, serverKey: 'g0', storeId: 'kiwi' }), 'https://img/0.jpg',
    'the earliest photo is still resolvable');
  assert.equal(m.imageOf({ hasImage: true, serverKey: 'g6999', storeId: 'kiwi' }), 'https://img/6999.jpg',
    'and so is the latest');
  assert.ok(Object.keys(JSON.parse(m.saved())).length <= 6000, 'but what is persisted is capped');
});

test('photos saved by an earlier visit are reused without refetching', async () => {
  const seed = { get: JSON.stringify({ 'melk\u0000kiwi': 'https://img/from-last-visit.jpg' }) };
  const mock = mockSb(() => []);
  const m = loadImageLoader(mock.sb, seed);

  assert.equal(m.imageOf({ hasImage: true, serverKey: 'melk', storeId: 'kiwi' }),
    'https://img/from-last-visit.jpg', 'available before any network call');
  m.wantImages({ hasImage: true, serverKeys: ['melk'] });
  m.flushImages();
  assert.equal(mock.calls.length, 0, 'a group already on disk is not requested again');
});

test('a corrupt saved cache is ignored rather than fatal', () => {
  const m = loadImageLoader(mockSb(() => []).sb, { get: '{not json' });
  assert.equal(m.imageOf({ hasImage: true, serverKey: 'melk', storeId: 'kiwi' }), null);
});

test('a failed lookup leaves the app usable and does not poison the cache', async () => {
  const calls = [];
  const sb = (urlPath) => { calls.push(urlPath); return Promise.reject(new Error('offline')); };
  const m = loadImageLoader(sb);
  m.wantImages({ hasImage: true, serverKeys: ['melk'] });
  m.flushImages();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(m.imageOf({ hasImage: true, serverKey: 'melk', storeId: 'kiwi' }), null,
    'no photo, but no throw either — prices still render');
});
