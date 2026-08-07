/*
 * nutrition.json — Matvaretabellen, distilled.
 *
 * Matvaretabellen (Mattilsynet's food composition table) publishes its whole
 * database at https://www.matvaretabellen.no/api/ — 2 121 foods, ~100 measured
 * constituents each, 13,6 MB of JSON. That is a fine archive and a terrible
 * asset: a shopper opening /gruppe/helmelk wants ten numbers, not thirteen
 * megabytes, and the table is revised about once a year while this site
 * deploys several times a week.
 *
 * So the fetch happens HERE, by hand, and the result is committed:
 *
 *     node tools/build-nutrition.mjs        # rewrites ../nutrition.json
 *     node tools/build-nutrition.mjs --dry  # print the diff, write nothing
 *
 * What survives the distillation: the food's name, its Matvaretabellen id and
 * page, its food group, energy, the 10 lines of a Norwegian nutrition
 * declaration, 26 further nutrients worth showing, the household portions, and
 * the table's own search keywords (they carry the nynorsk and the everyday
 * synonyms — "kaffi", "skaldyr" — that the matcher in app.js reads). What does
 * not: the ~60 individual fatty acids, LanguaL codes, latin names, per-value
 * source ids and the edible-part share. That is 13,6 MB down to ~600 kB, and
 * ~120 kB over the wire once Vercel gzips it.
 *
 * The layout is positional (arrays, not objects) because the field names would
 * otherwise be 40 % of the file — every one of them repeated 2 121 times. The
 * shape is documented below and read back in exactly one place, nutritionData()
 * in app.js; the two must change together.
 *
 * Attribution is not optional and is baked into the payload rather than left to
 * whoever renders it: Mattilsynet requires a visible source line, and the app
 * prints `source` verbatim under the table.
 */
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://www.matvaretabellen.no/api/nb';
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'nutrition.json');

// Mattilsynet's own citation string, from
// https://www.mattilsynet.no/mat-og-drikke/matvaretabellen/opphavsrett:
// "Tabellverdiar og tekstar frå Matvaretabellen må ikkje kopierast eller
// gjevast ut på anna måte utan tydeleg kjeldetilvising."
const EDITION = '2026';
const SOURCE = `Matvaretabellen ${EDITION}. Mattilsynet. www.matvaretabellen.no`;

// The nutrients kept, in the order they are shown. The first ten are the
// declaration a Norwegian package must carry (energi, fett, hvorav mettede,
// karbohydrat, hvorav sukkerarter, kostfiber, protein, salt) plus the two
// unsaturated lines the table splits fat into; `decl: true` is what app.js
// reads to decide which rows sit above the fold. The rest are the ones a
// shopper plausibly came for — a fish's omega-3, a milk's calcium, a liver
// paste's vitamin A — grouped so the expanded table can head them.
//
// nutrientId values are Matvaretabellen's own (see /api/nb/nutrients.json).
// A nutrient renamed there and not renamed here simply stops being written,
// which the run reports as a missing id rather than silently dropping a column.
const KEEP = [
  { id: 'Fett', decl: true },
  { id: 'Mettet', decl: true, indent: true },
  { id: 'Enumet', decl: true, indent: true },
  { id: 'Flerum', decl: true, indent: true },
  { id: 'Karbo', decl: true },
  { id: 'Mono+Di', decl: true, indent: true },
  { id: 'Stivel', decl: true, indent: true },
  { id: 'Fiber', decl: true },
  { id: 'Protein', decl: true },
  { id: 'NaCl', decl: true },

  { id: 'Vann', section: 'Annet' },
  { id: 'Alko', section: 'Annet' },
  { id: 'Trans', section: 'Annet' },
  { id: 'Omega-3', section: 'Annet' },
  { id: 'Omega-6', section: 'Annet' },
  { id: 'Kolest', section: 'Annet' },

  { id: 'Vit A', section: 'Vitaminer' },
  { id: 'Vit D', section: 'Vitaminer' },
  { id: 'Vit E', section: 'Vitaminer' },
  { id: 'Vit B1', section: 'Vitaminer' },
  { id: 'Vit B2', section: 'Vitaminer' },
  { id: 'Niacin', section: 'Vitaminer' },
  { id: 'Vit B6', section: 'Vitaminer' },
  { id: 'Folat', section: 'Vitaminer' },
  { id: 'Vit B12', section: 'Vitaminer' },
  { id: 'Vit C', section: 'Vitaminer' },

  { id: 'Ca', section: 'Mineraler' },
  { id: 'Fe', section: 'Mineraler' },
  { id: 'Na', section: 'Mineraler' },
  { id: 'K', section: 'Mineraler' },
  { id: 'Mg', section: 'Mineraler' },
  { id: 'Zn', section: 'Mineraler' },
  { id: 'Se', section: 'Mineraler' },
  { id: 'Cu', section: 'Mineraler' },
  { id: 'P', section: 'Mineraler' },
  { id: 'I', section: 'Mineraler' }
];

