/*
 * Unit tests for the price-history chart's inputs.
 *
 * These exist because of a specific defect that reached production and was
 * visible to Google before it was visible to us. ml_price_history keeps one
 * row per (SERVER group_key, store, day), but a client group can merge several
 * server keys onto one page — "kjottdeig storfe" merges 40 — so one chain on
 * one day arrived as up to 30 rows spanning 0,80 to 252 kr. Each row became
 * its own point, all of them stacked on the same x, and the polyline drew a
 * vertical scribble through the lot. The y-axis, padded below the minimum,
 * labelled its bottom gridline "-37 kr".
 *
 * Run: `node --test` (no dependencies, no build step).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../app.js');

// storeSeries reads STORE_NAME/STORE_STYLE for the label and colour; buildStores
// populates them. The ids are what the tests assert on.
lib.buildStores([
  { id: 'rema', name: 'Rema 1000', color: '#1553A6', sort_order: 0 },
  { id: 'kiwi', name: 'Kiwi', color: '#3DA935', sort_order: 1 },
  { id: 'meny', name: 'Meny', color: '#8B1D41', sort_order: 3 }
]);

const row = (store, date, price, name) => ({ store_id: store, observed_at: date, price: price, product_name: name || 'Vare 400g' });

test('storeSeries — one point per store per date, the cheapest of the day', () => {
  const series = lib.storeSeries([
    row('meny', '2026-07-27', 115, 'Kjøttdeig Storfe Magrere 10% 600g Meny'),
    row('meny', '2026-07-27', 225, 'Kjøttdeig Av Storfe pr Kg'),
    row('meny', '2026-07-27', 69.9, 'Kjøttdeig 14% Fett 400g First Price'),
    row('meny', '2026-08-03', 84, 'Kjøttdeig Angus 14% 400g Meny')
  ]);
  assert.equal(series.length, 1);
  assert.deepEqual(series[0].points, [
    { date: '2026-07-27', value: 69.9 },
    { date: '2026-08-03', value: 84 }
  ]);
  // The count is what lets the caption admit the line stands for more rows
  // than it draws, instead of implying a fuller history than it has.
  assert.equal(series[0].collapsed, 2);
});

test('storeSeries — stores stay separate, and a clean history collapses nothing', () => {
  const series = lib.storeSeries([
    row('kiwi', '2026-07-27', 63.9),
    row('rema', '2026-07-27', 64.9),
    row('kiwi', '2026-08-03', 59.9)
  ]);
  const by = Object.fromEntries(series.map((s) => [s.id, s]));
  assert.deepEqual(by.kiwi.points.map((p) => p.value), [63.9, 59.9]);
  assert.deepEqual(by.rema.points.map((p) => p.value), [64.9]);
  assert.equal(by.kiwi.collapsed, 0);
  assert.equal(by.rema.collapsed, 0);
});

test('storeSeries — non-positive and unusable values are dropped, not plotted as zero', () => {
  const series = lib.storeSeries([
    row('kiwi', '2026-07-27', 0),
    row('kiwi', '2026-07-27', -5),
    row('kiwi', '2026-08-03', 59.9)
  ]);
  assert.equal(series.length, 1);
  assert.deepEqual(series[0].points, [{ date: '2026-08-03', value: 59.9 }]);
});

test('storeSeries — valueOf converts, and a null from it drops the point', () => {
  const series = lib.storeSeries(
    [row('kiwi', '2026-07-27', 40), row('kiwi', '2026-08-03', 50)],
    (r) => (r.observed_at === '2026-08-03' ? null : Number(r.price) / 0.4)
  );
  assert.deepEqual(series[0].points, [{ date: '2026-07-27', value: 100 }]);
});

test('storeSeries — the cheapest wins regardless of the order rows arrive in', () => {
  const cheapFirst = lib.storeSeries([row('meny', '2026-07-27', 20), row('meny', '2026-07-27', 200)]);
  const cheapLast = lib.storeSeries([row('meny', '2026-07-27', 200), row('meny', '2026-07-27', 20)]);
  assert.equal(cheapFirst[0].points[0].value, 20);
  assert.equal(cheapLast[0].points[0].value, 20);
});

test('chartFrom — the price axis never drops below zero', () => {
  // A wide range is what used to push the padded floor negative: this series
  // spans 0,80 to 252 kr, exactly the spread that produced "-37 kr".
  const c = lib.chartFrom([{ id: 'meny', name: 'Meny', points: [
    { date: '2026-07-27', value: 0.8 },
    { date: '2026-08-03', value: 252 }
  ] }]);
  const negative = c.grid.filter((g) => g.label.trim().startsWith('-'));
  assert.equal(negative.length, 0, `negative gridline(s): ${c.grid.map((g) => g.label).join(', ')}`);
});

test('chartFrom — a flat series still gets a zero-or-higher axis', () => {
  // The zero-range branch takes its own padding path, so it needs its own case.
  const c = lib.chartFrom([{ id: 'rema', name: 'Rema 1000', points: [
    { date: '2026-07-27', value: 5 },
    { date: '2026-08-03', value: 5 }
  ] }]);
  assert.equal(c.grid.filter((g) => g.label.trim().startsWith('-')).length, 0);
});

test('chartFrom — one x position per date, so a line cannot double back', () => {
  const series = lib.storeSeries([
    row('meny', '2026-07-27', 115),
    row('meny', '2026-07-27', 225),
    row('meny', '2026-08-03', 84)
  ]);
  const c = lib.chartFrom(series);
  const xs = c.lines[0].points.split(' ').map((p) => p.split(',')[0]);
  assert.equal(xs.length, 2);
  assert.equal(new Set(xs).size, 2, 'two points must sit on two distinct x positions');
});
