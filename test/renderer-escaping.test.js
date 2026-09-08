'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');
const automationPicker = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'automation-picker.js'), 'utf8');
// 内部调试模块（git 不跟踪）：存在才测试，缺失（他人环境）则跳过
const pickerPath = path.join(__dirname, '..', 'scripts', 'picker-internal.js');
const picker = fs.existsSync(pickerPath) ? fs.readFileSync(pickerPath, 'utf8') : null;

function sourceBetween(start, end, src) {
  src = src || source;
  const startIndex = src.indexOf(start);
  const endIndex = src.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `missing source block ${start}`);
  return src.slice(startIndex, endIndex);
}

test('HTML and attribute escaping cover markup and quoted attributes', () => {
  const escapeSource = sourceBetween('function esc(t)', 'function checkinHtml');
  const getHelpers = new Function(`${escapeSource}; return { esc, escAttr };`);
  const { esc, escAttr } = getHelpers();
  assert.equal(esc('<img src=x onerror=1>&'), '&lt;img src=x onerror=1&gt;&amp;');
  assert.equal(escAttr('"\' <x> &'), '&quot;&#39; &lt;x&gt; &amp;');
  const payload = '\"><img src=x onerror=alert(1)>\'&';
  const rendered = `<button data-name="${escAttr(payload)}">${esc(payload)}</button>`;
  assert.doesNotMatch(rendered, /<img/i);
  assert.doesNotMatch(rendered, /data-name="">/i);
});

