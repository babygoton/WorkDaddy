'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
const section = (a,b) => source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
test('theme takeover is visible above theme choices and retains the saved setting', () => {
  const theme = section('function buildThemePane()', 'function buildEnhancePane()');
  const sessions = section('function buildSessionsPane()', 'function wireSessionsPane()');
  assert.match(theme, /id="wbs-theme-takeover"/);
  assert.match(theme, /<div class="wbs-pcard-title">接管 WorkBuddy 主题<\/div>/);
  assert.doesNotMatch(theme, /关闭后，加载和切换账号时保留 WorkBuddy 的主题/);
  assert.match(source, /\.wbs-theme-takeover-row>\.wbs-pcard-title\{[^}]*flex:1/);
  assert.ok(theme.indexOf('id="wbs-theme-takeover"') < theme.indexOf('id="wbs-theme-seg"'));
  assert.doesNotMatch(sessions, /wbs-theme-takeover|wbs-sess-theme-takeover/);
  const wire = section('function wireThemePane()', '      var shadowSwitch =');
  assert.match(wire, /themeSwitch.checked = sessState.themeTakeover/);
  assert.match(wire, /if \(!themeSwitch\.dataset\.wbsWired\)/);
  assert.match(wire, /setSessionSwitchWire\('themeTakeoverEnabled', this\)/);
  assert.match(wire, /syncSessionModule\(\)/);
  const apply = section('function applySessionModule(', 'function syncSessionModule()');
  assert.match(apply, /themePane && themePane.querySelector\('#wbs-theme-takeover'\)/);
  assert.match(theme, /id="wbs-theme-appearance-options"/);
  assert.match(theme, /wbs-avatar-card wbs-theme-managed/);
  assert.match(theme, /wbs-fab-settings wbs-theme-managed/);
  assert.match(theme, /wbs-wallpaper-card wbs-theme-managed/);
  assert.match(source, /function syncThemeTakeoverVisibility\(enabled\)/);
  assert.match(source, /avatarLibrary\.select\('default'\)/);
});
test('theme choices do not activate official data-theme scopes and robot radios reuse their visual component', () => {
  const pane = section('function buildThemePane()', 'function buildEnhancePane()');
  assert.doesNotMatch(pane, /data-theme="/);
  assert.match(pane, /data-wbs-theme-option="dark"/);
  assert.match(pane, /class="wbs-theme-seg wbs-robot-seg"/);
  assert.match(pane, /class="wbs-theme-opt wbs-robot-option"/);
  assert.match(source, /closest\('#wbs-theme-seg \.wbs-theme-opt'\)/);
  assert.match(pane, /wbs-avatar-default-option/);
  assert.match(pane, /value="default"/);
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
  assert.match(source, /var visible = sessState\.themeTakeover && themeId === 'nebula'/);
  assert.match(source, /if \(!sessState\.themeTakeover\) return;\s+var id = segBtn/);
});
