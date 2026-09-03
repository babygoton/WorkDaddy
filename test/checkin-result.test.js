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
  assert.equal(classifyCheckinResult({ httpOk: true, code: 10001, message: '请求成功' }).ok, false);
});

test('recognized token issuer selects its matching host', () => {
  const token = jwtWithIssuer('https://www.codebuddy.cn/auth/realms/copilot');
  assert.equal(tokenIssuerOrigin(token), 'https://www.codebuddy.cn');
  assert.deepEqual(checkinEndpointsForToken(token, { apiHost: 'https://www.workbuddy.ai', region: 'intl' }), [
    'https://www.codebuddy.cn/billing/meter/daily-checkin',
    'https://www.codebuddy.cn/v2/billing/meter/daily-checkin',
  ]);
});
