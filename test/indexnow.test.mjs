/*
 * IndexNow — the diff that decides what gets submitted.
 *
 * This is the part of build.mjs with no visible failure mode. Both ways of
 * getting it wrong are silent: a fingerprint that is not stable marks all
 * ~4 900 pages changed on every deploy and earns a 429 for spam, while one
 * that is too stable never pings at all and quietly leaves the whole feature
 * doing nothing. Neither shows up in the deploy log as an error, so the
 * properties are pinned here instead.
 *
 * ESM because build.mjs is; the rest of test/ is CommonJS against app.js.
 * Importing build.mjs is safe — it only runs main() when it is argv[1].
 *
 * Run: `node --test` (no dependencies, no build step).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupFingerprint,
  categoryFingerprint,
  serialiseManifest,
  parseManifest,
  changedUrls
} from '../build.mjs';

const variant = (storeId, price, perUnit) => ({ storeId, price, perUnit: perUnit ?? null });
const group = (name, variants) => ({ name, variants });

test('groupFingerprint ignores the order the variants arrive in', () => {
  // buildGroups() keeps whatever order PostgREST returned, which shifts when
  // fetched_at changes. That is not a price change and must not ping.
  const a = group('Melk 1l', [variant('rema', 19.9), variant('kiwi', 21.5), variant('meny', 22)]);
  const b = group('Melk 1l', [variant('meny', 22), variant('rema', 19.9), variant('kiwi', 21.5)]);
  assert.equal(groupFingerprint(a), groupFingerprint(b));
});

test('groupFingerprint moves when a price moves', () => {
  const before = group('Melk 1l', [variant('rema', 19.9), variant('kiwi', 21.5)]);
  const after = group('Melk 1l', [variant('rema', 18.9), variant('kiwi', 21.5)]);
  assert.notEqual(groupFingerprint(before), groupFingerprint(after));
});

test('groupFingerprint moves when a chain starts or stops carrying the product', () => {
  const two = group('Melk 1l', [variant('rema', 19.9), variant('kiwi', 21.5)]);
  const three = group('Melk 1l', [variant('rema', 19.9), variant('kiwi', 21.5), variant('meny', 22)]);
  assert.notEqual(groupFingerprint(two), groupFingerprint(three));
});

test('groupFingerprint moves when only the unit price moves', () => {
  // Same shelf price, repacked — "39,90 per kg" becoming "49,90 per kg" is a
  // different answer to the question the page exists to answer.
  const before = group('Ost 500g', [variant('rema', 49.9, 99.8)]);
  const after = group('Ost 500g', [variant('rema', 49.9, 124.75)]);
  assert.notEqual(groupFingerprint(before), groupFingerprint(after));
});

test('groupFingerprint moves when the product is renamed', () => {
  const before = group('Melk 1l', [variant('rema', 19.9)]);
  const after = group('Lettmelk 1l', [variant('rema', 19.9)]);
  assert.notEqual(groupFingerprint(before), groupFingerprint(after));
});

test('groupFingerprint does not collide across the field boundary', () => {
  // The fields are joined, so a separator that can appear inside a store id or
  // a name would let two different groups hash the same.
  const a = group('Melk', [variant('rema', 1)]);
  const b = group('Melk rema', [variant('', 1)]);
  assert.notEqual(groupFingerprint(a), groupFingerprint(b));
});

test('categoryFingerprint ignores group order but tracks the cheapest price', () => {
  const cat = { title: 'Melk' };
  const stable = [{ key: 'melk-1l', minPrice: 19.9 }, { key: 'melk-15l', minPrice: 27 }];
  const reordered = [{ key: 'melk-15l', minPrice: 27 }, { key: 'melk-1l', minPrice: 19.9 }];
  const cheaper = [{ key: 'melk-1l', minPrice: 18.9 }, { key: 'melk-15l', minPrice: 27 }];

  assert.equal(categoryFingerprint(cat, stable), categoryFingerprint(cat, reordered));
  assert.notEqual(categoryFingerprint(cat, stable), categoryFingerprint(cat, cheaper));
});

test('categoryFingerprint moves when a product joins the category', () => {
  const cat = { title: 'Melk' };
  const one = [{ key: 'melk-1l', minPrice: 19.9 }];
  const two = [{ key: 'melk-1l', minPrice: 19.9 }, { key: 'melk-15l', minPrice: 27 }];
  assert.notEqual(categoryFingerprint(cat, one), categoryFingerprint(cat, two));
});

test('a manifest survives the round trip through the live site', () => {
  const m = new Map([
    ['https://prisboka.no/gruppe/melk-1l', 'abc123def456'],
    ['https://prisboka.no/kategori/melk', '0011223344ff']
  ]);
  assert.deepEqual(parseManifest(serialiseManifest(m)), m);
});

test('parseManifest tolerates the trailing newline and blank lines', () => {
  const parsed = parseManifest('https://prisboka.no/gruppe/melk abc123\n\n');
  assert.equal(parsed.size, 1);
  assert.equal(parsed.get('https://prisboka.no/gruppe/melk'), 'abc123');
});

test('changedUrls stays silent when nothing moved', () => {
  const m = new Map([['https://prisboka.no/gruppe/melk', 'aaa']]);
  // Same content, separate Map — the diff is by value, not identity.
  assert.deepEqual(changedUrls(m, new Map(m)), []);
});

test('changedUrls submits the movers and the front page with them', () => {
  const previous = new Map([
    ['https://prisboka.no/gruppe/melk', 'aaa'],
    ['https://prisboka.no/gruppe/brod', 'bbb']
  ]);
  const current = new Map([
    ['https://prisboka.no/gruppe/melk', 'aaa'],
    ['https://prisboka.no/gruppe/brod', 'ZZZ']
  ]);
  assert.deepEqual(changedUrls(current, previous), [
    'https://prisboka.no/',
    'https://prisboka.no/gruppe/brod'
  ]);
});

test('changedUrls treats a page it has never seen as changed', () => {
  const current = new Map([['https://prisboka.no/gruppe/ny-vare', 'aaa']]);
  assert.deepEqual(changedUrls(current, new Map()), [
    'https://prisboka.no/',
    'https://prisboka.no/gruppe/ny-vare'
  ]);
});

test('changedUrls never submits a page that no longer exists', () => {
  // A group that dropped below MIN_STORES is gone from this build. Submitting
  // it would hand Bing a URL that now 404s.
  const previous = new Map([
    ['https://prisboka.no/gruppe/melk', 'aaa'],
    ['https://prisboka.no/gruppe/borte', 'bbb']
  ]);
  const current = new Map([['https://prisboka.no/gruppe/melk', 'aaa']]);
  assert.deepEqual(changedUrls(current, previous), []);
});
