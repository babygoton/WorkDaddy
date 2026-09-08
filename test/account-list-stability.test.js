'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const tick = () => new Promise(resolve => setImmediate(resolve));
const account = (uid, expiry) => ({ uid, nickname: uid, credits: 10, creditSegments: [{ remaining: 10, expiresAt: expiry }] });

function harness() {
  const requests = [];
  function el(tag, className) {
    return {
      className, children: [], attrs: {}, dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
      appendChild(child) { this.children = this.children.filter(value => value !== child); this.children.push(child); },
      insertBefore(child) { this.appendChild(child); },
      querySelector(selector) { return selector === '.wbs-acct-list' ? this.children.find(c => c.className === 'wbs-acct-list') : null; },
      querySelectorAll(selector) { return selector === '.wbs-card' ? this.children.filter(c => c.className.startsWith('wbs-card')) : []; },
      set innerHTML(value) { this.children = []; this.html = value; }, get innerHTML() { return this.html || ''; },
    };
  }
  const pane = el('div', 'pane');
  const ctx = vm.createContext({
    window: {},
    state: { accounts: [], current: null, open: true, creditRunId: 0, activityRunId: 0, creditRemaining: 0 },
    alive: true, CAPS: { accounts: true }, accountsPane: pane, panel: el(), fab: el(), fabQuietMode: { wake() {} },
    api(route, options) { return new Promise((resolve, reject) => requests.push({ route, options, resolve, reject })); },
    el, esc: String, escAttr: String, tokenState: () => ({ label: '-' }), isIdentityExpired: a => !!a.identityExpired,
    checkinBadgeHtml: () => '', creditBlockHtml: () => '', applyAccountMask() {}, updateAccountSummary() {},
    updateCheckinCells() {}, updateCreditCell() {}, fetchActivityForAccounts() {}, toast() {}, root: {},
    PRIMARY_ACCOUNT_SVG: '', SWITCH_SVG: '', TRASH_SVG: '',
    setBuildTimeout: fn => fn(), setTimeout: () => 1, clearTimeout() {},
    checkForUpdate() {}, acCheckPromptOnOpen() {}, syncSessionModule() {},
  });
  vm.runInContext([
    section('  function isKnownActivityStreak(', '  function el(tag'),
    section('    function nearestCreditExpiry(', '    function pollAutoCopyJob('),
    section('    function render(data)', '    function maskAccountName('),
    section('    function refresh()', '    function updateAccountSummary('),
    section('    function fetchCreditsForAccounts()', '    function updateCreditCell('),
    section('    function setOpen(', '    function setupFabDrag('),
  ].join('\n'), ctx);
  return { ctx, requests, pane, order: () => Array.from(ctx.state.accounts, a => a.uid), cards: () => pane.querySelector('.wbs-acct-list').children.slice() };
}

test('metadata refresh retains cached credits, sorted order and the actual buttons/cards', () => {
  const h = harness();
  h.ctx.render({ accounts: [account('later', 200), account('soon', 100)] });
  const before = h.cards();
  h.ctx.render({ accounts: [{ uid: 'later', nickname: 'later' }, { uid: 'soon', nickname: 'soon' }] });
  assert.deepEqual(h.order(), ['soon', 'later']);
  assert.equal(h.ctx.state.accounts[0].credits, 10);
  assert.equal(h.cards()[0], before[0]);
});

test('credit responses never move a visible account; next opening applies expiry order', async () => {
  const h = harness();
  h.ctx.render({ accounts: [account('a', 100), account('b', 200)] });
  const before = h.cards();
  h.ctx.fetchCreditsForAccounts();
  await tick();
  h.requests.find(r => JSON.parse(r.options.body).uid === 'b').resolve({ credits: 10, segments: [{ remaining: 10, expiresAt: 50 }] });
  h.requests.find(r => JSON.parse(r.options.body).uid === 'a').resolve({ credits: 10, segments: [{ remaining: 10, expiresAt: 300 }] });
  await tick();
  assert.deepEqual(h.order(), ['a', 'b']);
  assert.deepEqual(h.cards(), before);
  h.ctx.setOpen(false);
  h.ctx.setOpen(true, { automation: true });
  assert.deepEqual(h.order(), ['b', 'a']);
  assert.equal(h.cards()[0], before[1]);
});

