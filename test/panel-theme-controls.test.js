'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
const daemon = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const section = (a,b) => source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
test('theme takeover is visible above the five appearance choices and retains the saved setting', () => {
  const theme = section('function buildThemePane()', 'function buildEnhancePane()');
  const sessions = section('function buildSessionsPane()', 'function wireSessionsPane()');
  assert.match(theme, /id="wbs-theme-takeover"/);
  assert.match(theme, /<div class="wbs-pcard-title">接管主题<\/div>/);
  assert.doesNotMatch(theme, /关闭后，加载和切换账号时保留 WorkBuddy 的主题/);
  assert.match(source, /\.wbs-theme-takeover-row>\.wbs-pcard-title\{[^}]*flex:1/);
  assert.ok(theme.indexOf('id="wbs-theme-takeover"') < theme.indexOf('wbs-wallpaper-card'));
  assert.doesNotMatch(sessions, /wbs-theme-takeover|wbs-sess-theme-takeover/);
  const wire = section('function wireThemePane()', '      var shadowSwitch =');
  assert.match(wire, /themeSwitch.checked = sessState.themeTakeover/);
  assert.match(wire, /if \(!themeSwitch\.dataset\.wbsWired\)/);
  assert.match(wire, /setSessionSwitchWire\('themeTakeoverEnabled', this\)/);
  assert.match(wire, /syncSessionModule\(\)/);
  const apply = section('function applySessionModule(', 'function syncSessionModule()');
  assert.match(apply, /themePane && themePane.querySelector\('#wbs-theme-takeover'\)/);
  assert.match(theme, /id="wbs-theme-appearance-options"/);
  assert.match(theme, /class="wbs-pcard wbs-avatar-card"/);
  assert.ok(theme.indexOf('wbs-avatar-card') < theme.indexOf('wbs-fab-settings'));
  assert.ok(theme.indexOf('wbs-fab-settings') < theme.indexOf('id="wbs-theme-takeover"'));
  assert.match(theme, /class="wbs-pcard wbs-fab-settings"/);
  assert.match(theme, /wbs-wallpaper-card wbs-theme-managed/);
  assert.match(source, /function syncThemeTakeoverVisibility\(enabled\)/);

});
test('theme choices do not activate official data-theme scopes and robot radios reuse their visual component', () => {
  const pane = section('function buildThemePane()', 'function buildEnhancePane()');
  assert.doesNotMatch(pane, /data-theme="/);
  assert.match(pane, /id="wbs-theme-seg"/);
  assert.match(pane, /接管主题/);
  assert.match(pane, /class="wbs-theme-seg wbs-robot-seg"/);
  assert.match(pane, /class="wbs-theme-opt wbs-robot-option"/);
  assert.doesNotMatch(source, /closest\('#wbs-theme-seg \.wbs-theme-opt'\)/);
  assert.match(pane, /wbs-avatar-default-option/);
  assert.match(pane, /value="default"/);
});

test('theme pane restores five radio choices and enabling takeover restores the saved theme', () => {
  const pane = section('function buildThemePane()', 'function buildEnhancePane()');
  for (const id of ['default', 'dark', 'eye-care', 'cyber-purple', 'nebula']) {
    assert.ok(pane.includes('name="wbs-theme" value="' + id + '"'));
  }
  assert.match(pane, /<div class="wbs-pcard-title">接管主题<\/div>/);
  assert.match(daemon, /if \(state\.themeTakeoverEnabled\) await applyThemeByCdp\(readSavedThemeId\(\)\)/);
});
test('account order is centered in the panel and always shows names without numbered rows', () => {
  const modal = section('function openAccountOrderModal()', 'function setupCreditSummary()');
  assert.match(modal, /wbs-modal-mask wbs-modal-mask-panel/);
  assert.match(modal, /panel\.appendChild\(mask\)/);
  assert.doesNotMatch(modal, /maskAccountName|wbs-account-order-hint|<small>/);
  assert.match(modal, /esc\(name\)/);
  assert.match(modal, /账号设置/);
  assert.match(modal, /data-rotation-reminder/);
  assert.match(modal, /积分不足时的账号切换建议/);
  assert.doesNotMatch(modal, /账号备注|data-note-uid/);
  assert.match(modal, /\/api\/accounts\/order/);
  assert.match(source, /!rotationReminderEnabled\(\) \|\| state\.open \|\| state\.rotationNotice/);
});
test('account switching advice defaults on but keeps explicit opt-out', () => {
  const fragment = section('    var rotationReminderKey = ', '    // 账号 pane 初始化');
  const settings = new Map();
  const context = { PROFILE_ID: 'workbuddy-cn', localStorage: {
    getItem: key => settings.get(key) ?? null,
  } };
  vm.runInNewContext(fragment, context);
  assert.equal(context.rotationReminderEnabled(), true);
  settings.set('workdaddy.account.rotationReminder.workbuddy-cn', '0');
  assert.equal(context.rotationReminderEnabled(), false);
  settings.set('workdaddy.account.rotationReminder.workbuddy-cn', '1');
  assert.equal(context.rotationReminderEnabled(), true);
});
test('avatar presets retain legacy custom uploads and are safe before official conversion completes', () => {
  const context = {};
  vm.runInNewContext(section('  function resolveAvatarChoice(', '  function checkinHtml('), context);
  const choose = context.resolveAvatarChoice;
  assert.equal(choose(null, 'official', 'brand').src, 'official');
  assert.equal(choose('workbuddy', 'official', 'brand').preset, 'workbuddy');
  assert.equal(choose('workdaddy', 'official', 'brand').src, 'brand');
  assert.equal(choose('default', 'official', 'brand', 'default-avatar').src, 'default-avatar');
  assert.equal(choose('data:image/png;base64,upload', 'official', 'brand').src, 'data:image/png;base64,upload');
  assert.equal(choose(null, null, 'brand').src, null);
  assert.equal(choose('javascript:bad', 'official', 'brand').src, 'official');
  assert.match(source, /if \(!target\) \{\s*restoreAvatarDom\(\);\s*return;/);
  assert.doesNotMatch(source, /id="wbs-avatar-reset"/);
});

test('theme takeover off hides every managed theme module and blocks custom theme clicks', () => {
  const visibility = section('function syncThemeTakeoverVisibility(', '    // 主题 pane 事件绑定');
  assert.match(visibility, /querySelectorAll\('\.wbs-theme-managed'\)/);
  assert.match(visibility, /node\.style\.display = visible \? '' : 'none'/);
  assert.match(source, /var visible = sessState\.themeTakeover/);
  assert.match(source, /if \(!sessState\.themeTakeover/);
});


test('theme takeover toggles only theme controls without changing the selected avatar', () => {
  const managed = [{ style: {} }, { style: {} }];
  let avatarChanges = 0;
  const context = {
    themePane: { querySelectorAll: selector => {
      assert.equal(selector, '.wbs-theme-managed');
      return managed;
    } },
    avatarLibrary: { snapshot: () => ({ selected: 'workdaddy' }), select: () => { avatarChanges++; } },
    applyAvatar: () => { avatarChanges++; },
  };
  vm.runInNewContext(section('function syncThemeTakeoverVisibility(', '    // 主题 pane 事件绑定'), context);
  context.syncThemeTakeoverVisibility(false);
  assert.ok(managed.every(node => node.style.display === 'none'));
  context.syncThemeTakeoverVisibility(true);
  assert.ok(managed.every(node => node.style.display === ''));
  assert.equal(avatarChanges, 0);
  assert.match(source, /\.wbs-theme-takeover-row:has\(#wbs-theme-takeover:not\(:checked\)\)\{margin-bottom:0;padding-bottom:0;border-bottom:0\}/);
});


test('glass panel controls keep opaque primary colors without changing composer buttons', () => {
  const rule = source.split('\n').find(line => line.includes('html[data-wbs-theme-id="nebula"] .wbs-panel,'));
  assert.ok(rule, 'glass overrides are scoped to WorkDaddy panel and modal surfaces');
  assert.match(rule, /html\[data-wbs-theme-id="nebula"\] \.wbs-modal/);
  assert.match(rule, /--wb-button-primary-bg:var\(--wb-palette-white-90\)/);
  assert.match(rule, /--wb-button-primary-fg:var\(--wb-bg-primary\)/);
  assert.doesNotMatch(rule, /\.wbs-root|\.wbs-stash-inline|\.wbs-fab/);
});

test('theme refresh restores only theme radios and ignores a response older than a user selection', async () => {
  const radios = ['default', 'dark', 'eye-care', 'cyber-purple', 'nebula'].map(value => ({ value, checked: false, closest: () => ({classList: { toggle() {} }}) }));
  const robot = { checked: true };
  let resolve, synced;
  const themePane = { querySelectorAll(selector) {
    assert.equal(selector, '#wbs-theme-seg input[name="wbs-theme"]');
    return radios;
  }};
  const context = { themePane, api: () => new Promise(r => { resolve = r; }), syncWallpaperCardVisibility: id => { synced = id; } };
  vm.runInNewContext(section('    var ALLOWED_THEMES =', '    // 页面主题由 daemon'), context);
  const loading = context.loadThemes();
  resolve({current:'cyber-purple'});
  await loading;
  assert.equal(radios.find(r=>r.checked).value, 'cyber-purple');
  assert.equal(robot.checked, true);
  assert.equal(synced, 'cyber-purple');
  const stale = context.loadThemes();
  context.themeSelectionSerial++;
  context.syncThemeSelection('dark');
  resolve({current:'nebula'});
  await stale;
  assert.equal(radios.find(r=>r.checked).value, 'dark');
});

test('all panel switches share themed track, thumb and keyboard focus colors', () => {
  const css = section("    '.wbs-switch{", "    /* 背景毛玻璃开关");
  assert.match(css, /background:var\(--wb-bg-tertiary/);
  assert.match(css, /input:checked \+ \.wbs-switch-slider\{background:var\(--wb-button-primary-bg/);
  assert.match(css, /input:checked \+ \.wbs-switch-slider:before\{background:var\(--wb-button-primary-fg/);
  assert.match(css, /input:focus-visible \+ \.wbs-switch-slider/);
  assert.doesNotMatch(css, /background:#(?:f2f2f4|111113)/);
});

test('custom themes color account and expiry bars with primary token while preserving expiry opacity', () => {
  const rule = source.split('\n').find(line => line.includes('--wbs-credit-theme-color:var(--wb-button-primary-bg)'));
  assert.ok(rule, 'custom skins and nonstandard WorkDaddy themes opt into the theme token');
  for (const id of ['default','dark','nebula']) assert.ok(rule.includes(':not([data-wbs-theme-id="'+id+'"])'));
  assert.ok(rule.includes('[data-skin]'));
  assert.ok(rule.includes('.wbs-credit-summary-popover'));
  assert.match(source, /color-mix\(in srgb,var\(--wbs-credit-theme-color/);
  assert.match(source, /calc\(var\(--wbs-credit-alpha,1\) \* 100%\)/);
});

for (const trigger of ['switch', 'settings refresh']) test('frosted wallpaper starts loading on ' + trigger + ' without revisiting the tab', async () => {
  const grid = { dataset: {}, innerHTML: '壁纸加载中…', querySelectorAll: () => [] };
  const card = { style: {} }, toggle = { checked: false };
  const nodes = { '#wbs-wallpapers': grid, '#wbs-wallpaper-card': card, '#wbs-theme-takeover': toggle };
  const requests = [];
  let resolveWallpapers;
  const context = {
    CAPS: {}, currentThemeId: 'nebula', sessState: {}, enhancePane: null, conversationUsageEnabled: false,
    themePane: { querySelector: selector => nodes[selector] || null, querySelectorAll: () => [card] },
    root: { querySelector: selector => nodes[selector] || null },
    API: 'http://127.0.0.1:47833',
    api: (route, opts) => {
      requests.push(route);
      if (route === '/api/wallpapers') return new Promise(resolve => { resolveWallpapers = resolve; });
      return Promise.resolve({ ok: true, themeTakeoverEnabled: route === '/api/session-module-set' ? JSON.parse(opts.body).enabled : true });
    },
    renderQpList() {}, renderExploreOptions() {}, syncStash() {}, lockPanelHeight() {},
    setTimeout() {}, escAttr: value => value, esc: value => value,
    toast: message => assert.fail(message),
  };
  vm.runInNewContext(section('function applySessionModule(', '    /** 增强页快捷短语列表') +
    section('function syncWallpaperCardVisibility(', '    // 主题 pane 事件绑定') +
    section('function loadWallpapers(force)', '    function setOpen('), context);
  context.applySessionModule({ ok: true, themeTakeoverEnabled: false });
  context.syncWallpaperCardVisibility('nebula'); // First visit with takeover off.
  assert.equal(requests.length, 0);
  if (trigger === 'switch') {
    toggle.checked = true;
    await context.setSessionSwitchWire('themeTakeoverEnabled', toggle);
  } else {
    context.syncSessionModule();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(card.style.display, '');
  assert.equal(requests.filter(route => route === '/api/wallpapers').length, 1);
  context.applySessionModule({ ok: true, themeTakeoverEnabled: true });
  assert.equal(requests.filter(route => route === '/api/wallpapers').length, 1, 'pending loads are reused');
  resolveWallpapers({ wallpapers: [{ name: 'wallpaper-01.webp', title: '官方壁纸 1' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(grid.innerHTML, /data-wp="wallpaper-01.webp"/);
  assert.doesNotMatch(grid.innerHTML, /壁纸加载中/);
  context.applySessionModule({ ok: true, themeTakeoverEnabled: false });
  context.applySessionModule({ ok: true, themeTakeoverEnabled: true });
  assert.equal(requests.filter(route => route === '/api/wallpapers').length, 1, 'loaded wallpaper grid is reused');
});

test('primary actions use native button tokens in every interaction state', () => {
  for (const selector of ['.wbs-modal-btn.wbs-modal-ok', '.wbs-sess-bbtn.active', '.wbs-acc-switch.armed', '.wbs-sess-done']) {
    const start = source.indexOf(selector + '{');
    const rule = source.slice(start, source.indexOf('}', start));
    assert.match(rule, /background:var\(--wb-button-primary-bg/);
    assert.match(rule, /color:var\(--wb-button-primary-fg/);
  }
  assert.doesNotMatch(source, /--wb-button-primary-(hover-bg|text)\b/);
  assert.match(source, /background:var\(--wb-button-primary-bg-disabled/);
  assert.match(source, /color:var\(--wb-button-primary-fg-disabled/);
  assert.match(source, /\.wbs-modal-btn:not\(:where\(\.wbs-modal-ok,\.primary\)\)/);
  const glass = source.split('\n').find(line => line.includes('html[data-wbs-theme-id="nebula"] .wbs-panel,'));
  assert.match(glass, /\.wbs-account-note-popover/);
  assert.match(glass, /\.wbs-status-popover/);
});

for (const nativeComposer of [false, true]) test('theme controls are rendered only for WorkBuddy: nativeComposer=' + nativeComposer, () => {
  const context = { CAPS: {nativeComposer}, WBS_BRAND: 'WorkDaddy', themePane: {dataset:{}}, wireThemePane() {}, applyAvatar() {} };
  vm.runInNewContext(section('function buildThemePane()', '    // 增强 pane'), context);
  context.buildThemePane();
  assert.equal((context.themePane.innerHTML.match(/name="wbs-theme"/g) || []).length, nativeComposer ? 0 : 5);
  assert.equal(context.themePane.innerHTML.includes('接管主题'), !nativeComposer);
});

test('rapid theme selections ignore stale failures and disabled takeover prevents writes', async () => {
  const requests = [], notices = [];
  const context = {
    CAPS: {}, sessState: {themeTakeover:true}, themePane:null, root:{},
    syncWallpaperCardVisibility() {}, toast: message => notices.push(message),
    api: (route, options) => new Promise((resolve,reject) => requests.push({route, options, resolve, reject})),
  };
  vm.runInNewContext(section('    var ALLOWED_THEMES =', '    // 页面主题由 daemon'), context);
  const first = context.selectTheme('eye-care');
  const second = context.selectTheme('cyber-purple');
  requests[1].resolve({ok:true}); await second;
  requests[0].reject(new Error('cancelled')); await first;
  assert.equal(context.currentThemeId, 'cyber-purple');
  assert.deepEqual(requests.map(r=>JSON.parse(r.options.body).id), ['eye-care','cyber-purple']);
  assert.equal(notices.length, 1, 'an older rejection must not roll back or show a false error');
  context.sessState.themeTakeover = false;
  await context.selectTheme('default');
  assert.equal(requests.length, 2);
});

test('wallpaper controls are exclusive to the selected frosted theme', () => {
  const wallpaper = {style:{}}, shadow = {style:{}};
  let loads=0;
  const context = {sessState:{themeTakeover:true}, loadWallpapers:()=>loads++, themePane:{querySelector: selector => selector==='#wbs-wallpaper-card'?wallpaper:shadow}};
  vm.runInNewContext(section('function syncWallpaperCardVisibility(', '    // 关闭接管后'),context);
  for(const id of ['default','dark','eye-care','cyber-purple','nebula']) {
    context.syncWallpaperCardVisibility(id);
    assert.equal(wallpaper.style.display, id==='nebula'?'':'none');
    assert.equal(shadow.style.display, wallpaper.style.display);
  }
  assert.equal(loads,1);
});
