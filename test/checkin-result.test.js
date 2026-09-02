'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyCheckinResult, tokenIssuerOrigin, checkinEndpointsForToken } = require('../scripts/checkin-result.js');

function jwtWithIssuer(issuer) {
  const payload = Buffer.from(JSON.stringify({ iss: issuer }), 'utf8').toString('base64url');
  return `header.${payload}.signature`;
}

test('check-in requires an explicit successful response code', () => {
  assert.equal(classifyCheckinResult({ httpOk: true, code: undefined, message: 'OK' }).ok, false);
  assert.equal(classifyCheckinResult({ httpOk: true, code: 0, message: 'OK' }).ok, true);
  assert.equal(classifyCheckinResult({ httpOk: false, code: 0, message: 'OK' }).ok, false);
});

test('code 10001 is cached only when it explicitly means already checked in', () => {
  assert.equal(classifyCheckinResult({ httpOk: true, code: 10001, message: '今日已签到' }).ok, true);
  assert.equal(classifyCheckinResult({ httpOk: false, code: 10001, message: '今天已签到，请明天再来' }).ok, true);
  assert.equal(classifyCheckinResult({ httpOk: true, code: 10001, message: '活动未开启' }).ok, false);
  assert.equal(classifyCheckinResult({ httpOk: false, code: 10001, message: '签到活动未开启或已过期' }).ok, false);
  assert.equal(classifyCheckinResult({ httpOk: true, code: 10001, message: '请求成功' }).ok, false);
});

test('known JWT issuer selects its matching check-in host instead of the profile host', () => {
  const token = jwtWithIssuer('https://www.codebuddy.cn/auth/realms/copilot');
  assert.equal(tokenIssuerOrigin(token), 'https://www.codebuddy.cn');
  assert.deepEqual(checkinEndpointsForToken(token, {
    apiHost: 'https://www.workbuddy.ai',
    region: 'intl',
  }), [
    'https://www.codebuddy.cn/billing/meter/daily-checkin',
    'https://www.codebuddy.cn/v2/billing/meter/daily-checkin',
  ]);
});

test('unknown JWT issuer never becomes a request host and falls back to profile routing', () => {
  const token = jwtWithIssuer('https://untrusted.example/auth/realms/copilot');
  assert.deepEqual(checkinEndpointsForToken(token, {
    apiHost: 'https://www.workbuddy.ai',
    region: 'intl',
  }), [
    'https://www.workbuddy.ai/billing/meter/daily-checkin',
    'https://www.workbuddy.ai/v2/billing/meter/daily-checkin',
  ]);
});
