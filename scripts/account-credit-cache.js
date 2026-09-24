'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { replaceFileWithRetry } = require('./atomic-file-write');

// Public balance projection only; never persist an API response or auth data.
function projection(result) {
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    credits: number(result.credits),
    creditUnlimited: result.unlimited === true,
    creditSegments: (Array.isArray(result.segments) ? result.segments : []).filter(segment => segment && number(segment.remaining) !== null).map(segment => ({
      remaining: number(segment.remaining), total: number(segment.total), expiresAt: number(segment.expiresAt),
      source: typeof segment.source === 'string' ? segment.source : '',
      packageCode: typeof segment.packageCode === 'string' ? segment.packageCode : '',
    })),
  };
}
function nearestExpiry(account) {
  let nearest = Infinity;
  for (const segment of account.creditSegments || []) {
    if (segment.remaining > 0 && typeof segment.expiresAt === 'number' && Number.isFinite(segment.expiresAt)) nearest = Math.min(nearest, segment.expiresAt);
  }
  return nearest;
}
function createAccountCreditCache(dataDir) {
  const file = path.join(dataDir, 'account-credit-cache.json');
  const entries = new Map();
  try {
    for (const [uid, value] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || !value || typeof value !== 'object') continue;
      entries.set(uid, projection({ credits: value.credits, unlimited: value.creditUnlimited, segments: value.creditSegments }));
    }
  } catch (_) { /* A missing or corrupt optional cache is safe to discard. */ }
  function get(uid) { return entries.has(uid) ? structuredClone(entries.get(uid)) : {}; }
  function set(uid, result) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return;
    entries.set(uid, projection(result));
    fs.mkdirSync(dataDir, { recursive: true });
    replaceFileWithRetry(file, JSON.stringify(Object.fromEntries(entries)), 0o600);
  }
  function order(accounts) {
    // Capture all keys before the first request; refreshed balances cannot move
    // remaining accounts while this loop is running. Unknown expiry goes last.
    return accounts.map((account, index) => ({ account, index, expiry: nearestExpiry(get(account.uid)) }))
      .sort((a, b) => a.expiry === b.expiry ? a.index - b.index : a.expiry - b.expiry)
      .map(item => item.account);
  }
  return { get, set, order };
}
module.exports = { createAccountCreditCache };
