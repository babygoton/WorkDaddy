'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
const start = source.indexOf('  function injectCodeBuddyIdeMode()');
const overlay = source.slice(start, source.indexOf('\n  // User-facing strings', start));
const tick = () => new Promise(resolve => setImmediate(resolve));
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.handlers = {}; this.textContent = ''; }
  appendChild(node) { this.children.push(node); node.parent = this; return node; }
  setAttribute() {}
  addEventListener(type, fn) { this.handlers[type] = fn; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; }
  get isConnected() { return this.tagName === 'body' || !!(this.parent && this.parent.isConnected); }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html || this.textContent; }
  querySelectorAll(selector) { return this.children.flatMap(child => [(selector[0] === '.' ? (child.className || '').split(' ').includes(selector.slice(1)) : child.id === selector.slice(1)) ? child : null, ...child.querySelectorAll(selector)]).filter(Boolean); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  click() { this.handlers.click?.({ target: this, preventDefault() {}, stopPropagation() {} }); }
}
function harness(accounts) {
  const body = new Element('body'), head = new Element('head'), calls = [], pending = [];
  const document = { body, head, createElement: tag => new Element(tag), getElementById: id => body.querySelector('#' + id), addEventListener() {}, removeEventListener() {} };
  const window = {};
  const context = { document, window, CAPS: {}, PROFILE_ID: 'codebuddy-cn', WBS_BRAND: 'WorkDaddy', WBS_LANGUAGE: 'zh',
    wbsTranslateString: s => s, isIdentityExpired: account => !!account.expired, api: (path, opts) => {
      calls.push(path);
      if (path === '/api/accounts') return Promise.resolve({ accounts: accounts.map(a => ({ ...a })), current: { uid: 'a' } });
      return new Promise((resolve, reject) => pending.push({ uid: JSON.parse(opts.body).uid, resolve, reject }));
    } };
  vm.runInNewContext(overlay + '\ninjectCodeBuddyIdeMode();', context);
  const root = body.children[0];
  return { root, calls, pending, window,
    open: async () => { root.querySelector('.wbs-ide-fab').click(); await tick(); },
    credits: () => root.querySelectorAll('.wbs-ide-account-credits').map(el => el.textContent),
  };
}
test('unknown credits do not become zero; opening queries fresh balances including real zero and unlimited', async () => {
  const h = harness([{ uid: 'a', creditSegments: [] }, { uid: 'b', credits: 50, creditSegments: [] }]);
  await h.open(); assert.match(h.credits()[0], /未查询|查询中|刷新中/); assert.doesNotMatch(h.credits()[0], /积分 0/);
  assert.equal(h.pending.length, 2); assert.match(h.credits()[1], /上次查询/);
  h.pending[0].resolve({ credits: 0, segments: [], unlimited: false });
  h.pending[1].resolve({ credits: 0, segments: [], unlimited: true }); await tick();
  assert.match(h.credits()[0], /积分 0/); assert.doesNotMatch(h.credits()[0], /上次查询/);
  assert.match(h.credits()[1], /无限/);
});

