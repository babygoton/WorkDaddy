'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'missing credit refresh section');
  return source.slice(from, to);
}

test('growth action links never claim rewards or refresh credits locally', () => {
  const actions = section('    function openOfficialGrowthCenter()', '    function setupDailyProgressPopover()');
  assert.match(actions, /https:\/\/www\.workbuddy\.cn\/profile\/growth-center/);
  assert.doesNotMatch(actions, /refreshCreditForAccount|\/api\/growth\//);
});

test('a reward refresh updates one credit cell and ignores older batch results', async () => {
  const creditSource = section('    function requestCredit(uid)', '    function updateCreditCell(uid, credits, segments)');
  const calls = [];
  const cells = [];
  const accounts = [
    { uid: 'a', credits: 10, creditSegments: [{ remaining: 10 }] },
    { uid: 'b', credits: 20, creditSegments: [{ remaining: 20 }] },
  ];
  const context = vm.createContext({
    state: { accounts, open: true, creditRunId: 1, creditRefreshGeneration: {}, creditRemaining: 0 },
    alive: true,
    setTimeout: () => 1, clearTimeout() {},
    api(route, options) {
      return new Promise((resolve, reject) => calls.push({ route, uid: JSON.parse(options.body).uid, resolve, reject }));
    },
    updateCreditCell(uid, credits, segments) { cells.push({ uid, credits, segments }); },
    updateAccountSummary() {},
  });
  vm.runInContext(creditSource, context);
  const first = context.refreshCreditForAccount('a');
  const second = context.refreshCreditForAccount('a');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => [call.route, call.uid]), [['/api/credits', 'a'], ['/api/credits', 'a']]);
  calls[1].resolve({ credits: 15, segments: [{ remaining: 15 }], unlimited: false });
  await second;
  calls[0].resolve({ credits: 11, segments: [{ remaining: 11 }] });
  await first;
  assert.equal(accounts[0].credits, 15);
  assert.equal(accounts[1].credits, 20);
  assert.deepEqual(cells.map(cell => [cell.uid, cell.credits]), [['a', 15]]);
  assert.equal(context.state.creditSummaryValue, 35);
});

test('a pending batch cannot overwrite the result of a completed reward refresh', async () => {
  const creditSource = section('    function requestCredit(uid)', '    function updateCreditCell(uid, credits, segments)');
  const calls = [];
  const account = { uid: 'a', credits: 10, creditSegments: [] };
  const context = vm.createContext({
    state: { accounts: [account], open: true, creditRunId: 0, creditRefreshGeneration: {}, creditRemaining: 0 },
    alive: true,
    setTimeout: () => 1, clearTimeout() {}, setBuildTimeout: fn => fn(),
    api(route, options) {
      return new Promise((resolve, reject) => calls.push({ route, uid: JSON.parse(options.body).uid, resolve, reject }));
    },
    updateCreditCell() {}, updateAccountSummary() {}, sortAccountsByCreditExpiry() {}, reorderAccountCards() {},
  });
  vm.runInContext(creditSource, context);
  const refreshed = context.refreshCreditForAccount('a');
  context.fetchCreditsForAccounts();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  calls[0].resolve({ credits: 25, segments: [] });
  await refreshed;
  calls[1].resolve({ credits: 10, segments: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(account.credits, 25);
});

test('a temporary reward credit refresh failure preserves cached credits', async () => {
  const creditSource = section('    function requestCredit(uid)', '    function updateCreditCell(uid, credits, segments)');
  const account = { uid: 'a', credits: 10, creditSegments: [] };
  let rejectRequest;
  const context = vm.createContext({
    state: { accounts: [account], open: true, creditRunId: 0, creditRefreshGeneration: {}, creditRemaining: 0 },
    alive: true, setTimeout: () => 1, clearTimeout() {},
    api() { return new Promise((resolve, reject) => { rejectRequest = reject; }); },
    updateCreditCell() { throw new Error('cached value should be left alone'); },
    updateAccountSummary() {},
  });
  vm.runInContext(creditSource, context);
  const refreshed = context.refreshCreditForAccount('a');
  rejectRequest(new Error('temporary network failure'));
  await refreshed;
  assert.equal(account.credits, 10);
});
