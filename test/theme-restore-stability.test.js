'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');

test('default theme is restored after navigation just like a custom theme', async () => {
  const start = source.indexOf('async function restoreSavedTheme()');
  const end = source.indexOf('\n/**', start);
  const applied = [];
  const context = {
    PROFILE: { capabilities: { theme: true } }, cdp: { connected: true },
    DATA_DIR: '/test', path, fs: { existsSync: () => true, readFileSync: () => '{"id":"default"}' },
    applyThemeByCdp: async id => applied.push(id),
  };
  vm.runInNewContext(source.slice(start, end), context);
  await context.restoreSavedTheme();
  assert.deepEqual(applied, ['default']);
});

async function themeExpression(id) {
  const start = source.indexOf('async function applyThemeByCdp(id)');
  const end = source.indexOf('\n/**', start);
  let expression;
  const context = {
    PROFILE: { capabilities: { theme: true } }, cdp: { connected: true },
    currentAccount: () => null, getTheme: () => ({ dark: id !== 'default', colors: {} }),
    LOCAL_THEME_OVERRIDES: [], themeExtrasCss: () => '', themeVarsCss: () => '',
    cdpSend: async (_, params) => { expression = params.expression; return { result: { value: { applied: true } } }; },
  };
  vm.runInNewContext(source.slice(start, end), context);
  await context.applyThemeByCdp(id);
  return expression;
}

function renderer() {
  const observers = [];
  function element(tag) {
    const attrs = new Map(), classes = new Set();
    const el = {
      tagName: tag,
      getAttribute: k => attrs.get(k) || null,
      setAttribute(k, v) { attrs.set(k, v); }, removeAttribute: k => attrs.delete(k),
      classList: { contains: k => classes.has(k), add: k => classes.add(k), remove: k => classes.delete(k), toggle(k, v) { if (v) classes.add(k); else classes.delete(k); } },
      remove() { delete nodes[el.id]; },
    };
    return el;
  }
  const nodes = {};
  const document = { documentElement: element('HTML'), body: element('BODY'),
    getElementById: id => nodes[id] || null, createElement: element,
    head: { appendChild: el => { nodes[el.id] = el; } },
  };
  const storage = new Map();
  const context = { window: {}, document,
    localStorage: { get length() { return storage.size; }, key: i => [...storage.keys()][i], getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.active = false; observers.push(this); }
      observe() { this.active = true; } disconnect() { this.active = false; }
    },
  };
  return { context, document, observers, flush: () => observers.filter(o => o.active).forEach(o => o.callback([])) };
}

test('late account appearance cannot override the chosen light or dark theme', async () => {
  for (const id of ['default', 'nebula']) {
    const { context, document, flush } = renderer();
    vm.runInNewContext(await themeExpression(id), context);
    const mode = id === 'default' ? 'light' : 'dark';
    const opposite = mode === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', opposite);
    document.documentElement.classList.toggle('cb-dark', opposite === 'dark');
    document.body.setAttribute('data-vscode-theme-kind', opposite === 'dark' ? 'vscode-dark' : 'vscode-light');
    document.body.setAttribute('data-vscode-theme-name', opposite === 'dark' ? 'IDE Night' : 'IDE Light');
    flush();
    assert.equal(document.documentElement.getAttribute('data-theme'), mode);
    assert.equal(document.documentElement.classList.contains('cb-dark'), mode === 'dark');
    assert.equal(document.body.getAttribute('data-vscode-theme-kind'), mode === 'dark' ? 'vscode-dark' : 'vscode-light');
  }
});

test('manually changing theme replaces the prior guard and repeating a theme reuses its style', async () => {
  const { context, document, observers, flush } = renderer();
  const dark = await themeExpression('nebula');
  vm.runInNewContext(dark, context);
  const style = document.getElementById('wbs-theme-style');
  vm.runInNewContext(dark, context);
  assert.equal(document.getElementById('wbs-theme-style'), style);
  vm.runInNewContext(await themeExpression('default'), context);
  assert.equal(document.getElementById('wbs-theme-style'), null);
  assert.equal(observers.filter(o => o.active).length, 1);
  flush();
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
});
