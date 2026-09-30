'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const requests = [], todayRequests = [], timers = [], intervals = [];
  const start = source.includes('    var activityBatchPromise') ? source.indexOf('    var activityBatchPromise') : source.indexOf('    function fetchActivityForAccounts()');
  const end = source.indexOf('    // 积分查询按', start);
  const badgeStart = source.indexOf('  function activityStreakHtml(');
  const harnessToday = options.manualToday === true;
  const ctx = vm.createContext({
    alive: true, WBS_PROFILE_IS_AI: false, CAPS: { accounts: true },
    state: { open: true, activityRunId: 0, accounts: [{ uid: 'a' }, { uid: 'b' }, { uid: 'c' }] },
    api(route, options) {
      if (route === '/api/growth/today-active') {
        if (!harnessToday) return Promise.resolve({ ok: true, date: '1970-01-01', is_active: false });
        return new Promise((resolve, reject) => todayRequests.push({ resolve, reject, uid: JSON.parse(options.body).uid }));
      }
      return new Promise((resolve, reject) => requests.push({ resolve, reject }));
    },
    accountsPane: { querySelectorAll: () => [] },
    setBuildTimeout(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; },
    setBuildInterval(fn, delay) { intervals.push({ fn, delay }); },
    updateDailyProgressCells() {},
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    Date: class extends Date { static now() { return 100000; } },
  });
  vm.runInContext(source.slice(badgeStart, source.indexOf('  function el(tag', badgeStart)) + source.slice(start, end), ctx);
  return { ctx, requests, todayRequests, timers, intervals };
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


test('activity refresh reads the official today record independently of the streak and clears failed reads', async () => {
  const h = harness({ manualToday: true });
  h.ctx.state.accounts = [{ uid: 'a', checkin: { ok: true } }];
  h.ctx.fetchActivityForAccounts();
  h.requests[0].resolve({ activityStreak: { days: 5, status: 'ready' } }); await tick();
  assert.equal(h.todayRequests.length, 1);
  h.todayRequests[0].resolve({ ok: true, date: '1970-01-01', is_active: false }); await tick();
  assert.equal(h.ctx.state.accounts[0].growthTodayActive.is_active, false);
  h.ctx.fetchActivityForAccounts();
  h.requests[1].reject(new Error('streak unavailable')); await tick();
  h.todayRequests[1].resolve({ ok: true, date: '1970-01-01', is_active: true }); await tick();
  assert.equal(h.ctx.state.accounts[0].growthTodayActive.is_active, true);
  h.ctx.fetchActivityForAccounts();
  h.requests[2].resolve({ activityStreak: { days: 5, status: 'ready' } }); await tick();
  h.todayRequests[2].reject(new Error('today unavailable')); await tick();
  assert.equal(h.ctx.state.accounts[0].growthTodayActive, null);
});

test('closing during the today query discards the late result and stops the queue', async () => {
  const h = harness({ manualToday: true });
  h.ctx.fetchActivityForAccounts();
  for (const request of h.requests) request.resolve({ activityStreak: { days: 5, status: 'ready' } });
  await tick();
  assert.equal(h.todayRequests.length, 2);
  h.ctx.state.open = false; h.ctx.state.activityRunId++;
  for (const request of h.todayRequests) request.resolve({ ok: true, date: '1970-01-01', is_active: true });
  await tick();
  assert.equal(h.ctx.state.accounts[0].growthTodayActive, undefined);
  assert.equal(h.requests.length, 2);
});

test('an open panel rechecks backend activity periodically without overlapping a pending batch', async () => {
  const h = harness();
  const poll = h.intervals.find(timer => timer.delay === 60000);
  assert.ok(poll);
  poll.fn();
  assert.equal(h.requests.length, 2);
  poll.fn();
  assert.equal(h.requests.length, 2);
  h.ctx.state.open = false;
  for (const request of h.requests) request.resolve({ activityStreak: { days: 5, status: 'ready' } });
  await tick();
  poll.fn();
  assert.equal(h.requests.length, 2);
});
