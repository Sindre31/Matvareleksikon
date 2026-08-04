'use strict';
/*
 * Tilbakemelding — the checks between what someone types in the floating
 * "Gi tilbakemelding" dialog and the ml_feedback row it becomes.
 *
 * Lower stakes than the report flow (nothing here is applied to the catalogue
 * automatically — a person reads it), but the table's CHECK constraints will
 * reject a bad draft with a Postgres error code the sender can do nothing
 * with. These are the same rules, stated where they can be turned into a
 * sentence that says what to fix.
 *
 * Run: `node --test` (no dependencies, no build step).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../app.js');

const draft = (over) => Object.assign({
  kind: 'annet', message: 'Søket finner ikke rugmel.', email: '', path: '/', sender: 'r1'
}, over || {});

test('a plain message becomes a row', () => {
  const { payload, error } = lib.feedbackPayload(draft());
  assert.equal(error, undefined);
  assert.deepEqual(payload, {
    kind: 'annet', message: 'Søket finner ikke rugmel.',
    email: null, path: '/', sender: 'r1'
  });
});

test('the message is required and bounded', () => {
  assert.match(lib.feedbackPayload(draft({ message: '' })).error, /Skriv hva du vil si/);
  assert.match(lib.feedbackPayload(draft({ message: '   ' })).error, /Skriv hva du vil si/);
  assert.match(lib.feedbackPayload(draft({ message: 'x' })).error, /Skriv hva du vil si/);
  assert.match(lib.feedbackPayload(draft({ message: 'a'.repeat(2001) })).error, /2000 tegn/);
  // The table's CHECK counts the trimmed length, so this one must pass here too.
  assert.equal(lib.feedbackPayload(draft({ message: 'a'.repeat(2000) })).error, undefined);
});

test('the message is trimmed but its line breaks survive', () => {
  const { payload } = lib.feedbackPayload(draft({ message: '  linje 1\nlinje 2  ' }));
  assert.equal(payload.message, 'linje 1\nlinje 2');
});

test('e-post is optional, lowercased, and checked when given', () => {
  assert.equal(lib.feedbackPayload(draft({ email: '' })).payload.email, null);
  assert.equal(lib.feedbackPayload(draft({ email: '  Kari@Eksempel.NO ' })).payload.email, 'kari@eksempel.no');
  assert.match(lib.feedbackPayload(draft({ email: 'kari' })).error, /e-postadressen/);
  assert.match(lib.feedbackPayload(draft({ email: 'kari@eksempel' })).error, /e-postadressen/);
  assert.match(lib.feedbackPayload(draft({ email: 'kari @eksempel.no' })).error, /e-postadressen/);
  assert.match(lib.feedbackPayload(draft({ email: 'k@'.repeat(200) + 'a.no' })).error, /e-postadressen/);
});

test('kind falls back to annet rather than failing the CHECK', () => {
  assert.equal(lib.feedbackPayload(draft({ kind: 'feil' })).payload.kind, 'feil');
  assert.equal(lib.feedbackPayload(draft({ kind: 'onske' })).payload.kind, 'onske');
  assert.equal(lib.feedbackPayload(draft({ kind: 'ros' })).payload.kind, 'ros');
  assert.equal(lib.feedbackPayload(draft({ kind: 'tull' })).payload.kind, 'annet');
  assert.equal(lib.feedbackPayload(draft({ kind: undefined })).payload.kind, 'annet');
});

test('path is capped at the column width and empty becomes null', () => {
  assert.equal(lib.feedbackPayload(draft({ path: '' })).payload.path, null);
  assert.equal(lib.feedbackPayload(draft({ path: null })).payload.path, null);
  assert.equal(lib.feedbackPayload(draft({ path: '/gruppe/' + 'a'.repeat(600) })).payload.path.length, 512);
});

test('a missing sender is null, not the string "undefined"', () => {
  assert.equal(lib.feedbackPayload(draft({ sender: null })).payload.sender, null);
  assert.equal(lib.feedbackPayload(draft({ sender: undefined })).payload.sender, null);
});

test('an empty draft is rejected without throwing', () => {
  assert.match(lib.feedbackPayload().error, /Skriv hva du vil si/);
  assert.match(lib.feedbackPayload({}).error, /Skriv hva du vil si/);
});
