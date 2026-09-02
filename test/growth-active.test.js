'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchGrowthTodayActive, activateGrowthAccount } = require('../scripts/growth-active.js');

function mockFetch(payload, { ok = true, status = 200 } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return async () => ({ ok, status, text: async () => text });
}

function jsonResponse(payload, { ok = true, status = 200, headers = {} } = {}) {
  const responseHeaders = Object.assign({ 'content-type': 'application/json' }, headers);
  return {
    ok,
    status,
    headers: { get: (name) => responseHeaders[String(name).toLowerCase()] || null },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
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

test('独立会话活跃流程不依赖当前 renderer，按 create/session/ACP 顺序发送', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method || 'GET',
      body: init.body || null,
      authorization: init.headers && init.headers.authorization,
      requestHeader: init.headers && init.headers['x-codebuddy-request'],
    });
    if (url.endsWith('/console/as/conversations/')) {
      return jsonResponse({ code: 0, data: { id: 'conv-test' } });
    }
    if (url.endsWith('/console/as/conversations/conv-test/session')) {
      return jsonResponse({ code: 0, data: { sessionId: 'session-test', link: 'https://acp.test/api/v1/acp', token: 'runtime-token' } });
    }
    if (url === 'https://acp.test/api/v1/acp' && (init.method || 'GET') === 'GET') {
      return jsonResponse({}, { headers: { 'acp-connection-id': 'connection-test' } });
    }
    if (url === 'https://acp.test/api/v1/acp' && init.method === 'POST') {
      const request = JSON.parse(init.body);
      const result = request.method === 'initialize' ? { protocolVersion: 1 } : { stopReason: 'end_turn' };
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result });
    }
    if (url === 'https://acp.test/api/v1/acp' && init.method === 'DELETE') return jsonResponse({});
    throw new Error(`unexpected URL: ${url}`);
  };
  const result = await activateGrowthAccount('account-token', { apiHost: 'https://api.test', fetchImpl, timeoutMs: 1000 });
  assert.deepEqual(result, { conversationId: 'conv-test', sessionId: 'session-test', stopReason: 'end_turn' });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'POST https://api.test/console/as/conversations/',
    'GET https://api.test/console/as/conversations/conv-test/session',
    'GET https://acp.test/api/v1/acp',
    'POST https://acp.test/api/v1/acp',
    'POST https://acp.test/api/v1/acp',
    'DELETE https://acp.test/api/v1/acp',
  ]);
  assert.equal(calls[0].authorization, 'Bearer account-token');
  assert.equal(calls[2].authorization, 'Bearer runtime-token');
  assert.equal(calls[2].requestHeader, '1');
  assert.equal(calls[3].requestHeader, '1');
  assert.deepEqual(JSON.parse(calls[3].body).params.clientInfo, {
    name: 'workdaddy-growth',
    version: '1.1.31',
  });
  assert.deepEqual(JSON.parse(calls[4].body).params, {
    sessionId: 'session-test',
    prompt: [{ type: 'text', text: '你好' }],
  });
});

test('独立会话结束时会中止长连接 SSE，不会卡在清理阶段', async () => {
  let sseAborted = false;
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/console/as/conversations/')) return jsonResponse({ data: { id: 'conv-test' } });
    if (url.endsWith('/console/as/conversations/conv-test/session')) {
      return jsonResponse({ data: { sessionId: 'session-test', link: 'https://acp.test', token: 'runtime-token' } });
    }
    if (url === 'https://acp.test/api/v1/acp' && (init.method || 'GET') === 'GET') {
      return {
        ...jsonResponse({}, { headers: { 'acp-connection-id': 'connection-test' } }),
        body: {
          getReader: () => ({
            read: () => new Promise((resolve) => init.signal.addEventListener('abort', () => {
              sseAborted = true;
              resolve({ done: true });
            }, { once: true })),
            releaseLock: () => {},
          }),
        },
      };
    }
    if (url === 'https://acp.test/api/v1/acp' && init.method === 'POST') {
      const request = JSON.parse(init.body);
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result: {} });
    }
    if (url === 'https://acp.test/api/v1/acp' && init.method === 'DELETE') return jsonResponse({});
    throw new Error(`unexpected URL: ${url}`);
  };
  await activateGrowthAccount('account-token', { apiHost: 'https://api.test', fetchImpl, timeoutMs: 1000 });
  assert.equal(sseAborted, true);
});
