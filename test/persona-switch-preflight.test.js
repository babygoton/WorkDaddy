'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const inject = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
const apiSource = inject.slice(inject.indexOf('  function api(path, opts) {'), inject.indexOf('  // 调试：递归收集所有元素'));

test('persona repair remains available in code but is disabled in the current account UI and switch flow', () => {
  assert.match(inject, /暂停身份资料提醒入口：保留修复代码/);
  assert.match(inject, /暂停身份资料修复入口：保留 beforePersonaSwitch\/openPersonaDialog/);
  assert.doesNotMatch(inject, /^\s*personaSwitchPreflight = beforePersonaSwitch;/m);
  assert.doesNotMatch(inject, /^\s*refreshPersonaNotice\(\);$/m);
  assert.doesNotMatch(inject, /^\s*'<div class="wbs-persona-notice"/m);
});

function harness(preflight) {
  const requests = [];
  const ctx = vm.createContext({ CAPS: {}, API: 'http://127.0.0.1', WBS_API_TOKEN: 'fixture-token', personaSwitchPreflight: preflight,
    fetch: async (url, request) => { requests.push({ url, request }); return { ok: true, json: async () => ({ ok: true }) }; },
  });
  vm.runInContext(apiSource, ctx);
  return { ctx, requests };
}
test('switch HTTP request waits for persona confirmation; internal bypass flag never reaches fetch', async () => {
  let confirm;
  const h = harness(uid => { assert.equal(uid, 'destination'); return new Promise(resolve => { confirm = resolve; }); });
  const pending = h.ctx.api('/api/switch', { method: 'POST', body: '{"uid":"destination","reload":true}' });
  assert.equal(h.requests.length, 0);
  confirm(); await pending;
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].request.body, '{"uid":"destination","reload":true}');
  assert.equal(h.requests[0].request._wbsPersonaChecked, undefined);
  assert.equal(h.requests[0].request.headers['X-WorkDaddy-Token'], 'fixture-token');
});
test('cancel or failed persona inspection never writes account authentication', async () => {
  const h = harness(() => Promise.reject(new Error('canceled')));
  await assert.rejects(h.ctx.api('/api/switch', { method: 'POST', body: '{"uid":"destination"}' }), /canceled/);
  assert.equal(h.requests.length, 0);
});
test('persona API and unrelated requests do not recurse through switch confirmation', async () => {
  const h = harness(() => { throw new Error('unexpected preflight'); });
  await h.ctx.api('/api/persona?uid=destination');
  await h.ctx.api('/api/persona-copy', { method: 'POST', body: '{}' });
  assert.equal(h.requests.length, 2);
});
