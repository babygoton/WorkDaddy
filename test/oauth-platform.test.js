'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PROFILES } = require('../scripts/profiles');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const route = source.slice(source.indexOf("  if (req.method === 'POST' && p === '/api/oauth/start')"), source.indexOf('  // 「无感登录」第二步'));

async function start(profile, returnedUrl) {
  let request;
  const context = {
    PROFILE: profile, WB_API_ENDPOINT: profile.apiHost, WB_API_PREFIX: '/v2/plugin',
    req: { method: 'POST' }, p: '/api/oauth/start', res: {},
    httpJson: async (url, method, body) => { request = { url, method, body }; return { data: { state: 'fixture+state', ...(returnedUrl ? { authUrl: returnedUrl } : {}) } }; },
    crypto: { randomUUID: () => 'fixture-login' }, oauthStates: new Map(),
    OAUTH_TIMEOUT_SECONDS: 600, OAUTH_RESULT_RETENTION_SECONDS: 300,
    setTimeout: () => ({ unref() {} }), log() {},
    json: (_res, status, data) => ({ status, ...data }),
  };
  const result = await vm.runInNewContext('(async()=>{' + route + '})()', context);
  return { result, request, context };
}
for (const [profile, platform] of [['workbuddy-ai', 'workbuddy-ai'], ['workbuddy-cn', 'workbuddy']]) {
  test(`${profile} requests OAuth state for its own app and preserves official authorization URL`, async () => {
    const official = PROFILES[profile].apiHost + '/login/started?platform=' + platform + '&state=fixture';
    const { request, result, context } = await start(PROFILES[profile], official);
    const url = new URL(request.url);
    assert.equal(url.origin, PROFILES[profile].apiHost);
    assert.equal(url.searchParams.get('platform'), platform);
    assert.equal(request.method, 'POST');
    assert.equal(result.status, 200);
    assert.equal(result.verificationUri, official);
    assert.equal(context.oauthStates.get(result.loginId).state, 'fixture+state');
  });
  test(`${profile} fallback authorization URL preserves platform and encodes state`, async () => {
    const { result } = await start(PROFILES[profile]);
    const url = new URL(result.verificationUri);
    assert.equal(url.origin, PROFILES[profile].apiHost);
    assert.equal(url.pathname, '/login/started');
    assert.equal(url.searchParams.get('platform'), platform);
    assert.equal(url.searchParams.get('state'), 'fixture+state');
  });
}