test('older overlapping account responses cannot restore stale accounts', async () => {
  const h = harness();
  h.ctx.refresh(); h.ctx.refresh();
  h.requests[1].resolve({ accounts: [account('new', 100)] }); await tick();
  h.requests[0].resolve({ accounts: [account('old', 100)] }); await tick();
  assert.deepEqual(h.order(), ['new']);
});

test('temporary credit failures retain the cached value but expired identity clears it', async () => {
  const h = harness();
  h.ctx.render({ accounts: [account('network', 100), account('expired', 200)] });
  h.ctx.fetchCreditsForAccounts(); await tick();
  h.requests[0].reject(new Error('temporary network failure'));
  h.requests[1].reject({ payload: { expired: true } }); await tick();
  assert.equal(h.ctx.state.accounts.find(a => a.uid === 'network').credits, 10);
  assert.equal(h.ctx.state.accounts.find(a => a.uid === 'expired').credits, null);
  assert.equal(h.ctx.state.accounts.find(a => a.uid === 'expired').creditExpired, true);
});

test('account refresh errors retain the cached list', async () => {
  const h = harness(); h.ctx.render({ accounts: [account('a', 100)] });
  const before = h.cards()[0];
  h.ctx.refresh(); h.requests[0].reject(new Error('offline')); await tick();
  assert.ok(h.pane.querySelector('.wbs-acct-list'));
  assert.equal(h.cards()[0], before);
});

test('deleted accounts stay removed and new accounts append without moving survivors', () => {
  const h = harness(); h.ctx.render({ accounts: [account('a', 100), account('b', 200)] });
  h.ctx.render({ accounts: [account('new', 1), { uid: 'b', nickname: 'b' }] });
  assert.deepEqual(h.order(), ['b', 'new']);
});

test('closing the panel invalidates pending account responses', async () => {
  const h = harness(); h.ctx.render({ accounts: [account('cached', 100)] });
  const before = h.cards()[0];
  h.ctx.refresh(); h.ctx.setOpen(false);
  h.requests[0].resolve({ accounts: [account('stale', 10)] }); await tick();
  assert.deepEqual(h.order(), ['cached']);
  assert.equal(h.cards()[0], before);
});

test('account refresh after re-opening keeps the newly sorted card nodes', async () => {
  const h = harness(); h.ctx.render({ accounts: [account('a', 100), account('b', 200)] });
  h.ctx.state.accounts[1].creditSegments = [{ remaining: 10, expiresAt: 50 }];
  h.ctx.setOpen(false); h.ctx.setOpen(true, { automation: true });
  const before = h.cards();
  h.requests[0].resolve({ accounts: [{ uid: 'a', nickname: 'a' }, { uid: 'b', nickname: 'b' }] }); await tick();
  assert.deepEqual(h.order(), ['b', 'a']);
  assert.equal(h.cards()[0], before[0]);
  assert.equal(h.cards()[1], before[1]);
});

test('fresh current-account and identity changes update card controls', () => {
  const h = harness(); h.ctx.render({ accounts: [account('a', 100), account('b', 200)] });
  const before = h.cards();
  h.ctx.render({ current: { uid: 'b' }, accounts: [{ ...account('a', 100), identityExpired: true }, account('b', 200)] });
  assert.deepEqual(h.order(), ['a', 'b']);
  assert.notEqual(h.cards()[0], before[0]);
  assert.equal(h.cards()[1].className, 'wbs-card cur');
});

test('account metadata refresh retains valid activity days while the server cache is missing or failed', () => {
  const h = harness();
  h.ctx.render({ accounts: [{ ...account('a', 100), activityStreak: { days: 5, status: 'ready' } }] });
  for (const activityStreak of [null, { days: null, status: 'unavailable' }]) {
    h.ctx.render({ accounts: [{ uid: 'a', nickname: 'a', activityStreak }] });
    assert.equal(h.ctx.state.accounts[0].activityStreak.days, 5);
  }
  h.ctx.render({ accounts: [{ uid: 'a', nickname: 'a', activityStreak: { days: 0, status: 'ready' } }] });
  assert.equal(h.ctx.state.accounts[0].activityStreak.days, 0);
});
