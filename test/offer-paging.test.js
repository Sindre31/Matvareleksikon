'use strict';
/*
 * Cold-start offer paging (app.js `fetchAllOffers`).
 *
 * The paging code lives inside app.js's IIFE and closes over `sb`, so unlike
 * the pure price/grouping helpers it can't simply be require()d. Rather than
 * reimplement it here — a copy would drift from the real thing and prove
 * nothing — the block is lifted out of the source and evaluated with a mock
 * PostgREST injected in place of `sb`. What runs below is the shipped code.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const START = '  var OFFER_COLS = ';
const END = '\n  // ── Cold-start cache';

function pagingSource() {
  const a = SRC.indexOf(START);
  const b = SRC.indexOf(END);
  assert.ok(a > 0 && b > a, 'could not locate the offer-paging block in app.js — did its markers move?');
  return SRC.slice(a, b);
}

// Build the block with `sb` supplied by the test.
function load(sb) {
  return new Function('sb', pagingSource() + '\n; return { fetchAllOffers: fetchAllOffers };')(sb);
}

/*
 * Mock PostgREST. `rowsAt` is invoked per request so a test can grow the table
 * mid-flight; `opts.noCountHeader` drops Content-Range (the serial fallback)
 * and `opts.failAt` makes one offset return a 500.
 */
function mockSb(rowsAt, opts) {
  opts = opts || {};
  const state = { inFlight: 0, maxInFlight: 0, offsets: [] };
  const sb = function (urlPath, o) {
    const offset = Number(/offset=(\d+)/.exec(urlPath)[1]);
    const limit = Number(/limit=(\d+)/.exec(urlPath)[1]);
    const wantsCount = !!(o && o.headers && o.headers.Prefer === 'count=exact');
    state.offsets.push(offset);
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    return new Promise(function (resolve) {
      setTimeout(function () {
        state.inFlight--;
        if (opts.failAt != null && offset === opts.failAt) {
          resolve({ ok: false, status: 500, headers: { get: function () { return null; } } });
          return;
        }
        const all = rowsAt(offset);
        const page = all.slice(offset, offset + limit);
        const range = (wantsCount && !opts.noCountHeader)
          ? offset + '-' + (offset + Math.max(page.length - 1, 0)) + '/' + all.length
          : null;
        resolve({
          ok: true,
          status: 200,
          headers: { get: function (k) { return k === 'Content-Range' ? range : null; } },
          json: function () { return Promise.resolve(page); }
        });
      }, 1);
    });
  };
  return { sb: sb, state: state };
}

const rows = (n) => Array.from({ length: n }, (_, i) => ({ i: i }));
const ids = (a) => a.map((r) => r.i);

test('fetches the whole catalogue, in order, without duplicating rows', async () => {
  const table = rows(49584); // the real row count at the time of writing
  const m = mockSb(() => table);
  const out = await load(m.sb).fetchAllOffers();
  assert.strictEqual(out.length, 49584);
  assert.deepStrictEqual(ids(out), ids(table));
  assert.strictEqual(m.state.offsets.length, 50, 'one request per page, no repeats');
});

test('pages go out concurrently, capped at the lane limit', async () => {
  const m = mockSb(() => rows(49584));
  await load(m.sb).fetchAllOffers();
  assert.ok(m.state.maxInFlight > 1, 'expected concurrent requests, got serial');
  assert.ok(m.state.maxInFlight <= 6, 'lane cap exceeded: ' + m.state.maxInFlight);
});

test('falls back to serial paging when Content-Range is missing', async () => {
  const table = rows(4200);
  const m = mockSb(() => table, { noCountHeader: true });
  const out = await load(m.sb).fetchAllOffers();
  assert.deepStrictEqual(ids(out), ids(table));
  assert.strictEqual(m.state.maxInFlight, 1);
});

test('picks up rows appended between the count and the last page', async () => {
  // The count probe sees 3000 rows; by the time the pages land there are 4500.
  let call = 0;
  const m = mockSb(() => rows(call++ === 0 ? 3000 : 4500));
  const out = await load(m.sb).fetchAllOffers();
  assert.deepStrictEqual(ids(out), ids(rows(4500)), 'tail dropped or duplicated');
});

test('a total that is an exact multiple of the page size yields no duplicates', async () => {
  // The last page comes back full, which is indistinguishable from "more rows
  // were appended", so one confirming request follows. That extra round trip is
  // the deliberate price of the mop-up above.
  const m = mockSb(() => rows(3000));
  const out = await load(m.sb).fetchAllOffers();
  assert.deepStrictEqual(ids(out), ids(rows(3000)));
  assert.strictEqual(m.state.offsets.length, 4);
});

test('a catalogue smaller than one page costs a single request', async () => {
  const m = mockSb(() => rows(120));
  const out = await load(m.sb).fetchAllOffers();
  assert.strictEqual(out.length, 120);
  assert.strictEqual(m.state.offsets.length, 1);
});

test('an empty table resolves empty', async () => {
  const m = mockSb(() => []);
  assert.deepStrictEqual(await load(m.sb).fetchAllOffers(), []);
});

test('a failing page rejects rather than yielding a partial catalogue', async () => {
  const m = mockSb(() => rows(10000), { failAt: 5000 });
  await assert.rejects(load(m.sb).fetchAllOffers(), /offers 500/);
});

test('a failing first page rejects', async () => {
  const m = mockSb(() => rows(10000), { failAt: 0 });
  await assert.rejects(load(m.sb).fetchAllOffers(), /offers 500/);
});
