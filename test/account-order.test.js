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
