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

test('theme pane restores six radio choices and enabling takeover restores the saved theme', () => {
  const pane = section('function buildThemePane()', 'function buildEnhancePane()');
  for (const id of ['system', 'default', 'dark', 'eye-care', 'cyber-purple', 'nebula']) {
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
  assert.doesNotMatch(modal, /data-note-uid/);
  assert.match(modal, /\/api\/accounts\/order/);
  assert.match(source, /!rotationReminderEnabled\(\) \|\| state\.open \|\| state\.rotationNotice/);
});
test('account switching advice defaults on but keeps explicit opt-out', () => {
  const fragment = section('    var rotationReminderKey = ', '    // 账号 pane 初始化');
  const settings = new Map();
  const context = { PROFILE_ID: 'workbuddy-cn', root: { classList: { toggle() {} } }, localStorage: {
    getItem: key => settings.get(key) ?? null,
  } };
  vm.runInNewContext(fragment, context);
  assert.equal(context.rotationReminderEnabled(), true);
  settings.set('workdaddy.account.rotationReminder.workbuddy-cn', '0');
  assert.equal(context.rotationReminderEnabled(), false);
  settings.set('workdaddy.account.rotationReminder.workbuddy-cn', '1');
  assert.equal(context.rotationReminderEnabled(), true);
});

test('account settings persist hover visibility for note and growth popovers', () => {
  const fragment = section('    var rotationReminderKey = ', '    // 账号 pane 初始化');
  assert.match(source, /WBS_ACCOUNT_NOTE_HOVER_KEY = 'workdaddy\.account\.noteHover\.' \+ PROFILE_ID/);
  assert.match(source, /WBS_GROWTH_PLAN_HOVER_KEY = 'workdaddy\.account\.growthPlanHover\.' \+ PROFILE_ID/);
  assert.match(fragment, /function accountNoteHoverEnabled\(\)[\s\S]*localStorage\.getItem\(WBS_ACCOUNT_NOTE_HOVER_KEY\) !== '0'/);
  assert.match(fragment, /function growthPlanHoverEnabled\(\)[\s\S]*localStorage\.getItem\(WBS_GROWTH_PLAN_HOVER_KEY\) !== '0'/);
  const settings = new Map();
  const context = { PROFILE_ID: 'workbuddy-cn', WBS_ACCOUNT_NOTE_HOVER_KEY: 'workdaddy.account.noteHover.workbuddy-cn', WBS_GROWTH_PLAN_HOVER_KEY: 'workdaddy.account.growthPlanHover.workbuddy-cn', root: { classList: { toggle() {} } }, localStorage: {
    getItem: key => settings.get(key) ?? null,
  } };
  vm.runInNewContext(fragment, context);
  assert.equal(context.accountNoteHoverEnabled(), true);
  assert.equal(context.growthPlanHoverEnabled(), true);
  settings.set('workdaddy.account.noteHover.workbuddy-cn', '0');
  settings.set('workdaddy.account.growthPlanHover.workbuddy-cn', '0');
  assert.equal(context.accountNoteHoverEnabled(), false);
  assert.equal(context.growthPlanHoverEnabled(), false);

  const modal = section('function openAccountOrderModal()', 'function setupCreditSummary()');
  assert.match(modal, /data-account-note-hover/);
  assert.match(modal, /data-growth-plan-hover/);
  assert.match(modal, /鼠标悬浮显示账号备注/);
  assert.match(modal, /鼠标悬浮显示成长计划/);
  assert.match(modal, /localStorage\.setItem\(WBS_ACCOUNT_NOTE_HOVER_KEY, noteHover \? '1' : '0'\)/);
  assert.match(modal, /localStorage\.setItem\(WBS_GROWTH_PLAN_HOVER_KEY, growthHover \? '1' : '0'\)/);
  assert.match(source, /accountNoteHoverEnabled\(\) && button && !button\.contains\(event\.relatedTarget\)/);
  assert.match(source, /!growthPlanHoverEnabled\(\) \|\| !ring \|\| ring === activeRing/);

  assert.match(fragment, /function applyAccountNoteHoverState\(\)/);
  assert.match(fragment, /classList\.toggle\('wbs-acct-note-hover-off', !accountNoteHoverEnabled\(\)\)/);
  assert.match(modal, /applyAccountNoteHoverState\(\)/);
  assert.match(source, /\.wbs-root\.wbs-acct-note-hover-off \.wbs-account-name:hover:not\(:focus-visible\):not\(\[aria-expanded="true"\]\) \.wbs-account-name-edit\{opacity:0;pointer-events:none\}/);
});

test('disabling the hover preview removes the account name edit affordance from hover only', () => {
  const fragment = section('    var rotationReminderKey = ', '    // 账号 pane 初始化');
  const settings = new Map();
  const classes = new Set();
  const context = {
    PROFILE_ID: 'workbuddy-cn',
    WBS_ACCOUNT_NOTE_HOVER_KEY: 'workdaddy.account.noteHover.workbuddy-cn',
    WBS_GROWTH_PLAN_HOVER_KEY: 'workdaddy.account.growthPlanHover.workbuddy-cn',
    localStorage: { getItem: key => settings.get(key) ?? null },
    root: { classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } } },
  };
  vm.runInNewContext(fragment, context);
  // Default is on, so hovering keeps revealing the edit affordance.
  assert.equal(classes.has('wbs-acct-note-hover-off'), false);
  settings.set('workdaddy.account.noteHover.workbuddy-cn', '0');
  context.applyAccountNoteHoverState();
  assert.equal(classes.has('wbs-acct-note-hover-off'), true);
  settings.set('workdaddy.account.noteHover.workbuddy-cn', '1');
  context.applyAccountNoteHoverState();
  assert.equal(classes.has('wbs-acct-note-hover-off'), false);
});
test('growth plan popover has an accessible close button and glass note save contrast', () => {
  const growth = section('function dailyProgressPopoverHtml(', 'function updateDailyProgressCells()');
  assert.match(growth, /data-wbs-daily-close/);
  assert.match(growth, /aria-label="关闭成长计划"/);
  const daily = section('function setupDailyProgressPopover()', 'function setupModelRateLimitPopover()');
  assert.match(daily, /closest\('\[data-wbs-daily-close\]'\)/);
  assert.match(source, /html\[data-wbs-theme-id="nebula"\] \.wbs-account-note-footer \.primary\{background:rgba\(255,255,255,\.9\) !important/);
});
test('account settings modal uses grouped controls that wrap on narrow windows', () => {
  assert.match(source, /\.wbs-account-order-modes\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(source, /\.wbs-account-settings-toggle\{display:flex;align-items:center;justify-content:space-between/);
  assert.match(source, /\.wbs-account-order-modal \[data-fixed-order\]\+\.wbs-account-settings-toggle\{margin-top:14px\}/);
  assert.match(source, /@media\(max-width:420px\)\{\.wbs-account-order-modal\{width:100%/);
});
test('glass composer triggers receive an inline transparent background after teams remounts', () => {
  assert.match(source, /function syncGlassComposerTriggerBackgrounds\(\)/);
  assert.match(source, /node\.style\.setProperty\('background', 'transparent', 'important'\)/);
  assert.match(source, /node\.style\.setProperty\('background-color', 'transparent', 'important'\)/);
  assert.match(source, /\.cr-context-usage-tooltip-trigger/);
  const triggerSync = section('function syncGlassComposerTriggerBackgrounds()', 'function onInputSync()');
  assert.ok(triggerSync.includes('.cr-input-toolbar__right > span.cr-voice-trigger-wrap > span.cr-voice-trigger-tooltip'),
    'nested voice trigger receives the inline override after remounts');
  assert.match(source, /glassThemeObserver\.observe\(document\.documentElement/);
  assert.match(source, /\.wbs-account-note-footer \.primary:disabled\{background:rgba\(255,255,255,\.78\) !important[^}]*color:#34343c !important/);
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
    alive: true, registerDisposer() {}, loadWallpaperRotation() {},
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
    section('    var wallpaperPreviewUrls =', '    function setOpen('), context);
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

for (const nativeComposer of [false, true]) test('theme controls match the client theme capability: nativeComposer=' + nativeComposer, () => {
  const context = { CAPS: {nativeComposer}, WBS_BRAND: 'WorkDaddy', themePane: {dataset:{}}, wireThemePane() {}, applyAvatar() {} };
  vm.runInNewContext(section('function buildThemePane()', '    // 增强 pane'), context);
  context.buildThemePane();
  assert.equal((context.themePane.innerHTML.match(/name="wbs-theme"/g) || []).length, nativeComposer ? 2 : 6);
  assert.equal(context.themePane.innerHTML.includes('接管主题'), !nativeComposer);
  if (nativeComposer) {
    assert.match(context.themePane.innerHTML, /id="wbs-native-theme-card"/);
    assert.doesNotMatch(context.themePane.innerHTML, /value="(?:system|eye-care|cyber-purple|nebula)"/);
  }
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

test('CodeBuddy theme choices use native light/dark mode without takeover', async () => {
  const requests = [];
  const context = {
    CAPS: { nativeComposer: true, themeTakeover: false },
    sessState: { themeTakeover: false }, themePane: null, root: {},
    syncWallpaperCardVisibility() {}, toast() {},
    api: (route, options) => new Promise((resolve, reject) => requests.push({ route, options, resolve, reject })),
  };
  vm.runInNewContext(section('    var ALLOWED_THEMES =', '    // 页面主题由 daemon'), context);
  const pending = context.selectTheme('dark');
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].options.body).nativeOnly, true);
  requests[0].resolve({ ok: true });
  await pending;
  await context.selectTheme('nebula');
  await context.selectTheme('system');
  assert.equal(requests.length, 1, 'CodeBuddy must expose only the official light/dark modes');
});

test('daemon accepts nativeOnly only for CodeBuddy official modes', () => {
  assert.match(daemon, /const nativeOnly = body\.nativeOnly === true && PROFILE\.capabilities\.nativeComposer/);
  assert.match(daemon, /const applyOptions = nativeOnly \? \{ nativeOnly: true \} : null/);
  assert.match(daemon, /applyOptions \? applyThemeByCdp\(id, applyOptions\) : applyThemeByCdp\(id\)/);
  assert.match(daemon, /if \(nativeOnly && id !== 'default' && id !== 'dark'\)/);
});

test('theme apply route responds and persists native theme selections and handles failures', async () => {
  const start = daemon.indexOf("  if (req.method === 'POST' && p === '/api/theme-apply') {");
  const end = daemon.indexOf('\n  // 保存自定义主题', start);
  const route = vm.runInNewContext('(async function (req, res, p) {' + daemon.slice(start, end) + '})', {
    readBody: async req => req.body,
    themeApplyGeneration: 0,
    PROFILE: { capabilities: { nativeComposer: true } },
    getTheme: () => ({}),
    applyThemeByCdp: async (id, options) => {
      if (id === 'default') throw new Error('CDP unavailable');
      assert.equal(options.nativeOnly, true);
      return { ok: true };
    },
    fs: { writeFileSync: (file, data) => saved.push(JSON.parse(data)) },
    path, DATA_DIR: '/synthetic',
    json: (res, status, body) => { res.status = status; res.body = body; },
    log() {},
  });
  const saved = [];
  const success = {};
  await route({ method: 'POST', body: { id: 'dark', nativeOnly: true } }, success, '/api/theme-apply');
  assert.equal(success.status, 200);
  assert.equal(success.body.id, 'dark');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, 'dark');
  const failure = {};
  await route({ method: 'POST', body: { id: 'default', nativeOnly: true } }, failure, '/api/theme-apply');
  assert.equal(failure.status, 500);
  assert.equal(saved.length, 1);
});

test('follow system persists the system mode and reports the resolved appearance', async () => {
  const requests = [], notices = [];
  const context = {
    CAPS: {}, sessState: {themeTakeover:true}, themePane:null, root:{},
    syncWallpaperCardVisibility() {}, toast: message => notices.push(message),
    api: (route, options) => { requests.push({route, options}); return Promise.resolve({ok:true, resolved:'dark'}); },
  };
  vm.runInNewContext(section('    var ALLOWED_THEMES =', '    // 页面主题由 daemon'), context);
  await context.selectTheme('system');
  assert.equal(context.currentThemeId, 'system');
  assert.deepEqual(requests.map(r=>JSON.parse(r.options.body).id), ['system']);
  assert.match(notices[0], /深色/);
  // 壁纸目标在「跟随系统」下与浅色/深色一致：不会把 system 当作自定义主题目录
  assert.equal(context.themeSelectValue(), 'nebula');
});

test('wallpaper controls are exclusive to the selected frosted theme', () => {
  const wallpaper = {style:{}}, shadow = {style:{}};
  let loads=0;
  const context = {sessState:{themeTakeover:true}, loadWallpaperRotation() {}, loadWallpapers:()=>loads++, themePane:{querySelector: selector => selector==='#wbs-wallpaper-card'?wallpaper:shadow}};
  vm.runInNewContext(section('function syncWallpaperCardVisibility(', '    // 关闭接管后'),context);
  for(const id of ['system','default','dark','eye-care','cyber-purple','nebula']) {
    context.syncWallpaperCardVisibility(id);
    assert.equal(wallpaper.style.display, id==='nebula'?'':'none');
    assert.equal(shadow.style.display, wallpaper.style.display);
  }
  assert.equal(loads,1);
});
