'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  fetchUsageSinceAnchor,
  formatLocalDateTime,
  normalizeUsageRow,
} = require('../scripts/credit-request-usage.js');

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); },
  };
}

function usageRow(id, requestTime, credit = 1) {
  return {
    requestId: id,
    requestTime,
    credit,
    model: 'claude-test',
    client: 'desktop',
    agentPurpose: 'chat',
    input: 'must never be persisted',
    inputTrunc: 'must never be persisted',
  };
}

test('normalizes only non-sensitive fields from official usage records', () => {
  const row = normalizeUsageRow(usageRow('req-1', '2026-08-28 09:10:11', '1.25'));
  assert.deepEqual(row, {
    requestId: 'req-1',
    requestTime: new Date(2026, 7, 28, 9, 10, 11).getTime(),
    usageDate: '2026-08-28',
    credit: 1.25,
    model: 'claude-test',
    client: 'desktop',
    agentPurpose: 'chat',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'input'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'inputTrunc'), false);
});

test('normalizes model aliases returned by billing API variants', () => {
  const byName = normalizeUsageRow({ ...usageRow('req-name', '2026-08-28 09:10:11'), model: '', modelName: 'claude-3-7-sonnet' });
  const byId = normalizeUsageRow({ ...usageRow('req-id', '2026-08-28 09:10:10'), model: '', model_id: 'deepseek-v3.1' });
  const nested = normalizeUsageRow({ ...usageRow('req-nested', '2026-08-28 09:10:09'), model: { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' } });
  assert.equal(byName.model, 'claude-3-7-sonnet');
  assert.equal(byId.model, 'deepseek-v3.1');
  assert.equal(nested.model, 'Gemini 2.5 Pro');
});

test('requests official pages newest-first and stops at the previous complete-sync anchor', async () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    usageRow(`new-${index}`, `2026-08-28 10:${String(59 - Math.floor(index / 2)).padStart(2, '0')}:${String(59 - (index % 2)).padStart(2, '0')}`)
  );
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, authorization: options.headers.authorization });
    if (body.pageNum === 1) {
      return jsonResponse({ code: 0, data: { total: 203, data: firstPage } });
    }
    if (body.pageNum === 2) {
      return jsonResponse({ code: 0, data: { total: 203, data: [
        usageRow('new-100', '2026-08-28 09:00:00', 2),
        usageRow('known-anchor', '2026-08-28 08:59:59', 3),
        usageRow('older-record', '2026-08-28 08:59:58', 4),
      ] } });
    }
    throw new Error('anchor should stop pagination before page 3');
  };

  const result = await fetchUsageSinceAnchor({
    accessToken: 'secret-token',
    apiHost: 'https://www.codebuddy.cn',
    startTime: new Date(2026, 7, 28, 0, 0, 0),
    endTime: new Date(2026, 7, 28, 12, 0, 0),
    anchorRequestId: 'known-anchor',
    fetchImpl,
  });

  assert.equal(result.reachedAnchor, true);
  assert.equal(result.newestRequestId, 'new-0');
  assert.equal(result.records.length, 101);
  assert.equal(result.records.some((row) => row.requestId === 'known-anchor'), false);
  assert.equal(result.records.some((row) => row.requestId === 'older-record'), false);
  assert.deepEqual(calls.map((call) => call.body.pageNum), [1, 2]);
  assert.equal(calls[0].body.pageSize, 100);
  assert.equal(calls[0].body.startTime, '2026-08-28 00:00:00');
  assert.equal(calls[0].body.endTime, '2026-08-28 12:00:00');
  assert.equal(calls[0].authorization, 'Bearer secret-token');
});

test('rejects an incomplete official result instead of caching a partial total', async () => {
  const fetchImpl = async (_url, options) => {
    const page = JSON.parse(options.body).pageNum;
    if (page === 1) {
      return jsonResponse({ code: 0, data: {
        total: 250,
        data: Array.from({ length: 100 }, (_, index) => usageRow(`req-${index}`, `2026-08-28 10:${String(59 - Math.floor(index / 2)).padStart(2, '0')}:${String(59 - (index % 2)).padStart(2, '0')}`)),
      } });
    }
    return jsonResponse({ code: 0, data: { total: 250, data: [] } });
  };

  await assert.rejects(
    fetchUsageSinceAnchor({
      accessToken: 'secret-token',
      apiHost: 'https://www.codebuddy.cn',
      startTime: new Date(2026, 7, 28, 0, 0, 0),
      endTime: new Date(2026, 7, 28, 12, 0, 0),
      fetchImpl,
    }),
    /incomplete|不完整/i
  );
});

test('formats official request timestamps in local time', () => {
  assert.equal(formatLocalDateTime(new Date(2026, 7, 28, 9, 5, 6)), '2026-08-28 09:05:06');
});

test('daemon syncs official usage only for the current account and reads cached usage for all accounts', () => {
  const daemon = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  assert.match(daemon, /listDailyUsage/);
  assert.match(daemon, /syncCurrentCreditUsage/);
  assert.match(daemon, /current.*\.uid === uid/);
  assert.match(daemon, /todayUsage/);
});
