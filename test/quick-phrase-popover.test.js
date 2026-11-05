'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
test('quick phrase popover keeps direct-send cells and exposes a non-sending insert action', () => {
  const renderStart = source.indexOf('    function renderExploreOptions() {');
  const renderEnd = source.indexOf('    /** 新增/编辑快捷短语弹窗', renderStart);
  const render = source.slice(renderStart, renderEnd);
  assert.match(render, /data-qp-insert/);
  assert.match(render, /api\('\/api\/quick-phrase-insert'/);
  assert.match(render, /var editor = findComposer\(\);[\s\S]*editor\.focus\(\)/);
  assert.match(render, /stopPropagation\(\)/);
  assert.match(render, /data-qp-send/);
  assert.match(render, /api\('\/api\/quick-phrase-send'/);
  assert.match(render, /sendKeyTarget\.addEventListener\('keydown'/);
});

test('quick phrase manager persists drag order through the dedicated reorder API', () => {
  const renderStart = source.indexOf('    function renderQpList() {');
  const renderEnd = source.indexOf('    /** 发送按钮面板选项', renderStart);
  const render = source.slice(renderStart, renderEnd);
  assert.match(render, /class="wbs-qp-row" data-id="[\s\S]*?draggable="false"/);
  assert.match(render, /class="wbs-qp-drag" draggable="true" data-qp-drag=/);
  assert.match(render, /qpSortCleanup = createQuickPhraseSorter\(listEl/);
  assert.doesNotMatch(render, /if \(!ev\.target\.closest\('\[data-qp-drag\]'\)\) \{ ev\.preventDefault\(\); return; \}/);
  assert.match(render, /api\('\/api\/quick-phrase-reorder'/);
  assert.match(render, /sessState\.qpBatch/);
});

test('quick phrase insert action renders a speech bubble icon', () => {
  const start = source.indexOf("html += '<div class=\"wbs-explore-item\"");
  const end = source.indexOf("'<span class=\"wbs-explore-tip\"", start);
  const markup = source.slice(start, end);
  assert.match(markup, /data-qp-insert/);
  assert.match(markup, /<path d="M3 3\.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3 2v-2H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"/);
});

test('quick phrase popup escapes composer stacking, bridges hover, and cleans up on reinjection', () => {
  const timers = new Map(); let nextTimer = 0;
  function element(rect = { width: 280, height: 100 }) {
    const classes = new Set(), listeners = new Map();
    return { style: {}, attrs: {}, isConnected: true, listeners,
      classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key) },
      setAttribute(key, value) { this.attrs[key] = value; }, getBoundingClientRect: () => rect,
      addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); },
      appendChild(child) { child.parentElement = this; }, contains(child) { return child === this; },
      remove() { this.isConnected = false; }, focus() {},
    };
  }
  const window = Object.assign(element(), { innerWidth: 360, innerHeight: 800 });
  const document = Object.assign(element(), { body: element() });
  const button = element({ left: 320, top: 660, width: 32, height: 32 });
  const popup = element(); popup.parentElement = button;
  const context = { CAPS: {}, document, window, mountPersistentOverlay: node=>document.body.appendChild(node), setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) };
  const start = source.indexOf('    function mountExplorePopover(');
  vm.runInNewContext(source.slice(start, source.indexOf('    function acMenuClose()', start)), context);
  let closeCalls = 0;
  const menu = context.mountExplorePopover(button, popup, () => { closeCalls++; });
  assert.equal(popup.parentElement, document.body);
  button.listeners.get('mouseenter')();
  assert.equal(popup.classList.contains('is-open'), true);
  assert.equal(button.attrs['aria-expanded'], 'true');
  assert.equal(popup.style.left, '72px', 'clamped inside a narrow viewport');
  button.listeners.get('mouseleave')();
  popup.listeners.get('mouseenter')();
  assert.equal(timers.size, 0, 'hover bridge cancels pending close');
  document.listeners.get('scroll')({target: popup});
  assert.equal(popup.classList.contains('is-open'), true);
  document.listeners.get('scroll')({target: document.body});
  assert.equal(popup.classList.contains('is-open'), false);
  menu.open(); window.listeners.get('resize')();
  assert.equal(button.attrs['aria-expanded'], 'false');
  button.listeners.get('mouseleave')(); menu.destroy();
  assert.equal(timers.size, 0);
  for (const target of [button, popup, window, document]) assert.equal(target.listeners.size, 0);
  assert.equal(popup.isConnected, false);
  assert.ok(closeCalls > 0, 'closing the menu must also hide the action tooltip');
  const zIndex = selector => Number(source.match(new RegExp('\\.' + selector + '\\{[^}]*?z-index:(\\d+)'))[1]);
  assert.ok(zIndex('wbs-explore-pop') > zIndex('wbs-session-usage-popover'));
  assert.ok(zIndex('wbs-explore-pop') < zIndex('wbs-root'));
});

test('insert button uses the WorkDaddy custom tooltip instead of native title', () => {
  const button = source.match(/<button type="button" class="wbs-explore-insert"[^>]+>/)[0];
  assert.doesNotMatch(button, /\btitle=/);
  assert.match(button, /aria-describedby="wbs-qp-insert-tooltip"/);
  assert.match(button, /aria-label="仅插入到对话框"/);
  assert.match(source, /wbs-telemetry-tooltip wbs-qp-insert-tooltip/);
  assert.match(source, /wbs-qp-insert-tooltip', '仅插入到对话框'/);
  assert.match(source, /html\.cb-dark \.wbs-qp-insert-tooltip/);
  assert.match(source, /html\[data-theme="dark"\] \.wbs-qp-insert-tooltip/);
});

test('custom insert tooltip follows hover/focus, stays inside viewport, and cleans up', () => {
  function element(parent = null) {
    const classes = new Set(), listeners = new Map();
    return { parent, style: {}, attrs: {}, listeners, offsetWidth: 150, offsetHeight: 30,
      classList: { add: key => classes.add(key), remove: key => classes.delete(key), contains: key => classes.has(key) },
      setAttribute(key, value) { this.attrs[key] = value; },
      addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); },
      contains(node) { for (; node; node = node.parent) if (node === this) return true; return false; },
      closest(selector) { return selector === '[data-qp-insert]' && this.insert ? this : this.parent?.closest(selector); },
      getBoundingClientRect: () => ({ left: 330, top: 360, bottom: 384, width: 24 }),
      remove() { this.removed = true; },
    };
  }
  const popup = element(), button = Object.assign(element(popup), { insert: true }), svg = element(button);
  const document = element(), window = Object.assign(element(), { innerWidth: 360, innerHeight: 400 });
  let tooltip;
  const context = { document, window, el() { return tooltip = element(); }, mountPersistentOverlay() {}, applyI18n() {} };
  const start = source.indexOf('    function mountQuickPhraseInsertTooltip(');
  vm.runInNewContext(source.slice(start, source.indexOf('    function acMenuClose()', start)), context);
  const controller = context.mountQuickPhraseInsertTooltip(popup);
  popup.listeners.get('focusin')({ target: button });
  assert.equal(tooltip.classList.contains('is-visible'), false, 'closed menu must not leave a tooltip visible');
  popup.classList.add('is-open');
  popup.listeners.get('pointerover')({ target: svg });
  assert.equal(tooltip.classList.contains('is-visible'), true);
  assert.equal(tooltip.style.left, '202px'); assert.equal(tooltip.style.top, '323px');
  assert.equal(popup.classList.contains('wbs-explore-action-tip'), true, 'suppress the phrase tooltip while showing the action');
  popup.listeners.get('pointerout')({ target: svg, relatedTarget: button });
  assert.equal(tooltip.classList.contains('is-visible'), true, 'moving between icon and button must not flicker');
  popup.listeners.get('pointerout')({ target: button, relatedTarget: popup });
  assert.equal(tooltip.classList.contains('is-visible'), false);
  popup.listeners.get('focusin')({ target: button });
  assert.equal(tooltip.classList.contains('is-visible'), true);
  document.listeners.get('scroll')();
  assert.equal(tooltip.classList.contains('is-visible'), false);
  controller.destroy();
  assert.equal(tooltip.removed, true);
  for (const node of [popup, document, window]) assert.equal(node.listeners.size, 0);
});
