'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
function harness() {
  function element(attrs = {}) {
    const listeners = {}, classes = new Set();
    return { attrs, listeners, dataset: {}, style: {}, hidden: false, isConnected: true,
      classList: { contains: x => classes.has(x), toggle: (x, on) => on ? classes.add(x) : classes.delete(x) },
      addEventListener: (name, fn) => { listeners[name] = fn; }, focus() {}, remove() { this.isConnected = false; },
      getAttribute: key => attrs[key], setAttribute: (key, value) => { attrs[key] = value; }, removeAttribute: key => { delete attrs[key]; },
      querySelector: () => element(), querySelectorAll: () => [],
      click() { if (!this.disabled && listeners.click) listeners.click({}); },
    };
  }
  const tabs = ['credit', 'token'].map(kind => element({ 'data-usage-tab': kind }));
  tabs[0].classList.toggle('active', true);
  const panes = ['credit', 'token'].map(kind => element({ 'data-usage-pane': kind }));
  const periods = {};
  for (const kind of ['credit', 'token']) periods[kind] = [1, 7, 30, 90].map(days => {
    const el = element({ 'aria-pressed': String(days === 7) }); el.dataset[kind + 'Days'] = days; return el;
  });
  const overlay = element(), body = element(), mask = element(), refresh = element();
  mask.querySelectorAll = selector => selector === '[data-usage-tab]' ? tabs : selector === '[data-usage-pane]' ? panes
    : selector === '[data-token-days]' ? periods.token : selector === '[data-credit-days]' ? periods.credit : [];
  mask.querySelector = selector => {
    if (selector === '[data-usage-tab].active') return tabs.find(b => b.classList.contains('active'));
    for (const kind of ['token', 'credit']) if (selector === '[data-' + kind + '-days][aria-pressed="true"]') return periods[kind].find(b => b.attrs['aria-pressed'] === 'true');
    if (selector === '.wbs-token-stats-overlay') return overlay;
    if (selector === '.wbs-token-stats-body') return body;
    if (selector === '[data-usage-refresh]') return refresh;
    return element();
  };
  const calls = [], pending = [];
  const context = {
    document: { getElementById: () => null, createElement: () => mask }, root: { appendChild() {} },
    registerDisposer() {}, usageTimeSegmentHtml: () => '', setTimeout, clearTimeout,
    esc: String, escAttr: String, formatTokenCount: String, toast() {}, USAGE_REFRESH_ICON: '<svg></svg>',
    usageTrendChartHtml: () => '', usagePieHtml: () => '', wireUsagePies() {}, renderUsageBreakdown() {},
    api: url => {
      calls.push(url);
      if (url.includes('cacheStatus')) return Promise.resolve({ cacheReady: true });
      if (url.startsWith('/api/token-stats')) return new Promise(resolve => pending.push(resolve));
      return Promise.reject(Error('fixture: no credits'));
    },
  };
  const start = source.indexOf('    function onTokenStats()');
  vm.runInNewContext(source.slice(start, source.indexOf('\n    // ===== Tab 切换', start)), context);
  context.onTokenStats();
  return { calls, pending, tabs, periods, overlay, mask, refresh };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('opening Token starts the default seven-day query once and hides the spinner on completion', async () => {
  const h = harness(); await settle();
  assert.equal(h.calls.some(url => url.startsWith('/api/token-stats')), false);
  h.tabs[1].click(); await settle();
  assert.equal(h.calls.filter(url => url === '/api/token-stats?days=7').length, 1);
  h.tabs[0].click(); h.tabs[1].click(); await settle();
  assert.equal(h.pending.length, 1, 'tab toggling must reuse the in-flight request');
  h.pending.shift()({stats: {}, accounts: []}); await settle();
  assert.equal(h.overlay.hidden, true);
  assert.equal(h.periods.token.every(b => !b.disabled), true);
  h.tabs[0].click(); h.tabs[1].click(); await settle();
  assert.equal(h.calls.filter(url => url === '/api/token-stats?days=7').length, 1);
  h.periods.token[2].click(); await settle();
  assert.equal(h.calls.at(-1), '/api/token-stats?days=30');
  h.mask.__wbsClose();
  h.pending.shift()({stats: {}, accounts: []}); await settle();
  assert.equal(h.mask.isConnected, false);
});
test('refresh re-runs the active tab query and stays disabled while it is in flight', async () => {
  const h = harness(); await settle();
  assert.equal(h.calls.filter(url => url === '/api/credit-stats').length, 1);
  h.refresh.click(); await settle();
  assert.equal(h.calls.filter(url => url === '/api/credit-stats').length, 2, 'credit tab refresh must re-query credits');
  assert.equal(h.refresh.disabled, false);
  h.tabs[1].click(); await settle();
  const tokenReads = () => h.calls.filter(url => url === '/api/token-stats?days=7').length;
  assert.equal(tokenReads(), 1);
  assert.equal(h.refresh.disabled, true);
  h.refresh.click(); await settle();
  assert.equal(tokenReads(), 1, 'a second read must not start while the first is in flight');
  h.pending.shift()({ stats: {}, accounts: [] }); await settle();
  assert.equal(h.refresh.disabled, false);
  h.refresh.click(); await settle();
  // 刷新必须绕过 daemon 的历史树枚举缓存，否则刚结束的会话依旧缺失。
  assert.equal(tokenReads(), 1);
  assert.equal(h.calls.at(-1), '/api/token-stats?days=7&refresh=1');
  h.mask.__wbsClose();
});
