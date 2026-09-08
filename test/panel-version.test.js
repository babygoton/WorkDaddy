'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
const start = source.indexOf('function wbsClientVersion(');
const end = source.indexOf('  var WBS_LANGUAGE', start);
function clientVersion(ua, ai = false) {
  return new Function('WBS_PROFILE_IS_AI', 'ua', source.slice(start, end) + '\nreturn wbsClientVersion(ua);')(ai, ua);
}
test('header reads running client version instead of Chrome or Electron versions', () => {
  assert.equal(clientVersion('Mozilla/5.0 WorkBuddy/5.5.3 Chrome/138.0.0.0 Electron/37.10.3'), '5.5.3');
  assert.equal(clientVersion('Mozilla/5.0 WorkBuddy/5.5.3.0 Chrome/138.0.0.0'), '5.5.3.0');
  assert.equal(clientVersion('Mozilla/5.0 WorkBuddyAI/5.5.3 Chrome/138.0.0.0', true), '5.5.3');
  assert.equal(clientVersion('WorkBuddy/5.5.3', true), '5.5.3');
  assert.equal(clientVersion('WorkBuddyAI/5.5.3'), '');
  assert.equal(clientVersion('Chrome/138.0.0.0 Electron/37.10.3'), '');
  assert.equal(clientVersion('WorkBuddy/5.5.3<script>'), '');
});
test('header writes version subtitle as text with a safe unknown-version fallback', () => {
  const begin = source.indexOf("var versionLine = root.querySelector('#wbs-version-line')");
  const finish = source.indexOf("    listen(window, 'workdaddy:automation-toast'", begin);
  const render = new Function('root', 'navigator', 'WBS_VERSION', 'wbsClientVersion', source.slice(begin, finish));
  const label = { textContent: '' };
  const root = { querySelector: () => label };
  render(root, { userAgent: 'WorkBuddy/5.5.3' }, '1.2.0', clientVersion);
  assert.equal(label.textContent, '5.5.3 (1.2.0)');
  render(root, { userAgent: 'Chrome/138.0.0.0' }, '1.2.0', clientVersion);
  assert.equal(label.textContent, '(1.2.0)');
});
