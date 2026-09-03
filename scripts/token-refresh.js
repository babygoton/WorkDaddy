'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number < 1e11 ? number * 1000 : number);
}

function tokenValue(auth, camel, snake) {
  const camelValue = auth && auth[camel];
  const value = camelValue !== undefined && camelValue !== null && camelValue !== ''
    ? camelValue
    : auth && auth[snake];
  return String(value || '');
}

function shouldRefreshAccessToken(auth, now = Date.now(), thresholdMs = DAY_MS) {
  const expiresAt = normalizeTimestamp(auth && (auth.expiresAt ?? auth.expires_at));
  return expiresAt === null || expiresAt <= now || expiresAt - now < thresholdMs;
}

function responseMessage(payload, status) {
  if (payload && typeof payload === 'object') {
    const value = payload.message || payload.msg || payload.error;
    if (value) return String(value);
  }
  return status ? `HTTP ${status}` : '刷新请求失败';
}

/**
 * Exchange a stored refresh token for fresh credentials without mutating the input.
 * The upstream endpoint accepts the refresh token in X-Refresh-Token and returns
 * either camelCase or snake_case token fields.
 */
async function refreshAuthToken(auth, options = {}) {
  const original = auth && typeof auth === 'object' ? auth : {};
  const refreshToken = tokenValue(original, 'refreshToken', 'refresh_token');
  if (!refreshToken) return { ok: false, auth: original, error: '缺少 refresh token，无法刷新' };

  const apiHost = String(options.apiHost || '').replace(/\/$/, '');
  if (!apiHost) return { ok: false, auth: original, error: '缺少认证 API 地址，无法刷新' };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, auth: original, error: '当前运行时不支持 fetch' };

  const accessToken = tokenValue(original, 'accessToken', 'access_token');
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'X-Refresh-Token': refreshToken };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  let response;
  let payload;
  try {
    response = await fetchImpl(`${apiHost}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    try {
      payload = await response.json();
    } catch (_) {
      payload = {};
    }
  } catch (error) {
    return { ok: false, auth: original, error: error && error.message ? error.message : '刷新请求失败' };
  }

  const code = payload && typeof payload.code === 'number' ? payload.code : null;
  if (!response || response.ok !== true || (code !== null && code !== 0 && code !== 200)) {
    return { ok: false, auth: original, error: responseMessage(payload, response && response.status) };
  }
  const data = payload && payload.data && typeof payload.data === 'object' ? payload.data : {};
  const nextAccessToken = tokenValue(data, 'accessToken', 'access_token');
  if (!nextAccessToken) return { ok: false, auth: original, error: '刷新响应缺少 accessToken' };

  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const next = Object.assign({}, original, {
    accessToken: nextAccessToken,
    refreshToken: tokenValue(data, 'refreshToken', 'refresh_token') || refreshToken,
    lastRefreshTime: now,
  });
  const expiresAt = normalizeTimestamp(data.expiresAt ?? data.expires_at) ||
    (Number(data.expiresIn ?? data.expires_in) > 0 ? now + Number(data.expiresIn ?? data.expires_in) * 1000 : normalizeTimestamp(original.expiresAt ?? original.expires_at));
  const refreshExpiresAt = normalizeTimestamp(data.refreshExpiresAt ?? data.refresh_expires_at) ||
    (Number(data.refreshExpiresIn ?? data.refresh_expires_in) > 0 ? now + Number(data.refreshExpiresIn ?? data.refresh_expires_in) * 1000 : normalizeTimestamp(original.refreshExpiresAt ?? original.refresh_expires_at));
  if (expiresAt !== null) {
    next.expiresAt = expiresAt;
    next.expiresIn = Math.max(0, Math.round((expiresAt - now) / 1000));
  }
  if (refreshExpiresAt !== null) {
    next.refreshExpiresAt = refreshExpiresAt;
    next.refreshExpiresIn = Math.max(0, Math.round((refreshExpiresAt - now) / 1000));
  }
  for (const key of ['tokenType', 'domain', 'scope', 'sessionState', 'idToken']) {
    if (data[key] !== undefined) next[key] = data[key];
  }
  return { ok: true, auth: next };
}

module.exports = { DAY_MS, normalizeTimestamp, shouldRefreshAccessToken, refreshAuthToken };
