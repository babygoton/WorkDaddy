'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPrimaryAccountStore } = require('../scripts/primary-account');
test('primary selection is unique, persistent, validated and cleared on deletion', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-primary-'));
  const accounts = new Set(['a', 'b']);
  try {
    const store = createPrimaryAccountStore(dir, uid => accounts.has(uid));
    assert.equal(store.get(), '');
    assert.equal(store.set('a'), 'a');
    assert.equal(createPrimaryAccountStore(dir, uid => accounts.has(uid)).get(), 'a');
    store.set('b');
    assert.equal(store.get(), 'b');
    assert.throws(() => store.set('../x'), /无效/);
    assert.throws(() => store.set('missing'), /不存在/);
    assert.equal(store.get(), 'b');
    accounts.delete('b');
    assert.equal(store.get(), '');
    accounts.add('b');
    assert.equal(store.get(), '', 'deleted selection cannot revive');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('account page no longer exposes primary selection or badges', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  assert.doesNotMatch(source, /PRIMARY_ACCOUNT_SVG|data-primary-uid|wbs-primary-mark|primaryAction/);
});
