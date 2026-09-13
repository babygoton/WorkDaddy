'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createBrandClickAction, createFabAppearance } = require('../scripts/inject.js');

function brandHarness() {
  const timers = new Map();
  let next = 0, opens = 0, debugs = 0;
  const action = createBrandClickAction({
    setTimeout(fn) { timers.set(++next, fn); return next; },
    clearTimeout(id) { timers.delete(id); },
    openWebsite() { opens++; }, unlockDebug() { debugs++; },
  });
  return { action, flush() { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); },
    get counts() { return { opens, debugs }; } };
}

test('single brand click opens once; five rapid clicks unlock debug without opening a browser', () => {
  const h = brandHarness();
  h.action.click();
  assert.deepEqual(h.counts, { opens: 0, debugs: 0 });
  h.flush();
  assert.deepEqual(h.counts, { opens: 1, debugs: 0 });
  for (let i = 0; i < 5; i++) h.action.click();
  assert.deepEqual(h.counts, { opens: 1, debugs: 1 });
  h.action.click(); // extra click within the same burst must not launch the site
  h.flush();
  assert.deepEqual(h.counts, { opens: 1, debugs: 1 });
  h.action.click(); h.action.destroy(); h.flush();
  assert.deepEqual(h.counts, { opens: 1, debugs: 1 }, 'reinjection cancels a pending website launch');
});

test('robot appearance restores per-profile preferences and rejects unknown styles', () => {
  const values = new Map(), attrs = new Map();
  const options = { key: 'robot-cn', storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    fab: { setAttribute: (key, value) => attrs.set(key, value) } };
  const style = createFabAppearance(options);
  assert.equal(style.get(), 'black');
  style.set('black');
  assert.equal(attrs.get('data-wbs-robot-style'), 'black');
  assert.equal(createFabAppearance(options).get(), 'black');
  assert.equal(createFabAppearance({ ...options, key: 'robot-ai' }).get(), 'black');
  style.set('glass');
  assert.equal(createFabAppearance(options).get(), 'glass');
  style.set('invalid');
  assert.equal(style.get(), 'glass');
});

test('panel owns the brand and groups robot controls; message shadow is the last theme card', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  assert.doesNotMatch(source, /function syncWindowLogo|class="wbs-ghbtn"/);
  assert.match(source, /class="wbs-brand" id="wbs-title"/);
  assert.match(source, /https:\/\/www\.workdaddy\.dev/);
  const start = source.indexOf('function buildThemePane()');
  const pane = source.slice(start, source.indexOf('wireThemePane();', start));
  assert.ok(pane.indexOf('id="wbs-text-shadow-card"') > pane.indexOf('id="wbs-bg-blur-range"'));
  const robot = pane.slice(pane.indexOf('wbs-fab-settings'), pane.indexOf('wbs-wallpaper-card'));
  assert.match(robot, /wbs-robot-style/);
  assert.match(robot, /wbs-fab-auto-dock/);
});

// Exercise the actual panel wiring: browser timers reject an options object as `this`.
test('panel five-click wiring preserves the browser timer receiver and reveals debug tools', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  const start = source.indexOf("    var piTitle = root.querySelector('#wbs-title');");
  const end = source.indexOf('    if (piPickBtn) {', start);
  const button = {}, picker = { style: { display: 'none' } }, card = { style: { display: 'none' } };
  const context = vm.createContext({
    createBrandClickAction, button, picker, card,
    root: { querySelector: selector => selector === '#wbs-title' ? button : picker },
    aboutPane: { querySelector: () => card },
    hiddenToolsUnlocked: false,
    listen: (node, type, handler) => { node[type] = handler; },
    registerDisposer() {}, toast() {},
  });
  vm.runInContext(`
    var timers = new Map(), timerId = 0;
    function setBuildTimeout(fn) { timers.set(++timerId, fn); return timerId; }
    function clearTimeout(id) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      timers.delete(id);
    }
  ` + source.slice(start, end) + `
    for (var i = 0; i < 5; i++) button.click({ preventDefault: function () {} });
  `, context);
  assert.equal(context.hiddenToolsUnlocked, true);
  assert.equal(picker.style.display, '');
  assert.equal(card.style.display, '');
});
