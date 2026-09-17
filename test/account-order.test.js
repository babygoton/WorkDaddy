'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../scripts/lib.js');
test('fixed order survives reload, appends unsorted accounts and prunes deleted accounts', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-order-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const accounts = lib.accountsDir(dir); fs.mkdirSync(accounts, { recursive: true });
  for (const uid of ['a','b','c']) fs.writeFileSync(path.join(accounts, uid + '.info'), '{}');
  lib.setAccountOrder(dir, { mode: 'fixed', uids: ['b','a'] });
  assert.equal(lib.getAccountOrder(dir).mode, 'fixed');
  assert.deepEqual(Object.fromEntries(lib.listAccounts(dir).map(a => [a.uid, a.sort])), { a: 2, b: 1, c: 0 });
  fs.unlinkSync(path.join(accounts, 'b.info'));
  lib.setAccountOrder(dir, { mode: 'expiry', uids: ['b','a','c'] });
  assert.equal(lib.getAccountOrder(dir).mode, 'expiry');
  assert.equal(lib.listAccounts(dir).find(a => a.uid === 'a').sort, 1);
  assert.throws(() => lib.setAccountOrder(dir, { mode: 'bad', uids: [] }), /排序/);
  assert.throws(() => lib.setAccountOrder(dir, { mode: 'fixed', uids: ['a','a'] }), /排序/);
});

test('background auth backup and account switching preserve fixed sort metadata', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-order-refresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(lib.accountsDir(dir), { recursive: true });
  for (const uid of ['a','b']) fs.writeFileSync(path.join(lib.accountsDir(dir), uid + '.info'), '{}');
  lib.setAccountOrder(dir, { mode: 'fixed', uids: ['b','a'] });
  lib.updateMeta(dir, { uid: 'b', nickname: 'updated' }, { preserveBinding: true });
  lib.updateMeta(dir, { uid: 'a', nickname: 'switched' });
  assert.deepEqual(Object.fromEntries(lib.listAccounts(dir).map(a => [a.uid,a.sort])), { a: 2, b: 1 });
});

test('account settings save notes without touching auth backups and survive metadata refresh', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-account-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(lib.accountsDir(dir), { recursive: true });
  const backup = path.join(lib.accountsDir(dir), 'a.info');
  fs.writeFileSync(backup, '{}');
  const before = fs.readFileSync(backup);
  const result = lib.setAccountSettings(dir, { mode: 'fixed', uids: ['a'], notes: { a: '公司邮箱注册' } });
  assert.deepEqual(result, { mode: 'fixed' });
  assert.equal(lib.listAccounts(dir)[0].note, '公司邮箱注册');
  lib.updateMeta(dir, { uid: 'a', nickname: 'new name' });
  assert.equal(lib.listAccounts(dir)[0].note, '公司邮箱注册');
  assert.deepEqual(fs.readFileSync(backup), before);
  lib.setAccountOrder(dir, { mode: 'expiry', uids: ['a'] });
  assert.equal(lib.listAccounts(dir)[0].note, '公司邮箱注册');
  assert.throws(() => lib.setAccountSettings(dir, { mode: 'fixed', uids: ['a'], notes: { a: 'x'.repeat(161) } }), /备注/);
  assert.throws(() => lib.setAccountSettings(dir, { mode: 'fixed', uids: ['a'], notes: { '../a': 'x' } }), /备注/);
  assert.throws(() => lib.setAccountSettings(dir, { mode: 'fixed', uids: ['a'], notes: JSON.parse('{"__proto__":"x"}') }), /备注/);
  assert.equal(lib.listAccounts(dir)[0].note, '公司邮箱注册');
});