test('IDE skips expired identities and does not show their cached balance', async () => {
  const h = harness([
    { uid: 'expired', credits: 90, creditSegments: [], expired: true },
    { uid: 'valid', credits: 50, creditSegments: [] },
  ]);
  await h.open();
  assert.equal(h.pending.length, 1);
  assert.match(h.credits()[0], /登录身份过期/);
  assert.doesNotMatch(h.credits()[0], /90/);
});
test('failed refresh retains labeled cache and manual refresh retries', async () => {
  const h = harness([{ uid: 'a', credits: 50, creditSegments: [] }]); await h.open();
  assert.equal(h.pending.length, 1); h.pending[0].reject(new Error('offline')); await tick();
  assert.match(h.credits()[0], /50/); assert.match(h.credits()[0], /上次查询/); assert.match(h.credits()[0], /刷新失败/);
  h.root.querySelector('.wbs-ide-credit-refresh').click(); await tick();
  assert.equal(h.pending.length, 2); h.pending[1].resolve({ credits: 12, segments: [], unlimited: false }); await tick();
  assert.match(h.credits()[0], /积分 12/); assert.doesNotMatch(h.credits()[0], /上次查询|失败/);
});
test('closing or reinjecting stops queued credit queries and ignores stale results', async () => {
  for (const action of ['close', 'remove']) {
    const h = harness(Array.from({ length: 6 }, (_, i) => ({ uid: String(i), creditSegments: [] }))); await h.open();
    assert.equal(h.pending.length, 2);
    const before = h.credits();
    if (action === 'close') h.root.querySelector('.wbs-ide-modal').click(); else h.root.remove();
    h.pending.forEach(p => p.resolve({ credits: 88, segments: [] })); await tick();
    assert.equal(h.pending.length, 2); assert.deepEqual(h.credits(), before);
  }
});
test('fresh expiry buckets exclude expired and unknown dates and include the day bucket in the week', async () => {
  const h = harness([{ uid: 'a', credits: null, creditSegments: [] }]); await h.open();
  const now = Date.now();
  h.pending[0].resolve({ credits: 90, segments: [
    { remaining: 10, expiresAt: now + 3600000 }, { remaining: 20, expiresAt: now + 172800000 },
    { remaining: 30, expiresAt: now - 1000 }, { remaining: 30, expiresAt: null },
  ] }); await tick();
  assert.equal(h.credits()[0], '积分 90 · 24小时过期：10 · 近7天过期：30');
});
test('reopening ignores the previous batch and enables refresh only after the current batch finishes', async () => {
  const h = harness([{ uid: 'a', credits: 50, creditSegments: [] }]); await h.open();
  h.root.querySelector('.wbs-ide-modal').click(); await h.open();
  const refresh = h.root.querySelector('.wbs-ide-credit-refresh');
  h.pending[0].resolve({ credits: 999, segments: [] }); await tick();
  assert.doesNotMatch(h.credits()[0], /999/); assert.equal(refresh.disabled, true);
  h.pending[1].resolve({ credits: 12, segments: [] }); await tick();
  assert.match(h.credits()[0], /积分 12/); assert.equal(refresh.disabled, false);
});

test('IDE shares the WorkDaddy panel without restricting tab navigation', () => {
  assert.match(source, /'<div class="wbs-fab"/);
  assert.match(source, /'<div class="wbs-panel"/);
  assert.doesNotMatch(source, /injectCodeBuddyIdeMode\(\);/);
  const tabSource = source.slice(source.indexOf('    function switchTab(name)'), source.indexOf('    var tabBtns'));
  const panes = ['account', 'sessions', 'models', 'about'];
  const tabs = panes.map(name => ({ getAttribute: () => name, classList: { toggle(_cls, active) { this.active = active; } } }));
  for (const name of panes) {
    const context = { WBS_CODEBUDDY_IDE_MODE: true,
      root: { querySelectorAll: () => tabs },
      themePane: null, sessionsPane: null, modelsPane: null, enhancePane: null,
      automationPane: null, pcPane: null, aboutPane: null, settingsPane: null,
      toast: () => assert.fail('IDE tab navigation must not be blocked'),
    };
    vm.runInNewContext(tabSource + '\nswitchTab(' + JSON.stringify(name) + ');', context);
    assert.equal(tabs.find(tab => tab.classList.active).getAttribute(), name);
  }
});

test('workbench 完整面板路径注入原生账号菜单去重样式（多个头像行回归）', () => {
  // 1.2.10 consolidate 曾把去重样式留在不再调用的 injectCodeBuddyIdeMode 里：
  // workbench 跑完整面板 → 样式从未注入 → genie 菜单按认证会话累积的旧账号行
  // 全部显示成当前账号（多个一模一样的头像行）。去重样式必须挂在完整面板注入路径。
  const panelPath = source.slice(source.indexOf('\n  // User-facing strings', source.indexOf('  function injectCodeBuddyIdeMode()')));
  assert.ok(panelPath.includes('wbs-ide-menu-dedupe-style'), '去重样式必须挂在完整面板注入路径');
  assert.ok(panelPath.includes('li.genie-account-menu-item ~ li.genie-account-menu-item'), '去重规则选择器必须在面板路径中');
  assert.ok(/workbench\\?\.html/.test(panelPath), '面板路径必须包含 workbench 页面判定');
});
