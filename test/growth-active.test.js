'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchGrowthTodayActive } = require('../scripts/growth-active.js');

function mockFetch(payload, { ok = true, status = 200 } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return async () => ({ ok, status, text: async () => text });
}

test('返回今日活跃 true 与今日字段', async () => {
  const today = { date: '2026-09-01', score: 106, is_active: true, status_text: '今日已活跃' };
  const r = await fetchGrowthTodayActive('tok', {
    fetchImpl: mockFetch({ code: 0, msg: 'OK', data: { today } }),
  });
  assert.deepEqual(r, { is_active: true, date: '2026-09-01', score: 106, status_text: '今日已活跃' });
});

test('is_active=false 返回 false，缺省字段归 null/空', async () => {
  const r = await fetchGrowthTodayActive('tok', {
    fetchImpl: mockFetch({ code: 0, data: { today: { date: '2026-09-01', is_active: false } } }),
  });
  assert.equal(r.is_active, false);
  assert.equal(r.score, null);
  assert.equal(r.status_text, '');
});

test('code 非 0 抛错', async () => {
  await assert.rejects(
    fetchGrowthTodayActive('tok', { fetchImpl: mockFetch({ code: 401, msg: '未授权' }) }),
    /未授权/
  );
});

test('HTTP 非 ok 抛错', async () => {
  await assert.rejects(
    fetchGrowthTodayActive('tok', { fetchImpl: mockFetch('{}', { ok: false, status: 500 }) }),
    /HTTP 500/
  );
});

test('无法解析的 JSON 抛错', async () => {
  await assert.rejects(
    fetchGrowthTodayActive('tok', { fetchImpl: mockFetch('not-json') }),
    /无法解析/
  );
});

test('缺 data.today 抛错', async () => {
  await assert.rejects(
    fetchGrowthTodayActive('tok', { fetchImpl: mockFetch({ code: 0, data: {} }) }),
    /缺少 data\.today/
  );
});

test('缺 accessToken 抛错', async () => {
  await assert.rejects(
    fetchGrowthTodayActive('', { fetchImpl: mockFetch({ code: 0 }) }),
    /参数不完整/
  );
});
