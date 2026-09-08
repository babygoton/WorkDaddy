'use strict';

// 账号页排序契约：当前账号不再置顶，一律按积分到期时间升序（最近到期最前）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');

test('account list sorts by credit expiry without pinning the current account', () => {
  // sortAccountsByCreditExpiry：置顶条件必须移除，只保留到期时间 + 稳定序
  const start = inject.indexOf('function sortAccountsByCreditExpiry()');
  assert.ok(start >= 0, 'sortAccountsByCreditExpiry must exist');
  const body = inject.slice(start, inject.indexOf('function reorderAccountCards', start));
  assert.ok(body.indexOf('a.isCurrent ? -1 : 1') === -1,
    'current account must not be pinned to the top');
  assert.match(body, /a\.expiresAt - b\.expiresAt/, 'must sort by nearest credit expiry ascending');
  // render()：去置顶，按到期时间
  const renderStart = inject.indexOf('function render(data)');
  const renderBody = inject.slice(renderStart, inject.indexOf('state.creditRemaining', renderStart));
  assert.ok(renderBody.indexOf('leftIsCurrent ? -1 : 1') === -1, 'render must not pin current account');
  assert.match(renderBody, /if \(!previous\.length \|\| !state\.open\) sortAccountsByCreditExpiry\(\)/,
    'initial or hidden render sorts by expiry; visible cached rows retain their order');
});
