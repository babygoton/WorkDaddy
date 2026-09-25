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
    readSessionState: () => ({ themeTakeoverEnabled: true }),
    DATA_DIR: '/test', path, fs: { existsSync: () => true, readFileSync: () => '{"id":"default"}' },
    applyThemeByCdp: async id => applied.push(id),
  };
  vm.runInNewContext(source.slice(start, end), context);
  await context.restoreSavedTheme();
  assert.deepEqual(applied, ['default']);
});

async function themeExpression(id, takeover = true, accountUid = null) {
  const start = source.indexOf('async function applyThemeByCdp(id, options = {})');
  const end = source.indexOf('\n/**', start);
  let expression;
  const context = {
    PROFILE: { capabilities: { theme: true } }, cdp: { connected: true },
    readSessionState: () => ({ themeTakeoverEnabled: takeover }),
    themeApplyGeneration: 0,
    currentAccount: () => accountUid ? { uid: accountUid } : null, getTheme: () => ({ dark: id !== 'default', colors: {} }),
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
    localStorage: { get length() { return storage.size; }, key: i => [...storage.keys()][i], getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
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
    assert.equal(document.documentElement.classList.contains('cb-light'), mode !== 'dark');
    assert.equal(document.body.getAttribute('data-vscode-theme-kind'), mode === 'dark' ? 'vscode-dark' : 'vscode-light');
    assert.equal(document.body.classList.contains('vscode-light'), mode !== 'dark');
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

test('native dark removes custom styles and persists official dark appearance', async () => {
  const { context, document, observers } = renderer();
  vm.runInNewContext(await themeExpression('nebula'), context);
  vm.runInNewContext(await themeExpression('dark'), context);
  assert.equal(document.getElementById('wbs-theme-style'), null);
  assert.equal(document.documentElement.getAttribute('data-wbs-theme'), '0');
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(document.body.getAttribute('data-vscode-theme-name'), 'IDE Night');
  assert.equal(JSON.parse(context.localStorage.getItem('agent-ui-theme')).theme, 'dark');
  assert.equal(observers.filter(o => o.active).length, 1);
});

test('native theme choices cannot be shadowed by a custom theme file with the same id', () => {
  const ctx = {
    BUILTIN_THEMES: { default: { dark: false, colors: {} }, dark: { dark: true, colors: {} } },
    THEMES_DIR: '/themes', path,
    fs: { existsSync: () => true, readFileSync: () => '{"dark":false,"colors":{"--wb-bg-primary":"red"}}' },
  };
  const start = source.indexOf('function getTheme(id)');
  vm.runInNewContext(source.slice(start, source.indexOf('\n/**', start)), ctx);
  assert.equal(ctx.getTheme('dark'), ctx.BUILTIN_THEMES.dark);
  assert.equal(ctx.getTheme('default'), ctx.BUILTIN_THEMES.default);
});


test('theme takeover opt-out survives reload and never applies the saved theme', async () => {
  const start = source.indexOf('async function restoreSavedTheme()');
  const applied = [];
  const context = {
    PROFILE: { capabilities: { theme: true } }, cdp: { connected: true },
    DATA_DIR: '/test', path, fs: { existsSync: () => true, readFileSync: () => '{"id":"nebula"}' },
    readSessionState: () => ({ themeTakeoverEnabled: false }),
    restoreNativeAppearanceByCdp: async () => {},
    applyThemeByCdp: async id => applied.push(id),
  };
  vm.runInNewContext(source.slice(start, source.indexOf('\n/**', start)), context);
  await context.restoreSavedTheme();
  await context.restoreSavedTheme();
  assert.deepEqual(applied, []);
});

test('session settings default to takeover and retain opt-out when editing other switches', () => {
  let settings = { wbs: { session: { seeded: true, state: {}, phrases: [] } } };
  const context = {
    readWorkbuddySettings: () => structuredClone(settings),
    writeWorkbuddySettings: value => { settings = value; }, log() {},
  };
  const start = source.indexOf("const SESS_NS = 'session';");
  const end = source.indexOf('\n}', source.indexOf('function setSessionSwitch(', start)) + 2;
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(context.readSessionState().themeTakeoverEnabled, true);
  context.setSessionSwitch('themeTakeoverEnabled', false);
  context.setSessionSwitch('phraseEnabled', false);
  assert.equal(context.readSessionState().themeTakeoverEnabled, false);
});


test('manual theme changes still work with takeover off but install no theme guard', async () => {
  const { context, document, observers } = renderer();
  vm.runInNewContext(await themeExpression('dark', false), context);
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(observers.filter(o => o.active).length, 0);
});

test('turning off takeover releases the guard and custom CSS without rewriting native preferences', async () => {
  const { context, document, observers } = renderer();
  vm.runInNewContext(await themeExpression('nebula'), context);
  const before = [...['agent-ui-theme', 'workbuddy.appearance.lastApplied'].map(key => context.localStorage.getItem(key))];
  const start = source.indexOf('async function releaseThemeByCdp()');
  const daemon = { cdp: { connected: true }, themeApplyGeneration: 0, startNativeAppearanceSyncByCdp: async () => {}, cdpSend: async (_, params) => { vm.runInNewContext(params.expression, context); return {}; } };
  vm.runInNewContext(source.slice(start, source.indexOf('\n/**', start)), daemon);
  await daemon.releaseThemeByCdp();
  assert.equal(document.getElementById('wbs-theme-style'), null);
  assert.equal(observers.filter(o => o.active).length, 0);
  assert.equal(context.window.__wbsThemeGuard, undefined);
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
  assert.deepEqual(['agent-ui-theme', 'workbuddy.appearance.lastApplied'].map(key => context.localStorage.getItem(key)), before);
});

test('releasing takeover preserves the exact WorkBuddy special appearance snapshot', async () => {
  const { context, document } = renderer();
  const uid = 'account-special';
  const accountKey = 'workbuddy.appearance.lastApplied::personal::' + uid;
  const modeKey = 'workbuddy.appearance.mode::personal::personal::' + uid;
  const special = JSON.stringify({ kind: 'theme', resourceKey: 'theme-ripple', appearance: 'light' });
  const globalTheme = JSON.stringify({ theme: 'light', followSystem: false, vsCodeThemeName: 'IDE Light', vsCodeThemeKind: 'vscode-light' });
  context.localStorage.setItem('workdaddy.theme.native-snapshot::' + uid, JSON.stringify({ keys: [
    [accountKey, special], [modeKey, 'light'],
    ['workbuddy.appearance.state::personal::' + uid, JSON.stringify({ currentTheme: 'theme-ripple' })],
    ['agent-ui-theme', globalTheme],
    ['workbuddy.appearance.lastApplied', special],
    ['workbuddy.appearance.lastApplied.css', JSON.stringify({ resourceKey: 'theme-ripple', css: ':root{}' })],
  ] }));
  context.currentAccount = () => ({ uid });
  context.cdp = { connected: true };
  context.themeApplyGeneration = 0;
  context.startNativeAppearanceSyncByCdp = async () => {};
  context.cdpSend = async (_, params) => { vm.runInNewContext(params.expression, context); return {}; };
  const start = source.indexOf('async function releaseThemeByCdp()');
  vm.runInNewContext(source.slice(start, source.indexOf('\n/**', start)), context);
  await context.releaseThemeByCdp();
  assert.equal(context.localStorage.getItem(accountKey), special);
  assert.equal(context.localStorage.getItem(modeKey), 'light');
  assert.equal(context.localStorage.getItem('workbuddy.appearance.lastApplied'), special);
  assert.equal(context.localStorage.getItem('workbuddy.appearance.lastApplied.css'), JSON.stringify({ resourceKey: 'theme-ripple', css: ':root{}' }));
  assert.equal(context.localStorage.getItem('workdaddy.theme.native-snapshot::' + uid), null);
  assert.equal(document.documentElement.getAttribute('data-wbs-theme'), null);
});

test('native opt-out syncs WorkBuddy special CSS from the settings window', () => {
  const start = source.indexOf('function nativeAppearanceSyncExpression()');
  const end = source.indexOf('\nasync function releaseThemeByCdp()', start);
  const expression = source.slice(start, end);
  assert.match(expression, /lastApplied\.css/);
  assert.match(expression, /new CSSStyleSheet\(\)/);
  assert.match(expression, /setInterval\(sync, 500\)/);
  assert.match(source.slice(source.indexOf('const expr = \`\(function\(\)\{', source.indexOf('async function applyThemeByCdp')), source.indexOf('function wbsBuiltinAppearance')), /__wbsNativeAppearanceSync/);
});


test('manual native theme selection does not overwrite other accounts or the legacy fallback', async () => {
  const { context } = renderer();
  const storage = context.localStorage;
  storage.setItem('workbuddy.appearance.mode::personal::personal::other', 'light');
  storage.setItem('workbuddy.appearance.state::personal::other', '{"currentTheme":"light"}');
  storage.setItem('workbuddy.appearance.mode::legacy-snapshot', 'auto');
  vm.runInNewContext(await themeExpression('dark', false, 'current'), context);
  assert.equal(storage.getItem('workbuddy.appearance.mode::personal::personal::other'), 'light');
  assert.equal(JSON.parse(storage.getItem('workbuddy.appearance.state::personal::other')).currentTheme, 'light');
  assert.equal(storage.getItem('workbuddy.appearance.mode::legacy-snapshot'), 'auto');
  assert.equal(JSON.parse(storage.getItem('workbuddy.appearance.state::personal::current')).currentTheme, 'dark');
});

test('takeover prepares a WorkBuddy special theme as an official theme first', async () => {
  const expression = await themeExpression('default', true, 'current');
  assert.match(expression, /lastApplied::/);
  assert.match(expression, /lastApplied\.css/);
  assert.match(expression, /adoptedStyleSheets/);
  assert.match(expression, /resourceKey:.*mode/);
});

test('takeover removes a special adopted skin when CSSOM serialization differs', async () => {
  const { context, document } = renderer();
  document.adoptedStyleSheets = [
    { cssRules: [{ cssText: ':root{--cb-bg-primary:#123456;--wb-bg-primary:#234567}' }] },
    { cssRules: [{ cssText: '.official{color:red}' }] },
  ];
  context.localStorage.setItem('workbuddy.appearance.lastApplied.css', JSON.stringify({
    resourceKey: 'theme-tkbdzr',
    css: ':root { --cb-bg-primary: #123456; }',
  }));
  vm.runInNewContext(await themeExpression('default', true, 'current'), context);
  assert.equal(document.adoptedStyleSheets.length, 1);
  assert.equal(document.adoptedStyleSheets[0].cssRules[0].cssText, '.official{color:red}');
});

test('theme switch invalidates an in-flight automatic restore before CDP evaluation', () => {
  const applyStart = source.indexOf('async function applyThemeByCdp(id, options = {})');
  const releaseStart = source.indexOf('async function releaseThemeByCdp()');
  const routeStart = source.indexOf("if (req.method === 'POST' && p === '/api/session-module-set')");
  assert.ok(applyStart >= 0 && releaseStart >= 0 && routeStart >= 0);
  const apply = source.slice(applyStart, source.indexOf('\n/**', applyStart));
  const release = source.slice(releaseStart, source.indexOf('\n/**', releaseStart));
  const route = source.slice(routeStart, routeStart + 900);
  assert.match(apply, /const applyGeneration = themeApplyGeneration/);
  assert.match(apply, /applyGeneration !== themeApplyGeneration/);
  assert.match(release, /themeApplyGeneration\+\+/);
  assert.match(route, /themeApplyGeneration\+\+/);
});
