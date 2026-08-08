/*
 * What the site asks Google to index, and what it says each page is.
 *
 * Both halves of this file pin down a defect that was invisible from inside the
 * repo and only showed up in Search Console: 4 916 of 4 926 submitted URLs sat
 * in "Oppdaget – ikke indeksert", and the pages the category pages linked to
 * were serving an empty shell whose canonical claimed to be the front page.
 * Neither failure mode raises an error anywhere — the build logs success, the
 * pages return 200, and the only symptom is a number in someone else's
 * dashboard six weeks later. So the rules live here.
 *
 * ESM because build.mjs is; the rest of test/ is CommonJS against app.js.
 * Importing build.mjs is safe — it only runs main() when it is argv[1].
 *
 * Run: `node --test` (no dependencies, no build step).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { shellFrom, setCanonical, sitemapGroups } from '../build.mjs';

const require = createRequire(import.meta.url);
const app = require('../app.js');

const group = (key, storeCount) => ({ key, name: key, storeCount, variants: [] });

// ── The sitemap selection ────────────────────────────────────────────────

test('three chains earns a sitemap entry on its own', () => {
  const kept = sitemapGroups([group('kaviar lofoten', 3)], new Set());
  assert.deepEqual(kept.map((g) => g.key), ['kaviar lofoten']);
});

test('two chains earns one only for a product a category covers', () => {
  const groups = [group('kokosmelk helios okologisk', 2), group('bbq original sauce', 2)];
  const kept = sitemapGroups(groups, new Set(['kokosmelk helios okologisk']));
  assert.deepEqual(kept.map((g) => g.key), ['kokosmelk helios okologisk']);
});

test('one chain never earns one, category or not', () => {
  const groups = [group('kneippbrod', 1)];
  assert.equal(sitemapGroups(groups, new Set(['kneippbrod'])).length, 0);
});

test('non-food is excluded however many chains carry it', () => {
  // All four are real groups from the catalogue with 3-4 chains each, so the
  // store thresholds alone would submit every one of them.
  for (const key of ['original sensodyne tannkrem', 'dreamies kattesnacks laks',
    '20w eco g9 halogenpaere halopin', 'gronnsape']) {
    assert.equal(sitemapGroups([group(key, 4)], new Set([key])).length, 0, key);
  }
});

// ── The non-food classifier ──────────────────────────────────────────────
// The interesting cases are the near-misses, because this list is matched
// against a folded, alphabetically sorted group key and a term that is one
// letter too greedy silently deletes real products from the sitemap.

test('isNonGrocery catches the non-food a dagligvare sells', () => {
  for (const key of [
    'colgate sensation tannkrem white', 'define shampoo shine weightless',
    'apple balsam fresh head shoulders', 'truseinnlegg', 'bomullspads',
    'farget flytende toyvask unik', 'maskinoppvask tabletter', 'klorin vanlig',
    'hvit lambi toalettpapir', 'serviett tulipan unik', 'papptallerken',
    '12x fisk gele whiskas', 'laks one purina', 'kattesand',
    'batterier cr2032 energizer lithium', '12cm hvit kubbelys unik',
    '41 45 mix22 pierre robert tykk ullsokk', 'fyrstikker nitedals',
    'clean drop kafferensemiddel', 'blomsternaering trim'
  ]) assert.equal(app.isNonGrocery(key), true, key);
});

test('isNonGrocery leaves food alone where the terms nearly collide', () => {
  for (const key of [
    // "balsam" is whole-word only, or it eats balsamico.
    'balsamicoeddik', 'balsamico glaze modena',
    // "tallerken" likewise: a juletallerken is dinner, a papptallerken is not.
    'juletallerken', 'ferdig fersk juletallerken', 'koldtallerken',
    // No bare "lys" — half the catalogue spells "light-coloured" that way —
    // and no bare "paere", which is a pear.
    'freia kokesjokolade lys', 'glutenfri lys melblanding toro', 'dansukker lys sirup',
    'paere', 'conference paerer', 'lys lapskaus ferdig fersk',
    // No bare "krem" or "matboks".
    'freia cookieglede oreokrem', 'piano vaniljekrem', 'kremet toro sjokoladeglasur',
    'kavli matboksen skinkeost tube',
    // Things the earlier POPULAR-based attempt at a food whitelist dropped.
    'eddik klar idun', 'ekte honning honningcentralen norsk', 'gele r tunfisk',
    'eldorado solsikkeolje', 'odelia rapsolje steking', 'first price appelsinjuice',
    'nugatti original', 'eldorado vannkastanjer', 'idun karamellsaus'
  ]) assert.equal(app.isNonGrocery(key), false, key);
});

// ── The shell ────────────────────────────────────────────────────────────

test('shellFrom empties #app so a second build is not nested', () => {
  const shell = '<body><div id="app"></div><script src="/app.js"></script></body>';
  const built = shell.replace('<div id="app"></div>', '<div id="app"><article><h1>Melk</h1></article></div>');
  assert.equal(shellFrom(built), shell);
  assert.equal(shellFrom(shell), shell, 'already-empty shell is untouched');
});

test('setCanonical inserts when absent and replaces when present', () => {
  const head = '<head><title>x</title></head>';
  const once = setCanonical(head, 'https://prisboka.no/om');
  assert.match(once, /<link rel="canonical" href="https:\/\/prisboka\.no\/om">/);
  const twice = setCanonical(once, 'https://prisboka.no/skann');
  assert.equal(twice.match(/rel="canonical"/g).length, 1, 'never two canonicals');
  assert.match(twice, /href="https:\/\/prisboka\.no\/skann"/);
});

test('the committed shell carries no canonical of its own', async () => {
  // Load-bearing, and the kind of line someone re-adds meaning well. index.html
  // is what vercel.json rewrites /liste, /vare/* and every unprerendered
  // /gruppe/* to; a canonical here tells Google all ~34 000 of them are the
  // front page. build.mjs gives each page it writes as a file of its own an
  // explicit canonical instead — see renderHomePage() for why the front page is
  // the deliberate exception.
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<link rel="canonical"/);
  assert.match(html, /<div id="app"><\/div>/, 'shell must have an empty #app to template from');
});
