'use strict';
/*
 * mlGroupKey — the client-side mirror of public.ml_group_key(text).
 *
 * group_key is the key both the price-history and the photo lookups join on. It
 * used to ride along on every catalogue row; deriving it instead took 372 kB
 * (31 %) off the boot payload. The price of that is an invariant spanning two
 * languages, and nothing fails loudly when it breaks: if the two implementations
 * disagree, the lookups simply return nothing and charts and photos go missing.
 *
 * So this file pins the JS against the SQL. group-key-fixture.js holds 164
 * (product_name → group_key) pairs taken verbatim from production — the SQL
 * function's own output, not this code's — chosen to exercise every rule: each
 * unit token, each brand word, percentages, Norwegian letters, punctuation, bare
 * digits, decimal commas, run-together spacing, and ordinary names.
 *
 * A failure here means one of two things, and they need opposite fixes:
 *   • mlGroupKey was edited and now disagrees with the database → fix the JS.
 *   • ml_group_key was changed in SQL → update BOTH the JS and this fixture,
 *     and expect existing shopping lists keyed on the old scheme to shift.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../app.js');
const FIXTURE = require('./group-key-fixture.js');

const key = lib.mlGroupKey;

test('reproduces every frozen production key exactly', () => {
  const bad = [];
  for (const [name, expected] of FIXTURE) {
    const got = key(name);
    if (got !== expected) bad.push({ name, expected, got });
  }
  assert.equal(
    bad.length, 0,
    bad.length
      ? 'drifted from ml_group_key on ' + bad.length + ' of ' + FIXTURE.length + ' pairs, e.g.\n' +
        bad.slice(0, 5).map((b) => `  ${JSON.stringify(b.name)}\n    sql: ${JSON.stringify(b.expected)}\n    js : ${JSON.stringify(b.got)}`).join('\n')
      : ''
  );
});

test('the fixture actually covers the rules it claims to', () => {
  const joined = FIXTURE.map(([n]) => n).join(' | ').toLowerCase();
  assert.ok(FIXTURE.length >= 100, 'fixture is meant to be broad, got ' + FIXTURE.length);
  assert.match(joined, /\d+\s*(g|kg|ml|l)\b/, 'no size-bearing name');
  assert.match(joined, /%/, 'no percentage name');
  assert.match(joined, /[øæå]/, 'no Norwegian letters');
});

// ── Rules no production row happens to exercise ────────────────────────────
// The fixture can only cover what the catalogue contains. These pin the rest of
// the SQL against hand-written cases, so a rule that is currently unused does
// not rot silently until the day a product needs it.

test('strips the unit tokens absent from the catalogue (hg, kop, pakk)', () => {
  assert.equal(key('Kaffe 5hg Ali'), 'kaffe ali');
  assert.equal(key('Kaffe 4kop filter'), 'kaffe filter');
  assert.equal(key('Bleier 2pakk Libero'), 'bleier libero');
});

test('strips the brand spellings absent from the catalogue', () => {
  assert.equal(key('Melk X-tra'), 'melk');
  assert.equal(key('Melk Xtra'), 'melk');
  assert.equal(key('Melk Anglamark'), 'melk');
  assert.equal(key('Melk Synnove'), 'melk');
  assert.equal(key('Melk First Price'), 'melk');
  assert.equal(key('Melk Firstprice'), 'melk');
});

test('brand words are stripped only as whole words', () => {
  // "q" is a brand; "aqua" must survive it, and "meny" must not eat "menyen".
  assert.equal(key('Aqua d Or vann'), 'aqua d or vann');
  assert.equal(key('Menyen spesial'), 'menyen spesial');
  assert.equal(key('Extrakt av vanilje'), 'extrakt av vanilje');
});

test('a size must be attached to a number to count as a size', () => {
  // "l" alone is a word, not a litre marker: only \d+\s*l is stripped.
  assert.equal(key('Lys l form'), 'lys l form');
  assert.equal(key('Saft 1 l'), 'saft');
});

test('falls back to a plain fold when every token is stripped away', () => {
  // A name that is nothing but a brand and a size collapses to '' in the main
  // expression, so the SQL folds the ORIGINAL instead — which is why the size
  // survives here when it would normally be stripped. Both values below were
  // read back out of ml_group_key itself, not reasoned about.
  assert.equal(key('Meny 500g'), 'meny 500g');
  assert.equal(key('Tine'), 'tine');
});

test('empty and missing names are handled without throwing', () => {
  assert.equal(key(''), '');
  assert.equal(key(null), '');
  assert.equal(key(undefined), '');
  assert.equal(key('   '), '');
  assert.equal(key('!!!'), '');
});

test('Norwegian letters fold on the main path', () => {
  // å → a and æ → ae (not aa), and a name that is *only* Norwegian letters
  // still folds to something non-empty, so it never reaches the fallback.
  assert.equal(key('Rømme lettrømme'), 'romme lettromme');
  assert.equal(key('Blåbær'), 'blabaer');
  assert.equal(key('Fløte 18%'), 'flote');
  assert.equal(key('Rå'), 'ra');
  assert.equal(key('Øl'), 'ol');
});

test('decimal commas and points in sizes are both stripped', () => {
  assert.equal(key('Melk 1,75l'), 'melk');
  assert.equal(key('Melk 1.75 l'), 'melk');
  assert.equal(key('Melk 0,5 dl'), 'melk');
});

test('the key is stable under casing and spacing noise', () => {
  assert.equal(key('LETTMELK   1 L'), key('lettmelk 1l'));
  assert.equal(key('  Lettmelk 1 l  '), key('Lettmelk 1l'));
});
