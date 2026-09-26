'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
function expression(target = 'target') {
  const start = source.indexOf('function accountSwitchThemeExpression(');
  assert.ok(start >= 0, 'theme switch snapshot builder exists');
  const context = {};
  vm.runInNewContext(source.slice(start, source.indexOf('\nasync function preserveAccountSwitchTheme', start)), context);
  return context.accountSwitchThemeExpression(target);
}
function renderer(resource = 'dark') {
  const applied = { kind: 'theme', resourceKey: resource, appearance: resource === 'dark' ? 'dark' : 'light', nameZh: resource };
  const entries = new Map([
    ['workbuddy.appearance.lastApplied', JSON.stringify(applied)],
    ['workbuddy.appearance.state::personal::source', '{"currentTheme":"dark"}'],
    ['workbuddy.appearance.state::personal::other', '{"currentTheme":"light"}'],
    ['workbuddy.appearance.state::enterprise::target', '{"currentTheme":"light","extra":true}'],
    ['workbuddy.appearance.mode::enterprise::enterprise::target', 'light'],
    ['workbuddy.appearance.lastApplied.css', '{"resourceKey":"theme-demo","css":"body{color:red}"}'],
  ]);
  const localStorage = { get length() { return entries.size; }, key: i => [...entries.keys()][i], getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
  return { entries, context: { localStorage, document: { documentElement: { getAttribute: () => applied.appearance } } } };
}
for (const resource of ['light', 'dark', 'theme-demo']) test('account switch gives current ' + resource + ' precedence over destination cloud theme', async () => {
  const h = renderer(resource), before = new Map(h.entries);
  assert.equal((await vm.runInNewContext(expression(), h.context)).prepared, true);
  for (const scope of ['personal', 'enterprise']) {
    const state = JSON.parse(h.entries.get('workbuddy.appearance.state::' + scope + '::target'));
    assert.equal(state.currentTheme, resource);
    // WorkBuddy syncCloudTheme prioritizes this pending selection over getSelections().
    assert.equal(state.pendingSync.theme, resource);
    assert.equal(JSON.parse(h.entries.get('workbuddy.appearance.lastApplied::' + scope + '::target')).resourceKey, resource);
  }
  assert.equal(h.entries.get('workbuddy.appearance.mode::enterprise::enterprise::target'), resource === 'dark' ? 'dark' : 'light');
  assert.equal(JSON.parse(h.entries.get('workbuddy.appearance.state::enterprise::target')).extra, true);
  for (const key of ['workbuddy.appearance.state::personal::source', 'workbuddy.appearance.state::personal::other', 'workbuddy.appearance.lastApplied', 'workbuddy.appearance.lastApplied.css']) assert.equal(h.entries.get(key), before.get(key));
});
test('next switch uses the latest official selection and keeps no persistent hook', async () => {
  const h = renderer('light');
  await vm.runInNewContext(expression(), h.context);
  h.context.localStorage.setItem('workbuddy.appearance.lastApplied', JSON.stringify({ kind: 'theme', resourceKey: 'theme-new', appearance: 'light' }));
  await vm.runInNewContext(expression('next'), h.context);
  assert.equal(JSON.parse(h.entries.get('workbuddy.appearance.state::personal::next')).currentTheme, 'theme-new');
  assert.doesNotMatch(expression(), /MutationObserver|setInterval|addEventListener|fetch\(/);
});
test('missing or malformed appearance data does not alter target account settings', async () => {
  for (const raw of [null, '{broken', '{"resourceKey":"invalid/resource"}']) {
    const h = renderer();
    if (raw === null) h.entries.delete('workbuddy.appearance.lastApplied');
    else h.entries.set('workbuddy.appearance.lastApplied', raw);
    const before = [...h.entries];
    assert.equal((await vm.runInNewContext(expression(), h.context)).prepared, false);
    assert.deepEqual([...h.entries], before);
  }
});


test('stale cross-window hydration cannot erase the pending selection on the next startup', async () => {
  const h = renderer('dark');
  let authority = 'light';
  h.context.wb = { config: { async setPreference(key, value) {
    assert.equal(key, 'appearanceTheme'); authority = value;
  } } };
  await vm.runInNewContext(expression(), h.context);
  // Official installAppearanceCrossWindowSync only hydrates a non-empty string.
  if (typeof authority === 'string' && authority) {
    h.context.localStorage.setItem('workbuddy.appearance.state::personal::target', JSON.stringify({ currentTheme: authority }));
  }
  const state = JSON.parse(h.entries.get('workbuddy.appearance.state::personal::target'));
  assert.equal(state.currentTheme, 'dark');
  assert.equal(state.pendingSync.theme, 'dark');
});
