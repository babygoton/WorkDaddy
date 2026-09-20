'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createAccountCreditCache } = require('../scripts/account-credit-cache');
const automation = require('../scripts/automation');
const credit = expiry => ({ credits: 10, segments: [{ remaining: 10, total: 20, expiresAt: expiry, source: 'test' }] });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-credit-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cache: createAccountCreditCache(root) };
}
test('cached credits survive restart and persist only public credit fields', t => {
  const { root, cache } = fixture(t);
  cache.set('a', { ...credit(200), accessToken: 'secret', auth: { cookie: 'secret' } });
  const restored = createAccountCreditCache(root).get('a');
  assert.equal(restored.credits, 10); assert.equal(restored.creditSegments[0].expiresAt, 200);
  restored.creditSegments[0].expiresAt = 0;
  assert.equal(cache.get('a').creditSegments[0].expiresAt, 200);
  const file = path.join(root, 'account-credit-cache.json');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /secret|accessToken|auth|cookie/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, '{invalid');
  assert.deepEqual(createAccountCreditCache(root).get('a'), {});
});
test('check-in iteration freezes cached expiry order, remains sequential and leaves unrelated loops alone', async t => {
  const { cache } = fixture(t);
  cache.set('later', credit(200)); cache.set('soon', credit(100)); cache.set('tie', credit(100));
  const accounts = ['unknown', 'later', 'soon', 'tie'].map(uid => ({ uid }));
  const task = { id: 'ordered', steps: [{ op: 'account.forEach', accounts: 'all', steps: [{ op: 'logic.catch', steps: [{ op: 'account.checkin' }], onError: [] }] }] };
  const seen = []; let active = 0, sorts = 0;
  const options = {
    listAccounts: async () => accounts,
    orderCheckinAccounts: values => { sorts++; return cache.order(values); },
    accountCheckin: async account => {
      assert.equal(active++, 0); seen.push(account.uid);
      cache.set('later', credit(1));
      await new Promise(resolve => setImmediate(resolve)); active--;
      if (account.uid === 'soon') throw Error('offline');
      return { ok: true };
    },
  };
  await automation.executeTask(task, options);
  assert.deepEqual(seen, ['soon', 'tie', 'later', 'unknown']); assert.equal(sorts, 1);
  assert.deepEqual(accounts.map(a => a.uid), ['unknown', 'later', 'soon', 'tie']);
  await automation.executeTask({ id: 'other', steps: [{ op: 'account.forEach', accounts: 'all', steps: [] }] }, options);
  assert.equal(sorts, 1);
});
