'use strict';

const INACTIVE_MESSAGE = /未开启|未开始|未开放|已过期|无.*活动|活动.*(?:结束|关闭|暂停)/i;
const ALREADY_MESSAGE = /已签到|已领取|已经.*(?:签到|领取)|重复签到|already\s*(?:checked[- ]?in|claimed)|already/i;
const CHECKIN_PATHS = ['/billing/meter/daily-checkin', '/v2/billing/meter/daily-checkin'];
const ISSUER_HOST_MAP = new Map([
  ['https://www.workbuddy.ai', 'https://www.workbuddy.ai'],
  ['https://www.workbuddy.cn', 'https://www.workbuddy.cn'],
  ['https://www.codebuddy.cn', 'https://www.codebuddy.cn'],
]);

function numericCode(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Accept only an explicit successful response from the official check-in API.
 * A successful HTTP status alone is insufficient because gateways can return
 * an empty or non-JSON 200 response. Code 10001 is accepted only when its
 * message proves that today's check-in was already completed.
 */
function classifyCheckinResult({ httpOk, code, message }) {
  const normalizedCode = numericCode(code);
  const text = String(message || '');
  const inactive = INACTIVE_MESSAGE.test(text);
  const already = normalizedCode === 10001 && !inactive && ALREADY_MESSAGE.test(text);
  // The official service returns business code 10001 with HTTP 400 for an
  // already-completed daily check-in. Accept that state only when the message
  // explicitly proves completion; code=0 still requires an HTTP success.
  const ok = !inactive && ((normalizedCode === 0 && !!httpOk) || already);
  return { ok, already, inactive, code: normalizedCode, message: text };
}

function tokenIssuerOrigin(accessToken) {
  try {
    const part = String(accessToken || '').split('.')[1];
    if (!part) return null;
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return new URL(String(payload.iss || '')).origin;
  } catch (_) {
    return null;
  }
}

function checkinEndpointsForToken(accessToken, profile = {}) {
  const issuerOrigin = tokenIssuerOrigin(accessToken);
  const issuerHost = issuerOrigin ? ISSUER_HOST_MAP.get(issuerOrigin) : null;
  const hosts = [];
  if (issuerHost) {
    // A recognized issuer is authoritative. Do not send its bearer token to unrelated hosts.
    hosts.push(issuerHost);
  } else {
    const profileHost = String(profile.apiHost || 'https://www.workbuddy.cn').replace(/\/+$/, '');
    hosts.push(profileHost);
    if (profile.region === 'cn') {
      for (const host of ['https://www.codebuddy.cn', 'https://www.workbuddy.cn']) {
        if (!hosts.includes(host)) hosts.push(host);
      }
    }
  }
  return hosts.flatMap((host) => CHECKIN_PATHS.map((pathname) => host + pathname));
}

module.exports = {
  classifyCheckinResult,
  tokenIssuerOrigin,
  checkinEndpointsForToken,
  INACTIVE_MESSAGE,
  ALREADY_MESSAGE,
  ISSUER_HOST_MAP,
};
