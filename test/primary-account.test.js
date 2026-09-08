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
test('primary account uses a theme-aware vector mark and a separate setting action', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  assert.ok(!source.includes('wbs-auto-examples-card'));
  assert.ok(!source.includes('wbs-auto-protocol-copy'));
  assert.ok(source.includes('id="wbs-auto-create"'));
  assert.ok(source.includes('var PRIMARY_ACCOUNT_SVG ='));
  assert.ok(source.includes('wbs-primary-mark'));
  assert.ok(source.includes('var ops = primaryAction + (isCur'));
  assert.ok(source.includes('item.hidden = selected'));
  assert.match(source, /wbs-primary-mark\{[^}]*color:var\(--wb-button-primary-bg/);
  assert.ok(!source.includes('wbs-primary-account'));
});
