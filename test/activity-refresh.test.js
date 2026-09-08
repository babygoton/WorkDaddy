'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const requests = [], timers = [];
  const start = source.includes('    var activityBatchPromise') ? source.indexOf('    var activityBatchPromise') : source.indexOf('    function fetchActivityForAccounts()');
  const end = source.indexOf('    // 积分查询按', start);
  const badgeStart = source.indexOf('  function activityStreakHtml(');
  const ctx = vm.createContext({
    alive: true, WBS_PROFILE_IS_AI: false, CAPS: { accounts: true },
    state: { open: true, activityRunId: 0, accounts: [{ uid: 'a' }, { uid: 'b' }, { uid: 'c' }] },
    api() { return new Promise((resolve, reject) => requests.push({ resolve, reject })); },
    accountsPane: { querySelectorAll: () => [] },
    setBuildTimeout(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    Date: class extends Date { static now() { return 100000; } },
  });
  vm.runInContext(source.slice(badgeStart, source.indexOf('  function el(tag', badgeStart)) + source.slice(start, end), ctx);
  return { ctx, requests, timers };
}

test('an activity failure retains the last valid count and schedules one delayed retry', async () => {
  const h = harness(); h.ctx.state.accounts = [{ uid: 'a', activityStreak: { days: 5, status: 'ready' } }];
  h.ctx.fetchActivityForAccounts();
  h.requests[0].resolve({ activityStreak: { days: null, status: 'unavailable', fetchedAt: 100000 } }); await tick();
  assert.equal(h.ctx.state.accounts[0].activityStreak.days, 5);
  assert.equal(h.timers.length, 1);
  assert.ok(h.timers[0].delay >= 30000);
  h.timers[0].fn(); await tick();
  assert.equal(h.requests.length, 2);
  h.requests[1].reject(new Error('still offline')); await tick();
  assert.equal(h.timers.length, 1, 'never retry indefinitely');
});

test('reopening while activity requests are pending never starts more than two requests', async () => {
  const h = harness(); h.ctx.fetchActivityForAccounts();
  assert.equal(h.requests.length, 2);
  h.ctx.state.activityRunId++; h.ctx.fetchActivityForAccounts();
  assert.equal(h.requests.length, 2);
  h.requests[0].resolve({ activityStreak: { days: 99, status: 'ready' } });
  h.requests[1].resolve({ activityStreak: { days: 99, status: 'ready' } }); await tick();
  assert.equal(h.requests.length, 4);
  assert.equal(h.ctx.state.accounts[0].activityStreak, undefined, 'old responses must not update the new run');
});

test('closing the panel prevents the delayed retry', async () => {
  const h = harness(); h.ctx.state.accounts = [{ uid: 'a' }];
  h.ctx.fetchActivityForAccounts(); h.requests[0].reject(new Error('offline')); await tick();
  assert.equal(h.timers.length, 1);
  h.ctx.state.open = false; h.ctx.state.activityRunId++;
  h.timers[0].fn(); await tick();
  assert.equal(h.requests.length, 1);
});

test('reinjection stops the old activity queue after its in-flight requests finish', async () => {
  const h = harness(); h.ctx.fetchActivityForAccounts();
  h.ctx.alive = false;
  for (const request of h.requests) request.resolve({ activityStreak: { days: 5, status: 'ready' } });
  await tick();
  assert.equal(h.requests.length, 2);
  assert.equal(h.ctx.state.accounts[0].activityStreak, undefined);
  assert.equal(h.timers.length, 0);
});
