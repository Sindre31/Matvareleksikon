/*
 * Unit tests for the URL layer: the slug that puts a product on its own path,
 * the router that reads one back, and the translation of the '#/'-era links
 * that are still out in the wild.
 *
 * The point of this file is that a broken slug is invisible in a browser and
 * expensive in a search index. Once /gruppe/melange-margarin is crawled and
 * ranked, a change that makes it stop resolving turns an indexed page into a
 * redirect to the front page — the exact failure the move to real paths was
 * meant to fix.
 *
 * Run: `node --test` (no dependencies, no build step).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../app.js');
const FIXTURE = require('./group-key-fixture.js');

test('slugFor — spaces become hyphens, nothing else moves', () => {
  assert.equal(lib.slugFor('melange margarin'), 'melange-margarin');
  assert.equal(lib.slugFor('helmelk'), 'helmelk');
  assert.equal(lib.slugFor('kast mindre frukt gront pr kg'), 'kast-mindre-frukt-gront-pr-kg');
  assert.equal(lib.slugFor(''), '');
  assert.equal(lib.slugFor(null), '');
});

test('keyFromSlug — inverts slugFor', () => {
  assert.equal(lib.keyFromSlug('melange-margarin'), 'melange margarin');
  assert.equal(lib.keyFromSlug('helmelk'), 'helmelk');
  // A key never contains a hyphen, so a doubled one can only come from a
  // mangled link; collapsing it is friendlier than 404-ing.
  assert.equal(lib.keyFromSlug('melange--margarin'), 'melange margarin');
  assert.equal(lib.keyFromSlug(null), '');
});

test('slug round-trips every group key the fixture produces', () => {
  // ml_group_key emits [a-z0-9 ] only. That is the whole reason " " <-> "-"
  // can be a total mapping, so the guarantee is asserted rather than assumed:
  // the day a hyphen or a slash enters a key, this fails instead of silently
  // producing two products that share one URL.
  // The fixture is a list of [product_name, group_key] pairs.
  const keys = FIXTURE.map((pair) => pair[1]).filter(Boolean);
  assert.ok(keys.length > 100, 'fixture should cover a broad set of keys');
  for (const key of keys) {
    assert.match(key, /^[a-z0-9 ]+$/, `unexpected character in group key: ${JSON.stringify(key)}`);
    assert.equal(lib.keyFromSlug(lib.slugFor(key)), key);
    assert.equal(lib.groupPath(key), `/gruppe/${lib.slugFor(key)}`);
  }
});

test('groupPath / variantPath — the URLs the site links to and the sitemap lists', () => {
  assert.equal(lib.groupPath('melange margarin'), '/gruppe/melange-margarin');
  assert.equal(lib.variantPath('melange margarin', 'kiwi'), '/vare/melange-margarin/kiwi');
});

test('parsePath — each screen, and only at its own depth', () => {
  assert.deepEqual(lib.parsePath('/'), { view: 'home' });
  assert.deepEqual(lib.parsePath('/gruppe/melange-margarin'), { view: 'gruppe', groupKey: 'melange margarin' });
  assert.deepEqual(lib.parsePath('/vare/melange-margarin/kiwi'), { view: 'vare', groupKey: 'melange margarin', storeId: 'kiwi' });
  assert.deepEqual(lib.parsePath('/skann'), { view: 'scan' });
  assert.deepEqual(lib.parsePath('/om'), { view: 'om' });
  assert.deepEqual(lib.parsePath('/admin'), { view: 'admin' });
  // Anything that isn't a route collapses to home, the way the router treats it.
  assert.deepEqual(lib.parsePath('/gruppe'), { view: 'home' });
  assert.deepEqual(lib.parsePath('/vare/melange-margarin'), { view: 'home' });
  assert.deepEqual(lib.parsePath('/gruppe/a/b/c'), { view: 'home' });
  assert.deepEqual(lib.parsePath('/tullball'), { view: 'home' });
});

test('parsePath — percent-encoded and trailing-slash forms still resolve', () => {
  // A crawler, a mail client or a pasted link can all normalise a URL
  // differently from the way the site minted it.
  assert.deepEqual(lib.parsePath('/gruppe/melange%20margarin'), { view: 'gruppe', groupKey: 'melange margarin' });
  assert.deepEqual(lib.parsePath('/gruppe/melange-margarin/'), { view: 'gruppe', groupKey: 'melange margarin' });
  // A malformed escape must not throw — it just won't match a product.
  assert.equal(lib.parsePath('/gruppe/%E0%A4%A').view, 'gruppe');
});

test('parseSharedList — a shared basket travels in the fragment', () => {
  assert.deepEqual(lib.parseSharedList('#d=melk%40alle~brod%401kg'), ['melk@alle', 'brod@1kg']);
  assert.deepEqual(lib.parseSharedList('#'), null);
  assert.deepEqual(lib.parseSharedList(''), null);
  assert.deepEqual(lib.parseSharedList('#d='), null);
  // The pre-move spelling, '#/liste?d=…', is what legacyHashPath hands over.
  assert.deepEqual(lib.parseSharedList('#/liste?d=melk%40alle'), ['melk@alle']);
});

test('parsePath — /liste picks the basket up from the hash, never the query', () => {
  assert.deepEqual(lib.parsePath('/liste', '#d=melk%40alle'), { view: 'liste', shared: ['melk@alle'] });
  assert.deepEqual(lib.parsePath('/liste', ''), { view: 'liste', shared: null });
});

test('legacyHashPath — links shared before the move still land', () => {
  assert.equal(lib.legacyHashPath('#/gruppe/melange%20margarin'), '/gruppe/melange-margarin');
  assert.equal(lib.legacyHashPath('#/vare/melange%20margarin/kiwi'), '/vare/melange-margarin/kiwi');
  assert.equal(lib.legacyHashPath('#/skann'), '/skann');
  assert.equal(lib.legacyHashPath('#/om'), '/om');
  assert.equal(lib.legacyHashPath('#/admin'), '/admin');
  assert.equal(lib.legacyHashPath('#/'), '/');
  // The basket moves from the query half of the old hash into the fragment,
  // so a list someone shared last month still opens — without the payload
  // ever reaching a server or an analytics beacon.
  assert.equal(lib.legacyHashPath('#/liste?d=melk%40alle~brod%401kg'), '/liste#d=melk%40alle~brod%401kg');
  assert.equal(lib.legacyHashPath('#/liste'), '/liste');
  // Not ours: an in-page anchor is left alone rather than rewritten to '/'.
  assert.equal(lib.legacyHashPath('#innhold'), null);
  assert.equal(lib.legacyHashPath(''), null);
});

test('legacyHashPath — a group whose name held a space survives the round trip', () => {
  const key = 'kast mindre frukt gront pr kg';
  const path = lib.legacyHashPath('#/gruppe/' + encodeURIComponent(key));
  assert.equal(path, '/gruppe/kast-mindre-frukt-gront-pr-kg');
  assert.deepEqual(lib.parsePath(path), { view: 'gruppe', groupKey: key });
});

test('categoryPath / parsePath — a category is its own screen', () => {
  assert.equal(lib.categoryPath('egg'), '/kategori/egg');
  assert.deepEqual(lib.parsePath('/kategori/egg'), { view: 'kategori', slug: 'egg' });
  assert.deepEqual(lib.parsePath('/kategori/egg/'), { view: 'kategori', slug: 'egg' });
  // Not a category route: too deep, or missing the slug.
  assert.deepEqual(lib.parsePath('/kategori'), { view: 'home' });
  assert.deepEqual(lib.parsePath('/kategori/egg/ekstra'), { view: 'home' });
});
