'use strict';
/*
 * Næringsinnhold from Matvaretabellen.
 *
 * The leksikon's products and Mattilsynet's table share no key — only names —
 * so the whole feature rests on one heuristic, matchNutrition(). What it must
 * get right is not "find something" but "find the right food or nothing at
 * all": a shopper reading a nutrition table has no way to tell a good match
 * from a confident-looking wrong one, and the numbers are the sort people
 * screenshot. So these tests pin both directions.
 *
 * They run against the committed nutrition.json, which is the file the site
 * actually ships — a regeneration (tools/build-nutrition.mjs, roughly once a
 * year when a new edition lands) that broke any of this would be caught here
 * rather than in production. Foods are pinned by name pattern, never by
 * foodId, because Mattilsynet renumbers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../app.js');

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'nutrition.json'), 'utf8'));
const INDEX = lib.buildNutrition(DATA);

test('nutrition.json has the shape app.js and build.mjs read back', () => {
  assert.equal(DATA.version, 1);
  assert.match(DATA.source, /Matvaretabellen \d{4}\. Mattilsynet/);
  assert.match(DATA.retrieved, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(DATA.fields, ['id', 'name', 'foodGroupId', 'slug', 'kcal', 'kJ', 'values', 'keywords', 'portions']);
  assert.ok(DATA.foods.length > 1500, `only ${DATA.foods.length} foods`);

  // Every food carries exactly one value per nutrient column, in order — the
  // table renders by index, so a short row would silently shift every label
  // below it onto the wrong number.
  for (const f of DATA.foods) {
    assert.equal(f[6].length, DATA.nutrients.length, `${f[0]} ${f[1]}`);
    assert.ok(f[3], `${f[0]} has no matvaretabellen.no slug`);
  }
});

test('the declaration lines a Norwegian package must carry are all present', () => {
  const decl = DATA.nutrients.filter((n) => n.decl).map((n) => n.id);
  for (const id of ['Fett', 'Mettet', 'Karbo', 'Mono+Di', 'Fiber', 'Protein', 'NaCl']) {
    assert.ok(decl.includes(id), `${id} is not in the declaration block`);
  }
  // Everything else is behind "vis vitaminer og mineraler", and each of those
  // needs a section to be filed under.
  for (const n of DATA.nutrients) assert.ok(n.decl || n.section, `${n.id} is neither declaration nor section`);
});

test('buildNutrition rejects anything that is not the payload', () => {
  assert.equal(lib.buildNutrition(null), null);
  assert.equal(lib.buildNutrition({}), null);
  assert.equal(lib.buildNutrition({ foods: [], nutrients: 'nope' }), null);
});

// ── The matches that must land ────────────────────────────────────────────
// Group keys taken verbatim from the live catalogue (they are ckey() output:
// folded, brands dropped, words sorted), each with the food it has to find.
const HITS = [
  ['lettmelk', /^Lettmelk,/],
  ['helmelk', /^Helmelk,/],
  ['egg', /^Egg, rå$/],
  ['gulost', /^Gulost,/],
  ['norvegia', /^Norvegia, gulost$/],
  ['kyllingfilet', /^Kylling, filet,/],
  ['kjottdeig storfe', /^Kjøttdeig, storfe,/],
  ['kjottdeig kylling', /^Kjøttdeig, kylling,/],
  ['bananer', /^Banan, rå$/],
  ['poteter', /^Potet,/],
  ['brod grovt', /^Brød, (ekstra )?grovt/],
  ['leverpostei', /^Leverpostei,/],
  ['havregryn', /^Havregryn/],
  ['rapsolje', /^Rapsolje$/],
  ['spekeskinke', /^Spekeskinke$/],
  ['yoghurt naturell', /^Yoghurt, naturell/],
  ['matflote', /^Matfløte,/]
];

for (const [key, want] of HITS) {
  test(`"${key}" finds ${want}`, () => {
    const hit = lib.matchNutrition(INDEX, key);
    assert.ok(hit, `no match at all for "${key}"`);
    assert.match(hit.food.name, want);
    assert.ok(hit.score >= lib.NUTRITION_MIN_SCORE);
  });
}

// ── And the ones that must not ────────────────────────────────────────────
// Every one of these matched something plausible-looking at some point while
// the scoring was being calibrated. A silent section is the right answer.
const MISSES = [
  'toalettpapir',
  'oppvaskborste',
  'jordan mango mint tannkrem',           // Matvaretabellen has a mango
  '20w eco g9 halogenpaere halopin',      // …and a pear ("pære")
  '33lx10 boks carlsberg pilsner',        // …and a "Dessert-topping på boks"
  'aktivitetsboka mot stress'
];

for (const key of MISSES) {
  test(`"${key}" matches nothing`, () => {
    const hit = lib.matchNutrition(INDEX, key);
    assert.equal(hit, null, hit && `matched ${hit.food.name} at ${hit.score.toFixed(1)}`);
  });
}

// ── Abstaining when the name cannot decide ────────────────────────────────
// Matvaretabellen carries a food in every state it is sold in, and the states
// are not small differences. A bag labelled "Erter" scores within two points
// of both "Erter, tørre" (334 kcal) and "Erter, fryst" (65) — nothing in the
// product name says which, so showing either is a coin flip on the number most
// people read. These three were live on the page before the tie rule existed.
const TIES = ['erter', 'kikerter', 'fiskesuppe'];

for (const key of TIES) {
  test(`"${key}" abstains — the table disagrees with itself about the energy`, () => {
    assert.equal(lib.matchNutrition(INDEX, key), null);
  });
}

test('a close runner-up that agrees about energy is not a tie', () => {
  // The rule must only fire on genuine ambiguity. Milk has several entries
  // within a point of each other and they all say ~40 kcal, so the page still
  // gets its table.
  const milk = lib.matchNutrition(INDEX, 'lettmelk');
  assert.ok(milk, 'lettmelk lost its match to the tie rule');
  assert.ok(milk.food.kcal > 30 && milk.food.kcal < 55);
});

test('a compound is what its tail says it is, not its head', () => {
  // The rule the whole gate rests on: Norwegian puts the meaning at the end of
  // a compound. "Lettmelk" is milk; "melkesjokolade" is chocolate, and reading
  // it as milk would put a glass of milk's numbers on a chocolate bar.
  assert.match(lib.matchNutrition(INDEX, 'melkesjokolade').food.name, /[Ss]jokolade/);
  assert.match(lib.matchNutrition(INDEX, 'lettmelk').food.name, /^Lettmelk/);
  // The exception, and the reason the gate is not simply "ends with": a
  // Norwegian product name compounds the food with its cut. Both halves have
  // to be the food's own words for this to count.
  assert.match(lib.matchNutrition(INDEX, 'kyllingfilet').food.name, /^Kylling, filet/);
});

test('the raw food wins over the cooked one when the product does not say', () => {
  // A shopper buying a fillet is buying it raw; frying it concentrates every
  // number in the table, so guessing "stekt" would overstate the lot.
  assert.match(lib.matchNutrition(INDEX, 'kyllingfilet').food.name, /rå$/);
  assert.match(lib.matchNutrition(INDEX, 'kjottdeig storfe').food.name, /rå$/);
});

test('matching is pure — the same key twice gives the same food', () => {
  const a = lib.matchNutrition(INDEX, 'kyllingfilet');
  const b = lib.matchNutrition(INDEX, 'kyllingfilet');
  assert.equal(a.food.id, b.food.id);
  assert.equal(a.score, b.score);
  assert.equal(lib.matchNutrition(INDEX, ''), null);
  assert.equal(lib.matchNutrition(null, 'egg'), null);
});

test('a matched food has the numbers the section needs', () => {
  const f = lib.matchNutrition(INDEX, 'egg').food;
  assert.ok(f.kcal > 0 && f.kJ > 0);
  assert.ok(f.values.length === DATA.nutrients.length);
  const protein = f.values[DATA.nutrients.findIndex((n) => n.id === 'Protein')];
  assert.ok(protein > 5 && protein < 25, `egg protein came out ${protein} g/100 g`);
});

test('nutNum prints Matvaretabellen numbers the Norwegian way', () => {
  assert.equal(lib.nutNum(2.06, 1), '2,1');
  assert.equal(lib.nutNum(23, 1), '23,0');
  assert.equal(lib.nutNum(467, 0), '467');
  // "Not analysed for this food" is not zero, and must never print as one.
  assert.equal(lib.nutNum(null, 1), '–');
  assert.equal(lib.nutNum(undefined, 0), '–');
  assert.equal(lib.nutNum(NaN, 1), '–');
  assert.equal(lib.nutNum(0, 1), '0,0');
});