async function get(name) {
  const url = `${API}/${name}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

// The food's own page on matvaretabellen.no, kept as the slug alone — the
// origin is the same for all 2 121 of them and app.js puts it back.
function slugOf(uri) {
  const m = String(uri || '').match(/matvaretabellen\.no\/([^/?#]+)/);
  return m ? m[1] : '';
}

// A quantity, rounded the way the table itself says that nutrient is precise.
// Matvaretabellen ships 0.44 for a value it prints as 0,4; keeping the extra
// digits would be 40 kB of noise and a table claiming a precision the analysis
// does not have. A constituent with no `quantity` at all was never analysed for
// that food — null, not 0, so the app can say "ikke analysert".
function round(q, dec) {
  if (q == null || !isFinite(q)) return null;
  const f = Math.pow(10, dec);
  return Math.round(q * f) / f;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const [foods, nutrients, groups] = await Promise.all([
    get('foods'), get('nutrients'), get('food-groups')
  ]);

  const byId = {};
  nutrients.nutrients.forEach((n) => { byId[n.nutrientId] = n; });
  const missing = KEEP.filter((k) => !byId[k.id]).map((k) => k.id);
  if (missing.length) {
    // Loud, and fatal: a silently dropped column is a table that quietly stops
    // mentioning salt.
    throw new Error(`nutrientId no longer in Matvaretabellen: ${missing.join(', ')}`);
  }

  const cols = KEEP.map((k) => {
    const n = byId[k.id];
    return {
      id: k.id,
      name: n.name,
      unit: n.unit,
      dec: n.decimalPrecision,
      decl: k.decl || false,
      indent: k.indent || false,
      section: k.section || ''
    };
  });

  const out = foods.foods.map((f) => {
    const q = {};
    (f.constituents || []).forEach((c) => { q[c.nutrientId] = c.quantity; });
    return [
      f.foodId,
      f.foodName.trim(),
      f.foodGroupId,
      slugOf(f.uri),
      round(f.calories && f.calories.quantity, 0),
      round(f.energy && f.energy.quantity, 0),
      cols.map((c) => round(q[c.id], c.dec)),
      (f.searchKeywords || []).map((k) => String(k).toLowerCase()),
      // [name, grams] — the unit ("stk", "dl") is already in the name for the
      // ones where it matters ("glass", "spiseskje"), and 715 rows of "dl" is
      // 3 kB spent on a word the name repeats.
      (f.portions || []).map((p) => [p.portionName.trim(), round(p.quantity, 0)])
        .filter((p) => p[1] > 0)
    ];
  }).sort((a, b) => a[0].localeCompare(b[0]));

  const payload = {
    version: 1,
    source: SOURCE,
    edition: EDITION,
    retrieved: new Date().toISOString().slice(0, 10),
    api: `${API}/foods.json`,
    // Positional, and this is the record of which position is what. Read back
    // by nutritionData() in app.js.
    fields: ['id', 'name', 'foodGroupId', 'slug', 'kcal', 'kJ', 'values', 'keywords', 'portions'],
    nutrients: cols,
    foodGroups: groups.foodGroups.reduce((m, g) => { m[g.foodGroupId] = g.name; return m; }, {}),
    foods: out
  };

  // One food per line: 600 kB on a single line is unreviewable, and a diff
  // that shows "salt in kjøttdeig went from 1,1 to 0,9" is the whole point of
  // committing the file rather than fetching it at build time.
  const json = '{\n'
    + Object.keys(payload).filter((k) => k !== 'foods')
      .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(payload[k])}`).join(',\n')
    + ',\n  "foods": [\n'
    + out.map((f) => '    ' + JSON.stringify(f)).join(',\n')
    + '\n  ]\n}\n';

  let before = null;
  try { before = JSON.parse(await readFile(OUT, 'utf8')); } catch (e) { /* first run */ }
  report(before, payload, json.length);

  if (dry) { console.log('--dry: nutrition.json left alone'); return; }
  await writeFile(OUT, json);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}

function report(before, after, bytes) {
  console.log(`${after.foods.length} matvarer, ${after.nutrients.length} næringsstoffer, ${Math.round(bytes / 1024)} kB`);
  if (!before) return;
  const was = {}; (before.foods || []).forEach((f) => { was[f[0]] = f; });
  const is = {}; after.foods.forEach((f) => { is[f[0]] = f; });
  const added = after.foods.filter((f) => !was[f[0]]);
  const gone = (before.foods || []).filter((f) => !is[f[0]]);
  const changed = after.foods.filter((f) => was[f[0]] && JSON.stringify(was[f[0]]) !== JSON.stringify(f));
  console.log(`+${added.length} nye, −${gone.length} fjernet, ~${changed.length} endret`);
  added.slice(0, 10).forEach((f) => console.log(`  + ${f[0]} ${f[1]}`));
  gone.slice(0, 10).forEach((f) => console.log(`  − ${f[0]} ${f[1]}`));
  if (before.edition !== after.edition) console.log(`  utgave ${before.edition} → ${after.edition}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
