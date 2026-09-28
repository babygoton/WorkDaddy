'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');

test('theme takeover always restores the frosted theme after navigation', async () => {
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
  assert.deepEqual(applied, ['nebula']);
});

async function themeExpression(id, takeover = true, accountUid = null, options = {}) {
  const start = source.indexOf('async function applyThemeByCdp(id, options = {})');
  const end = source.indexOf('\n/**', start);
  let expression;
  const context = {
    PROFILE: { capabilities: { theme: true } }, cdp: { connected: true },
    readSessionState: () => ({ themeTakeoverEnabled: takeover }),
    themeApplyGeneration: 0,
    setTimeout: resolve => resolve(),
    currentAccount: () => accountUid ? { uid: accountUid } : null, getTheme: () => ({ dark: id !== 'default', colors: {} }),
    LOCAL_THEME_OVERRIDES: [], themeExtrasCss: () => '', themeVarsCss: () => '',
    cdpSend: async (_, params) => { expression = params.expression; return { result: { value: { applied: true, ready: true } } }; },
  };
  vm.runInNewContext(source.slice(start, end), context);
  await context.applyThemeByCdp(id, options);
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

for (const snapshot of ['light', 'dark', null]) test('native sync follows both official theme buttons with snapshot ' + snapshot, () => {
  const { context, document } = renderer();
  const intervals = new Map();
  let timer = 0;
  context.setInterval = fn => { intervals.set(++timer, fn); return timer; };
  context.clearInterval = id => intervals.delete(id);
  if (snapshot) context.localStorage.setItem('workbuddy.appearance.lastApplied', JSON.stringify({ kind: 'theme', resourceKey: snapshot, appearance: snapshot }));
  const savedSnapshot = context.localStorage.getItem('workbuddy.appearance.lastApplied');
  const start = source.indexOf('function nativeAppearanceSyncExpression()');
  const end = source.indexOf('\nasync function startNativeAppearanceSyncByCdp()', start);
  const expression = vm.runInNewContext(source.slice(start, end) + '\nnativeAppearanceSyncExpression();', {});
  vm.runInNewContext(expression, context);
  for (const mode of ['dark', 'light', 'dark', 'light']) {
    // Official AI menu calls ThemeManager.setTheme: DOM + agent-ui-theme change,
    // while the appearance-panel snapshot may be stale or absent.
    const native = JSON.stringify({ theme: mode, followSystem: false,
      vsCodeThemeName: mode === 'dark' ? 'IDE Night' : 'IDE Light', vsCodeThemeKind: 'vscode-' + mode });
    context.localStorage.setItem('agent-ui-theme', native);
    document.documentElement.setAttribute('data-theme', mode);
    document.body.setAttribute('data-vscode-theme-kind', 'vscode-' + mode);
    for (let tick = 0; tick < 3; tick++) [...intervals.values()].forEach(fn => fn());
    assert.equal(document.documentElement.getAttribute('data-theme'), mode);
    assert.equal(document.documentElement.classList.contains('cb-dark'), mode === 'dark');
    assert.equal(document.body.getAttribute('data-vscode-theme-kind'), 'vscode-' + mode);
    assert.equal(context.localStorage.getItem('agent-ui-theme'), native);
    assert.equal(context.localStorage.getItem('workbuddy.appearance.lastApplied'), savedSnapshot);
    // A daemon reconnect must replace the timer and retain the last selection.
    vm.runInNewContext(expression, context);
    assert.equal(intervals.size, 1);
    assert.equal(document.documentElement.getAttribute('data-theme'), mode);
  }
});

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


test('theme takeover opt-out follows native appearance on reload without forcing light', async () => {
  const start = source.indexOf('async function restoreSavedTheme()');
  const applied = [];
  const context = {
    PROFILE: { capabilities: { theme: true } }, cdp: { connected: true },
    DATA_DIR: '/test', path, fs: { existsSync: () => true, readFileSync: () => '{"id":"nebula"}' },
    readSessionState: () => ({ themeTakeoverEnabled: false }),
    startNativeAppearanceSyncByCdp: async () => applied.push('native'),
    applyThemeByCdp: async id => applied.push(id),
  };
  vm.runInNewContext(source.slice(start, source.indexOf('\n/**', start)), context);
  await context.restoreSavedTheme();
  await context.restoreSavedTheme();
  assert.deepEqual(applied, ['native', 'native']);
  assert.match(source, /accountSnapshot/);
  assert.match(source, /workdaddy\.theme\.native-snapshot::' \+ WBS_UID/);
});

test('session settings default to takeover and retain opt-out when editing other switches', () => {
  let settings = { wbs: { session: { seeded: true, state: {}, phrases: [] } } };
  const context = {
    PROFILE: {capabilities:{}}, readWorkbuddySettings: () => structuredClone(settings),
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

test('turning off takeover restores the WorkBuddy appearance saved before takeover', async () => {
  const { context, document, observers } = renderer();
  const uid = 'current';
  context.localStorage.setItem('agent-ui-theme', JSON.stringify({ theme: 'dark', followSystem: false, vsCodeThemeName: 'IDE Night', vsCodeThemeKind: 'vscode-dark' }));
  context.localStorage.setItem('workbuddy.appearance.lastApplied', JSON.stringify({ resourceKey: 'dark', appearance: 'dark' }));
  context.localStorage.setItem('workbuddy.appearance.mode::personal::personal::' + uid, 'dark');
  context.localStorage.setItem('workbuddy.appearance.state::personal::' + uid, JSON.stringify({ currentTheme: 'dark' }));
  context.localStorage.setItem('workbuddy.appearance.lastApplied::personal::' + uid, JSON.stringify({ resourceKey: 'dark', appearance: 'dark' }));
  vm.runInNewContext(await themeExpression('nebula', true, uid), context);
  // Seed the persisted pre-takeover snapshot explicitly; the helper above
  // captures the final CDP expression, while this test focuses on release.
  context.localStorage.setItem('workdaddy.theme.native-snapshot::' + uid, JSON.stringify({ keys: [
    ['agent-ui-theme', JSON.stringify({ theme: 'dark', followSystem: false, vsCodeThemeName: 'IDE Night', vsCodeThemeKind: 'vscode-dark' })],
    ['workbuddy.appearance.lastApplied', JSON.stringify({ resourceKey: 'dark', appearance: 'dark' })],
    ['workbuddy.appearance.mode::personal::personal::' + uid, 'dark'],
    ['workbuddy.appearance.state::personal::' + uid, JSON.stringify({ currentTheme: 'dark' })],
    ['workbuddy.appearance.lastApplied::personal::' + uid, JSON.stringify({ resourceKey: 'dark', appearance: 'dark' })],
  ] }));
  const oldGuard = context.window.__wbsThemeGuard;
  document.adoptedStyleSheets = [
    { cssRules: [{ cssText: ':root { --wb-bg-primary: pink; }' }] },
    { cssRules: [{ cssText: '.official { color: red; }' }] },
  ];
  context.localStorage.setItem('workbuddy.appearance.lastApplied.css', JSON.stringify({ resourceKey: 'special', css: ':root { --wb-bg-primary: pink; }' }));
  context.localStorage.setItem('workbuddy.appearance.mode::personal::personal::other', 'dark');
  const daemon = {
    cdp: { connected: true }, themeApplyGeneration: 0,
    readSessionState: () => ({ themeTakeoverEnabled: false }),
    currentAccount: () => ({ uid }),
    cdpSend: async (_, params) => { vm.runInNewContext(params.expression, context); return {}; },
    startNativeAppearanceSyncByCdp: async () => {
      const applied = JSON.parse(context.localStorage.getItem('workbuddy.appearance.lastApplied') || '{}');
      const dark = applied.appearance === 'dark' || applied.resourceKey === 'dark';
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      document.body.setAttribute('data-vscode-theme-name', dark ? 'IDE Night' : 'IDE Light');
    },
    applyThemeByCdp: async (id, options) => {
      assert.equal(id, 'default');
      assert.equal(options.release, true);
      vm.runInNewContext(await themeExpression(id, false, uid, options), context);
    },
  };
  const start = source.indexOf('async function releaseThemeByCdp()');
  vm.runInNewContext(source.slice(start, source.indexOf('async function restoreNativeAppearanceByCdp()', start)), daemon);
  const restoreNativeStart = source.indexOf('async function restoreNativeAppearanceByCdp()');
  vm.runInNewContext(source.slice(restoreNativeStart, source.indexOf('/** 恢复已保存的主题', restoreNativeStart)), daemon);
  await daemon.releaseThemeByCdp();
  assert.equal(document.getElementById('wbs-theme-style'), null);
  assert.equal(oldGuard.active, false);
  assert.equal(observers.filter(o => o.active).length, 0);
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(document.body.getAttribute('data-vscode-theme-name'), 'IDE Night');
  assert.equal(JSON.parse(context.localStorage.getItem('agent-ui-theme')).theme, 'dark');
  assert.equal(JSON.parse(context.localStorage.getItem('workbuddy.appearance.lastApplied')).resourceKey, 'dark');
  assert.equal(context.localStorage.getItem('workbuddy.appearance.lastApplied.css'), null);
  assert.equal(context.localStorage.getItem('workdaddy.theme.native-snapshot::' + uid), null);
  assert.equal(context.localStorage.getItem('workbuddy.appearance.mode::personal::personal::other'), 'dark');
  assert.equal(document.adoptedStyleSheets.length, 1);
});

test('turning off takeover reapplies the saved official special theme', async () => {
  const { context } = renderer();
  const uid = 'current';
  const savedTheme = {
    kind: 'theme', resourceKey: 'theme-wind', appearance: 'light',
    nameZh: '有风', nameEn: 'Wind', vipLevel: 'free', updatedAt: 0,
  };
  const calls = [];
  context.wb = { config: { setPreference: async (key, value) => { calls.push([key, value]); } } };
  context.localStorage.setItem('workdaddy.theme.native-snapshot::' + uid, JSON.stringify({ keys: [
    ['agent-ui-theme', JSON.stringify({ theme: 'light', followSystem: false, vsCodeThemeName: 'IDE Light', vsCodeThemeKind: 'vscode-light' })],
    ['workbuddy.appearance.lastApplied', JSON.stringify(savedTheme)],
    ['workbuddy.appearance.lastApplied.css', JSON.stringify({ resourceKey: 'theme-wind', css: ':root { --wb-button-primary-bg: #8a6f4d; }' })],
    ['workbuddy.appearance.state::personal::' + uid, JSON.stringify({ currentTheme: 'theme-wind' })],
    ['workbuddy.appearance.lastApplied::personal::' + uid, JSON.stringify(savedTheme)],
  ] }));
  const daemon = {
    cdp: { connected: true },
    currentAccount: () => ({ uid }),
    cdpSend: async (_, params) => {
      const value = await vm.runInNewContext(params.expression, context);
      return { result: { value } };
    },
    startNativeAppearanceSyncByCdp: async () => {},
  };
  const start = source.indexOf('async function restoreNativeAppearanceByCdp()');
  vm.runInNewContext(source.slice(start, source.indexOf('/** 恢复已保存的主题', start)), daemon);
  await daemon.restoreNativeAppearanceByCdp();
  assert.deepEqual(calls, [['appearanceTheme', 'theme-wind']]);
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


test('a pending light reset cannot overwrite takeover re-enabled during a CDP retry', async () => {
  let takeover = false;
  let evaluations = 0;
  const context = {
    PROFILE: { capabilities: { theme: true } }, cdp: { connected: true, ws: { readyState: 1 } },
    readSessionState: () => ({ themeTakeoverEnabled: takeover }), themeApplyGeneration: 0,
    currentAccount: () => null, getTheme: () => ({ dark: false, colors: {} }),
    LOCAL_THEME_OVERRIDES: [], themeExtrasCss: () => '', themeVarsCss: () => '',
    cdpSend: async () => { evaluations++; takeover = true; context.themeApplyGeneration++; return { result: { value: { pending: true } } }; },
    cdpActivatePage: async () => {},
    setTimeout: resolve => resolve(),
  };
  const start = source.indexOf('async function applyThemeByCdp(id, options = {})');
  vm.runInNewContext(source.slice(start, source.indexOf('\n/**', start)), context);
  const result = await context.applyThemeByCdp('default', { release: true });
  assert.equal(evaluations, 1);
  assert.equal(result.applied, false);
});


test('release resets light once then follows official dark and special skins across reconnects', async () => {
  const { context, document } = renderer();
  const intervals = new Map();
  let nextTimer = 0, lightResets = 0;
  context.setInterval = fn => { intervals.set(++nextTimer, fn); return nextTimer; };
  context.clearInterval = id => intervals.delete(id);
  context.clearTimeout = () => {};
  context.CSSStyleSheet = class {
    replaceSync(css) { this.cssRules = [{ cssText: css }]; }
  };
  document.adoptedStyleSheets = [];
  const tick = () => [...intervals.values()].forEach(fn => fn());
  const daemon = {
    PROFILE: { capabilities: { theme: true } }, cdp: { connected: true }, themeApplyGeneration: 0,
    readSessionState: () => ({ themeTakeoverEnabled: false }),
    cdpSend: async (_, params) => { vm.runInNewContext(params.expression, context); return {}; },
    applyThemeByCdp: async (id, options) => {
      lightResets++;
      vm.runInNewContext(await themeExpression(id, false, 'current', options), context);
    },
  };
  const start = source.indexOf('function nativeAppearanceSyncExpression()');
  vm.runInNewContext(source.slice(start, source.indexOf('async function restoreNativeAppearanceByCdp()', start)), daemon);
  const restoreNativeStart = source.indexOf('async function restoreNativeAppearanceByCdp()');
  vm.runInNewContext(source.slice(restoreNativeStart, source.indexOf('/** 恢复已保存的主题', restoreNativeStart)), daemon);
  const restoreStart = source.indexOf('async function restoreSavedTheme()');
  vm.runInNewContext(source.slice(restoreStart, source.indexOf('\n/**', restoreStart)), daemon);
  await daemon.releaseThemeByCdp();
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(intervals.size, 1, 'release must resume official settings-window synchronization');
  context.localStorage.setItem('workbuddy.appearance.lastApplied', JSON.stringify({ resourceKey: 'dark', appearance: 'dark' }));
  context.localStorage.setItem('agent-ui-theme', JSON.stringify({ theme: 'dark', followSystem: false, vsCodeThemeName: 'IDE Night', vsCodeThemeKind: 'vscode-dark' }));
  tick();
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
  const css = ':root { --wb-button-primary-bg: purple; }';
  context.localStorage.setItem('workbuddy.appearance.lastApplied', JSON.stringify({ resourceKey: 'ripple', appearance: 'light' }));
  context.localStorage.setItem('workbuddy.appearance.lastApplied.css', JSON.stringify({ resourceKey: 'ripple', css }));
  tick();
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(document.adoptedStyleSheets.length, 1);
  assert.equal(document.adoptedStyleSheets[0].cssRules[0].cssText, css);
  await daemon.restoreSavedTheme();
  await daemon.restoreSavedTheme();
  tick();
  assert.equal(lightResets, 1, 'reconnects must preserve the user-selected native theme');
  assert.equal(intervals.size, 1, 'reconnects must replace the prior sync interval');
  assert.equal(document.adoptedStyleSheets.length, 1);
  assert.equal(context.localStorage.getItem('workbuddy.appearance.lastApplied.css'), JSON.stringify({ resourceKey: 'ripple', css }));
  context.localStorage.removeItem('workbuddy.appearance.lastApplied.css');
  context.localStorage.setItem('workbuddy.appearance.lastApplied', JSON.stringify({ resourceKey: 'dark', appearance: 'dark' }));
  tick();
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(document.adoptedStyleSheets.length, 0);
});


test('nebula prepares official dark before injecting glass styles without an intermediate light write', async () => {
  const { context, document } = renderer();
  const steps = [];
  const setItem = context.localStorage.setItem;
  context.localStorage.setItem = (key, value) => {
    if (key === 'agent-ui-theme') steps.push(JSON.parse(value).theme);
    setItem(key, value);
  };
  const appendChild = document.head.appendChild;
  document.head.appendChild = node => {
    if (node.id === 'wbs-theme-style') {
      assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
      assert.equal(document.body.getAttribute('data-vscode-theme-name'), 'IDE Night');
      assert.equal(JSON.parse(context.localStorage.getItem('agent-ui-theme')).theme, 'dark');
      steps.push('glass');
    }
    appendChild(node);
  };
  vm.runInNewContext(await themeExpression('nebula', true, 'current'), context);
  assert.equal(steps[0], 'dark');
  assert.ok(steps.includes('glass'));
  assert.ok(!steps.includes('light'));
});

test('only nebula overrides primary button background to transparent', () => {
  const context = { loadThemeVars: () => require('../scripts/theme-vars.js') };
  const start = source.indexOf('function themeVarsCss(isDark, id)');
  vm.runInNewContext(source.slice(start, source.indexOf('function readBackgroundBlur()', start)), context);
  const css = context.themeVarsCss(true, 'nebula');
  assert.match(css, /html\[data-wbs-theme-id\]/);
  assert.match(css, /body\[data-vscode-theme-name\]\{[^}]*--wb-button-primary-bg:transparent(?: !important)?;/);
  assert.match(css, /--wb-bg-secondary:transparent !important/);
  assert.match(css, /\.dark/);
  for (const [dark, id] of [[false, 'default'], [true, 'dark'], [false, 'eye-care'], [true, 'cyber-purple']]) {
    assert.doesNotMatch(context.themeVarsCss(dark, id), /--wb-button-primary-bg:transparent/);
  }
});


test('nebula releases custom CSS and guards, waits for official dark, then reapplies glass', async () => {
  const { context, document, observers } = renderer();
  vm.runInNewContext(await themeExpression('nebula', true, 'current'), context);
  const stages = [];
  const daemon = {
    PROFILE: { capabilities: { theme: true } }, cdp: { connected: true }, themeApplyGeneration: 0,
    setTimeout: resolve => resolve(),
    readSessionState: () => ({ themeTakeoverEnabled: true }), currentAccount: () => ({ uid: 'current' }),
    getTheme: id => ({ dark: id !== 'default', colors: {} }),
    LOCAL_THEME_OVERRIDES: [], themeExtrasCss: () => '', themeVarsCss: () => '',
    cdpSend: async (_, params) => {
      if (params.expression.includes('ready:')) {
        stages.push('settle');
        assert.equal(document.getElementById('wbs-theme-style'), null);
        assert.equal(observers.filter(o => o.active).length, 0);
        assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
        assert.equal(JSON.parse(context.localStorage.getItem('agent-ui-theme')).theme, 'dark');
        return { result: { value: { ready: true } } };
      }
      const value = vm.runInNewContext(params.expression, context);
      stages.push(document.getElementById('wbs-theme-style') ? 'glass' : 'native');
      return { result: { value } };
    },
  };
  const start = source.indexOf('async function applyThemeByCdp(id, options = {})');
  vm.runInNewContext(source.slice(start, source.indexOf('\n/**', start)), daemon);
  await daemon.applyThemeByCdp('nebula');
  assert.deepEqual(stages, ['native', 'settle', 'glass']);
  assert.equal(observers.filter(o => o.active).length, 1);
});

test('native dark clears a stale skin marker before notifying the official theme observer', async () => {
  for (const uid of ['current', null]) {
    const { context, document } = renderer();
    const h = document.documentElement, b = document.body;
    h.setAttribute('data-skin', 'theme-tkbera');
    let officialMode = 'light';
    const set = b.setAttribute;
    b.setAttribute = (name, value) => {
      set(name, value);
      // WorkBuddy ThemeManager ignores theme-kind notifications while a skin is active.
      if (name === 'data-vscode-theme-kind' && !h.getAttribute('data-skin')) officialMode = value === 'vscode-dark' ? 'dark' : 'light';
    };
    // No CSS cache or adopted sheet remains: marker cleanup must not depend on them.
    vm.runInNewContext(await themeExpression('dark', true, uid, { nativeOnly: true }), context);
    assert.equal(h.getAttribute('data-skin'), null);
    assert.equal(officialMode, 'dark');
  }
});

test('clearing a native skin preserves its stylesheet attachment for later official selections', async () => {
  const { context, document } = renderer();
  const skin = { cssRules: [{ cssText: ':root{--wb-bg-primary:pink}' }], replaceSync(css) { this.cssRules = css ? [{ cssText: css }] : []; } };
  document.adoptedStyleSheets = [skin];
  document.documentElement.setAttribute('data-skin', 'special');
  context.localStorage.setItem('workbuddy.appearance.lastApplied.css', JSON.stringify({ resourceKey: 'special', css: ':root{--wb-bg-primary:pink}' }));
  vm.runInNewContext(await themeExpression('default', true, 'current'), context);
  assert.equal(document.adoptedStyleSheets[0], skin);
  assert.equal(skin.cssRules.length, 0);
  skin.replaceSync(':root{--wb-bg-primary:blue}');
  assert.equal(document.adoptedStyleSheets[0].cssRules[0].cssText, ':root{--wb-bg-primary:blue}');
});

test('nebula resolves transparent constants even from an existing installed theme file', () => {
  const start = source.indexOf('function getTheme(id)');
  const ctx = { THEMES_DIR: '/themes', path, BUILTIN_THEMES: {}, fs: {
    existsSync: () => true,
    readFileSync: () => JSON.stringify({ id: 'nebula', image: 'custom.webp', colors: {
      '--wb-button-primary-bg': 'white', '--wb-bg-secondary': '#111113', '--wb-color-text-primary': '#eee',
    } }),
  } };
  vm.runInNewContext(source.slice(start, source.indexOf('\n/**', start)), ctx);
  const theme = ctx.getTheme('nebula');
  assert.equal(theme.colors['--wb-button-primary-bg'], 'transparent');
  assert.equal(theme.colors['--wb-bg-secondary'], 'transparent');
  assert.equal(theme.colors['--wb-color-text-primary'], '#eee');
  assert.equal(theme.image, 'custom.webp');
  assert.equal(ctx.getTheme('other').colors['--wb-bg-secondary'], '#111113');
});


test('early custom theme restore preserves pending official synchronization for the switched account', async () => {
  const { context } = renderer();
  const key = 'workbuddy.appearance.state::personal::target';
  context.localStorage.setItem(key, JSON.stringify({ currentTheme: 'dark', pendingSync: { theme: 'dark' } }));
  vm.runInNewContext(await themeExpression('nebula', true, 'target'), context);
  assert.equal(JSON.parse(context.localStorage.getItem(key)).pendingSync.theme, 'dark');
});

test('frosted takeover completes even when background renderer timers and animation frames are suspended', async () => {
  const delays = [];
  const nativePage = {
    document: {
      documentElement: { getAttribute: () => 'dark', hasAttribute: () => false, style: { colorScheme: 'dark' } },
      body: { getAttribute: () => 'IDE Night' }, getElementById: () => null,
    },
    localStorage: { getItem: () => '{"theme":"dark"}' }, window: {},
    setTimeout() {}, clearTimeout() {}, requestAnimationFrame() {},
  };
  let applies = 0;
  const daemon = {
    PROFILE: { capabilities: { theme: true } }, cdp: { connected: true }, themeApplyGeneration: 0,
    readSessionState: () => ({ themeTakeoverEnabled: true }), currentAccount: () => null,
    getTheme: () => ({ dark: true, colors: {} }),
    LOCAL_THEME_OVERRIDES: [], themeExtrasCss: () => '', themeVarsCss: () => '',
    setTimeout: (resolve, ms) => { delays.push(ms); resolve(); },
    cdpSend: async (_, params) => {
      if (params.expression.includes('ready:')) return { result: { value: await vm.runInNewContext(params.expression, nativePage) } };
      applies++;
      return { result: { value: { applied: true } } };
    },
  };
  const start = source.indexOf('async function applyThemeByCdp(id, options = {})');
  vm.runInNewContext(source.slice(start, source.indexOf('\n/**', start)), daemon);
  let deadline;
  try {
    await Promise.race([daemon.applyThemeByCdp('nebula'), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Theme switch is waiting for suspended renderer timers')), 100);
    })]);
  } finally { clearTimeout(deadline); }
  assert.equal(applies, 2, 'native dark precedes glass');
  assert.deepEqual(delays, [120], 'the daemon owns the bounded settle delay');
});
