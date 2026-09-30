'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
const ctx = { isIdentityExpired: a => !!a.expired };
vm.runInNewContext(source.slice(source.indexOf('  function summarizeCreditDays('), source.indexOf('  function checkinHtml(')), ctx);
test('summary counts credit segments once, grouping exact remaining days across accounts', () => {
  const now = 100000, day = 86400000;
  const result = ctx.summarizeCreditDays([
    { credits: 100, creditSegments: [{ remaining: 30, expiresAt: now + day }, { remaining: 70, expiresAt: now + 7 * day }] },
    { credits: 55, creditSegments: [{ remaining: 20, expiresAt: now + day }, { remaining: 5, expiresAt: null }] },
    { credits: null }, { credits: 100, creditUnlimited: true }, { credits: 30, expired: true },
  ], now);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { rows: [{ days: 1, credits: 50 }, { days: 7, credits: 70 }], accountCount: 5, unavailable: 2, unlimited: 1 });
});
test('zero, expired, malformed and stale oversized segments cannot inflate the total', () => {
  const result = ctx.summarizeCreditDays([{ credits: 12, creditSegments: [null, { remaining: 'bad' }, { remaining: -5 }, { remaining: 5, expiresAt: 1 }, { remaining: 100, expiresAt: 86400001 }] }], 2);
  assert.deepEqual(JSON.parse(JSON.stringify(result.rows)), [{ days: 0, credits: 5 }, { days: 1, credits: 7 }]);
  assert.equal(ctx.summarizeCreditDays([], 1).rows.length, 0);
});

test('summary scrollbars appear only while scrolling and reset on close or reinjection', () => {
  const listeners = new Map(), timers = new Map(); let serial = 0;
  const element = () => { const classes = new Set(); return { hidden: true, classes,
    classList: { add: x => classes.add(x), remove: x => classes.delete(x) },
    setAttribute() {}, contains: () => false, remove() {} }; };
  const button = element(), popup = element(), chart = element(); let dispose;
  const context = { accountsPane: { querySelector: () => button }, el: () => popup,
    mountPersistentOverlay() {}, clearTimeout: id => timers.delete(id),
    setBuildTimeout(fn) { timers.set(++serial, fn); return serial; },
    listen(node, type, fn) { listeners.set((node === popup ? 'popup:' : node === button ? 'button:' : 'other:') + type, fn); },
    window: {}, document: {}, root: {}, hideCreditTooltip() {}, registerDisposer: fn => { dispose = fn; } };
  const start = source.indexOf('    function setupCreditSummary()');
  vm.runInNewContext(source.slice(start, source.indexOf('    function openOfficialGrowthCenter()', start)), context);
  context.setupCreditSummary();
  assert.equal(chart.classes.has('is-scrolling'), false);
  listeners.get('popup:scroll')({ target: chart });
  assert.equal(chart.classes.has('is-scrolling'), true);
  listeners.get('popup:scroll')({ target: chart });
  assert.equal(timers.size, 1);
  timers.values().next().value();
  assert.equal(chart.classes.has('is-scrolling'), false);
  listeners.get('popup:scroll')({ target: chart });
  listeners.get('button:keydown')({ key: 'Escape', stopPropagation() {} });
  assert.equal(chart.classes.has('is-scrolling'), false);
  assert.equal(timers.size, 0);
  listeners.get('popup:scroll')({ target: chart });
  dispose();
  assert.equal(chart.classes.has('is-scrolling'), false);
  assert.equal(timers.size, 0);
  assert.match(source, /\.wbs-credit-summary-chart\{[^}]*scrollbar-color:transparent transparent/);
});
