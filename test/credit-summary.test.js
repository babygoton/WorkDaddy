'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/inject.js'), 'utf8');
const ctx = { isIdentityExpired: a => !!a.expired };
vm.runInNewContext(source.slice(source.indexOf('  function summarizeCreditDays('), source.indexOf('  function checkinHtml(')), ctx);
test('summary counts credit segments once, grouping exact remaining days across accounts', () => {
  const now = 100000, day = 86400000;
  const result = ctx.summarizeCreditDays([
    { credits: 100, creditSegments: [{ remaining: 30, expiresAt: now + day }, { remaining: 70, expiresAt: now + 7 * day }] },
    { credits: 55, creditSegments: [{ remaining: 20, expiresAt: now + day }, { remaining: 5, expiresAt: null }] },
    { credits: null }, { credits: 100, creditUnlimited: true }, { credits: 30, expired: true },
  ], now);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { rows: [{ days: 1, credits: 50 }, { days: 7, credits: 70 }], accountCount: 5, unavailable: 2, unlimited: 1 });
});
test('zero, expired, malformed and stale oversized segments cannot inflate the total', () => {
  const result = ctx.summarizeCreditDays([{ credits: 12, creditSegments: [null, { remaining: 'bad' }, { remaining: -5 }, { remaining: 5, expiresAt: 1 }, { remaining: 100, expiresAt: 86400001 }] }], 2);
  assert.deepEqual(JSON.parse(JSON.stringify(result.rows)), [{ days: 0, credits: 5 }, { days: 1, credits: 7 }]);
  assert.equal(ctx.summarizeCreditDays([], 1).rows.length, 0);
});
