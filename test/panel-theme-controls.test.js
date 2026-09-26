'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
const daemon = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const section = (a,b) => source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
test('frosted glass takeover is visible above wallpaper controls and retains the saved setting', () => {
  const theme = section('function buildThemePane()', 'function buildEnhancePane()');
  const sessions = section('function buildSessionsPane()', 'function wireSessionsPane()');
  assert.match(theme, /id="wbs-theme-takeover"/);
  assert.match(theme, /<div class="wbs-pcard-title">毛玻璃主题<\/div>/);
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
  assert.doesNotMatch(theme, /id="wbs-theme-appearance-options"/);
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
  assert.doesNotMatch(pane, /id="wbs-theme-seg"|data-wbs-theme-option=/);
  assert.match(pane, /毛玻璃主题/);
  assert.match(pane, /class="wbs-theme-seg wbs-robot-seg"/);
  assert.match(pane, /class="wbs-theme-opt wbs-robot-option"/);
  assert.doesNotMatch(source, /closest\('#wbs-theme-seg \.wbs-theme-opt'\)/);
  assert.match(pane, /wbs-avatar-default-option/);
  assert.match(pane, /value="default"/);
});

test('theme pane exposes only the frosted glass takeover switch', () => {
  const pane = section('function buildThemePane()', 'function buildEnhancePane()');
  assert.match(pane, /<div class="wbs-pcard-title">毛玻璃主题<\/div>/);
  assert.doesNotMatch(pane, /<div class="wbs-pcard-title">主题外观<\/div>/);
  assert.doesNotMatch(pane, /data-wbs-theme-option=/);
  assert.match(daemon, /if \(state\.themeTakeoverEnabled\) await applyThemeByCdp\('nebula'\)/);
  assert.match(daemon, /let id = 'nebula';/);
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
  assert.doesNotMatch(source, /if \(!sessState\.themeTakeover\) return;\s+var id = segBtn/);
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

test('theme refresh preserves robot radio selection while keeping the glass wallpaper visible', async () => {
  const robot = { active: true, getAttribute: () => null };
  robot.classList = { toggle: (_, selected) => { robot.active = selected; } };
  const group = buttons => ({ querySelectorAll: () => buttons, querySelector: () => buttons.find(b => b.active) });
  let synced = null;
  const root = { querySelector: () => group([robot]) };
  const context = { root, api: () => Promise.resolve({current:'cyber-purple'}), syncWallpaperCardVisibility: theme => { synced = theme; } };
  vm.runInNewContext(section('    function loadThemes()', '    // 页面主题由 daemon'), context);
  context.loadThemes();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(robot.active, true, 'appearance refresh must not clear the robot highlight');
  assert.equal(synced, 'nebula');
  assert.equal(context.themeSelectValue(), 'nebula');
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
