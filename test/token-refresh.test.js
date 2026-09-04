'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { refreshAuthToken, shouldRefreshAccessToken } = require('../scripts/token-refresh.js');

test('refreshAuthToken exchanges the refresh token and preserves rotated credentials', async () => {
  const calls = [];
  const now = 1_700_000_000_000;
  const result = await refreshAuthToken({
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: now - 1000,
    refreshExpiresAt: now + 30 * 86400000,
    scope: 'openid offline_access',
  }, {
    apiHost: 'https://api.example.test',
    now,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            accessToken: 'new-access',
            refreshToken: 'new-refresh',
            expiresIn: 3600,
            refreshExpiresIn: 86400,
          },
        }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.auth.accessToken, 'new-access');
  assert.equal(result.auth.refreshToken, 'new-refresh');
  assert.equal(result.auth.expiresAt, now + 3600 * 1000);
  assert.equal(result.auth.refreshExpiresAt, now + 86400 * 1000);
  assert.equal(result.auth.lastRefreshTime, now);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.test/v2/plugin/auth/token/refresh');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer old-access');
  assert.equal(calls[0].init.headers['X-Refresh-Token'], 'old-refresh');
});

test('refreshAuthToken leaves the old auth untouched when the server rejects the refresh', async () => {
  const auth = { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 123 };
  const result = await refreshAuthToken(auth, {
    apiHost: 'https://api.example.test',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 12153, message: 'invalid_grant' }),
    }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.auth, auth);
  assert.match(result.error, /invalid_grant/);
});

test('shouldRefreshAccessToken treats expired and near-expiry access tokens as stale', () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldRefreshAccessToken({ expiresAt: now - 1 }, now), true);
  assert.equal(shouldRefreshAccessToken({ expiresAt: now + 30 * 60 * 1000 }, now), true);
  assert.equal(shouldRefreshAccessToken({ expiresAt: now + 2 * 86400000 }, now), false);
  assert.equal(shouldRefreshAccessToken({}), true);
});

test('refreshAuthToken falls back to snake_case fields when camelCase fields are empty', async () => {
  const result = await refreshAuthToken({ refreshToken: 'old-refresh' }, {
    apiHost: 'https://api.example.test',
    now: 1_700_000_000_000,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { accessToken: '', access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 60 } }),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.auth.accessToken, 'new-access');
  assert.equal(result.auth.refreshToken, 'new-refresh');
});
