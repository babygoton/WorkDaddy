'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const inject = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
const apiSource = inject.slice(inject.indexOf('  function api(path, opts) {'), inject.indexOf('  // 调试：递归收集所有元素'));

test('sharing is configured inside account settings without a per-switch prompt', () => {
  assert.doesNotMatch(inject, /openPersonaDialog|personaSwitchPreflight|wbs-persona-modal/);
  assert.match(inject, /data-persona-settings/);
  assert.match(inject, /data-act="persona-dismiss"/);
  assert.match(inject, /refreshPersonaNotice\(\);/);
});
test('switch goes straight to the authenticated API; persona sync belongs to the daemon', async () => {
  const requests = [];
  const ctx = vm.createContext({ CAPS: {}, API: 'http://127.0.0.1', WBS_API_TOKEN: 'fixture-token',
    fetch: async (url, request) => { requests.push({url,request}); return {ok:true,json:async()=>({ok:true})}; },
  });
  vm.runInContext(apiSource,ctx);
  await ctx.api('/api/switch',{method:'POST',body:'{"uid":"b"}'});
  assert.equal(requests.length,1);
  assert.equal(requests[0].request.headers['X-WorkDaddy-Token'],'fixture-token');
});