test('toast content is always written as text', () => {
  const toast = sourceBetween('function toast(msg', 'registerDisposer(function () {');
  assert.match(toast, /toastRuntime\.show\(\{ message: wbsTranslateString\(String\(msg/);
  const runtime = fs.readFileSync(path.join(__dirname, '../tools/toast-runtime/entry.jsx'), 'utf8');
  assert.doesNotMatch(runtime, /dangerouslySetInnerHTML|innerHTML/);
  assert.match(runtime, /const message = String\(detail\.message/);
  assert.doesNotMatch(toast, /el\([^\n]+,\s*msg\s*\)/);
  const elementHelper = sourceBetween('function el(tag', 'function maskPhone');
  assert.match(elementHelper, /textContent\s*=\s*String\(text\)/);
  assert.doesNotMatch(elementHelper, /innerHTML/);
});

test('session and account selectors escape every text and attribute sink', () => {
  const accountSelect = sourceBetween('function loadSessionAccounts()', 'function loadSessions()');
  assert.match(accountSelect, /'<option value="' \+ escAttr\(a\.uid\) \+ '">' \+ esc\(a\.nickname/);
  assert.doesNotMatch(accountSelect, /'<option value="' \+ a\.uid/);
  assert.doesNotMatch(accountSelect, /\+ \(a\.nickname \|\|/);

  const copyModal = sourceBetween('function openCopyModal(ids)', 'function openDeleteModal(ids)');
  assert.match(copyModal, /'<option value="' \+ escAttr\(a\.uid\) \+ '">' \+ esc\(a\.nickname \|\| a\.uid\)/);
  assert.match(copyModal, /a\.phone \? '[^']*' \+ esc\(a\.phone\)/);
  assert.doesNotMatch(copyModal, /'<option value="' \+ a\.uid/);

  const sessions = sourceBetween('function renderSessions()', 'function activeAutoCopyCount()');
  assert.equal((sessions.match(/escAttr\(key\)/g) || []).length, 1);
  assert.equal((sessions.match(/escAttr\(uid\)/g) || []).length, 1);
  assert.equal((sessions.match(/escAttr\(s\.id\)/g) || []).length, 2);
  assert.equal((sessions.match(/esc\(title\)/g) || []).length, 2);
  assert.equal((sessions.match(/esc\(fmtHumanTime\(/g) || []).length, 2);
  assert.match(sessions, /title="' \+ escAttr\(group\.cwd\)/);
  assert.match(sessions, /esc\(shortWs\(group\.cwd\)\)/);
  assert.doesNotMatch(sessions, /data-(?:auto-key|auto-uid|id)="' \+ (?:key|uid|s\.id)/);
});

test('model, wallpaper, and account cards escape each dynamic HTML sink', () => {
  const models = sourceBetween('function modelRowHtml(model, options)', 'function loadModels()');
  assert.equal((models.match(/escAttr\(model\.index\)/g) || []).length, 3);
  assert.equal((models.match(/escAttr\(model\.backupId\)/g) || []).length, 3);
  assert.match(models, /escAttr\(selectionKey\)/);
  assert.match(models, /title="' \+ escAttr\(model\.name \|\| model\.id/);
  assert.match(models, /'">' \+ esc\(model\.name \|\| model\.id/);
  assert.doesNotMatch(models, /data-model-(?:backup|test|delete-official)="' \+ model\.index/);
  assert.doesNotMatch(models, /data-model-(?:copy|edit|enable)="' \+ model\.backupId/);

  const wallpapers = sourceBetween('function loadWallpapers(force)', 'function setOpen(open, options)');
  assert.match(wallpapers, /data-wp="' \+ escAttr\(w\.name\)/);
  assert.match(wallpapers, /title="' \+ escAttr\(w\.title\)/);
  assert.match(wallpapers, /data-src="' \+ escAttr\(wallpaperUrl\)/);
  assert.match(wallpapers, /alt="' \+ escAttr\(w\.title\)/);
  assert.match(wallpapers, /wbs-wp-badge">' \+ esc\(/);
  assert.match(wallpapers, /data-del="' \+ escAttr\(w\.name\)/);
  assert.match(wallpapers, /btn\.getAttribute\('data-del'\)/);
  assert.doesNotMatch(wallpapers, /(?:data-wp|title|data-src|alt)="' \+ (?:w\.|wallpaperUrl)/);

  const accounts = sourceBetween('function render(data)', 'function updateAccountSummary()');
  assert.equal((accounts.match(/escAttr\(a\.uid\)/g) || []).length, 3);
  assert.match(accounts, /data-primary-uid="' \+ escAttr\(a\.uid\)/);
  assert.equal((accounts.match(/escAttr\(a\.nickname \|\| '未命名'\)/g) || []).length, 2);
  assert.match(accounts, /var nameVal = state\.mask \? maskAccountName\(rawName\) : rawName;/);
  assert.match(accounts, /var idVal = state\.mask \? maskAccountId\(rawId\) : rawId;/);
  assert.match(accounts, /wbs-name">' \+ esc\(nameVal\)/);
  assert.match(accounts, /wbs-val">' \+ esc\(idVal\)/);
  assert.match(accounts, /wbs-val[^\n]+esc\(ts\.label\)/);
  assert.doesNotMatch(accounts, /data-(?:uid|name)="' \+ a\./);
  assert.doesNotMatch(accounts, /var idVal = a\.phone \? a\.phone/);
});

test('account masking preference persists per WorkDaddy profile', () => {
  assert.match(source, /var WBS_ACCOUNT_MASK_KEY = 'workdaddy\.account\.mask\.' \+ PROFILE_ID;/);
  assert.match(source, /localStorage\.getItem\(WBS_ACCOUNT_MASK_KEY\) === '1'/);
  const toggle = sourceBetween('function toggleAccountMask()', 'function refresh()');
  assert.match(toggle, /localStorage\.setItem\(WBS_ACCOUNT_MASK_KEY, state\.mask \? '1' : '0'\)/);
});

test('dynamic errors are escaped and check-in messages never enter badge HTML', () => {
  assert.doesNotMatch(sourceBetween('function checkinHtml', 'function el(tag'), /c\.message|esc\(msg\)/);
  assert.match(source, /会话加载失败: ' \+ esc\(e\.message \|\| e\)/);
  assert.match(source, /模型加载失败：' \+ esc\(e\.message \|\| e\)/);
  assert.match(source, /无法连接本地服务: ' \+ esc\(e\.message \|\| e\)/);
  assert.doesNotMatch(source, /innerHTML\s*=\s*'[^\n]*'\s*\+\s*\(e\.message \|\| e\)/);
});

test('automation inspector escapes page-controlled tree labels and copies element details as plain text', () => {
  const inspector = sourceBetween('function showAutomationInspector(stack, fallbackEl)', 'function stopAutomationInspect()', automationPicker);
  assert.match(inspector, /esc\(nodeLabel\(node\)\)/);
  assert.match(inspector, /copyPlainText\(payload\)/);
  assert.match(inspector, /selected\.outerHTML/);
  assert.doesNotMatch(inspector, /\+ nodeLabel\(node\) \+/);
  assert.doesNotMatch(inspector, /innerHTML = selected\.outerHTML/);
});
