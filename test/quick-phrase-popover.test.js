'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
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
  const menu = context.mountExplorePopover(button, popup);
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
  const zIndex = selector => Number(source.match(new RegExp('\\.' + selector + '\\{[^}]*?z-index:(\\d+)'))[1]);
  assert.ok(zIndex('wbs-explore-pop') > zIndex('wbs-session-usage-popover'));
  assert.ok(zIndex('wbs-explore-pop') < zIndex('wbs-root'));
});
