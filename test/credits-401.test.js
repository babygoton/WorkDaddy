'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
const inject = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'inject.js'), 'utf8');

test('credit 401 responses are classified as login-expired instead of a generic HTTP/parse error', () => {
  // 个人版积分接口：401 必须先于 JSON.parse 归类（网关常直接返回 HTML 登录页）
  assert.match(daemon, /if \(r\.status === 401\) \{[\s\S]*?登录身份过期/);
  // 企业版接口同样归类
  assert.match(daemon, /企业积分接口 HTTP/);
  // /api/credits 对过期凭证返回结构化 401，前端可据此渲染可诊断文案
  assert.match(daemon, /json\(res, 401, \{ ok: false, expired: true, error: '登录身份过期' \}\)/);
  // 两个 robust 重试函数遇到 expired 立即终止，不空耗 3 次重试
  const expiredGuard = (daemon.match(/if \(e && e\.expired\) throw e;/g) || []).length;
  assert.ok(expiredGuard >= 2, `expected >=2 expired guards, got ${expiredGuard}`);
});

test('inject renders a visible login-expired label instead of hiding the credit cell', () => {
  // 过期账号积分格展示「登录身份过期」文案，而不是整格隐藏/空白
  assert.match(inject, /登录身份过期<\/span>/);
  // fetchCreditsForAccounts 识别 daemon 的 {expired:true} 并标记 creditExpired
  assert.match(inject, /e\.payload\.expired/);
  assert.match(inject, /account\.creditExpired/);
  // 不再对过期积分格整格隐藏（display:none 会让可诊断文案不可见）
  assert.doesNotMatch(inject, /wbs-credit-hidden' \+ \(isIdentityExpired/);
});