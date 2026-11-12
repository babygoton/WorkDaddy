'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const inject = require('../scripts/inject.js');
const { createCreditUsageStore } = require('../scripts/credit-usage-store.js');
const source = fs.readFileSync(require.resolve('../scripts/inject.js'), 'utf8');
const daemonSource = fs.readFileSync(require.resolve('../scripts/daemon.js'), 'utf8');

function modelLimitRouteHarness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-model-limit-route-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const logs = [];
  const context = {
    URL,
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    PROFILE: { id: 'workbuddy-cn' },
    CREDIT_USAGE_STORE: createCreditUsageStore({ dbPath: path.join(dataDir, 'credit-usage.db'), profileId: 'workbuddy-cn' }),
    isAllowedApiOrigin: () => true,
    isApiRequestAuthorized: () => true,
    readBody: request => Promise.resolve(request.body),
    json: (_, status, body) => ({ status, body }),
    listAccounts: () => [{ uid: 'synthetic-user' }],
    log: line => logs.push(line),
  };
  const start = daemonSource.indexOf('function handleApi(req, res)');
  const end = daemonSource.indexOf('\n\n// ===== 电脑休眠控制', start);
  assert.ok(start >= 0 && end > start, 'daemon API handler source missing');
  vm.createContext(context);
  vm.runInContext(daemonSource.slice(start, end), context);
  return {
    logs,
    dataDir,
    store: context.CREDIT_USAGE_STORE,
    request: body => context.handleApi({
      method: 'POST', url: '/api/model-rate-limit', headers: { host: '127.0.0.1' }, body,
    }, {}),
  };
}

function capError(overrides = {}) {
  return {
    code: '6004', requestModelId: 'deepseek-v4.1-flash',
    terminal: { bizCode: 6004, details: 'Reset at 2026-10-16 17:21:48 (UTC+8)' },
    ...overrides,
  };
}

test('official terminal cap details supply the reset time even with an empty outer code', () => {
  for (const code of [undefined, null, '', ' ', 0, 500, '6004']) {
    const result = inject.normalizeAutoContinueError(capError({ code, message: 'Request failed' }));
    assert.equal(result.code, 6004);
    assert.equal(result.rateLimited, true);
    assert.equal(result.resetAt, Date.parse('2026-10-16T17:21:48+08:00'));
    assert.equal('message' in result, false, 'never retain provider error text');
  }
});

test('cap reset wall clock uses UTC+8 on every client timezone', () => {
  const result = inject.normalizeAutoContinueError(capError({
    message: 'Reset at 2026-10-16T17:21:48', terminal: { bizCode: 6004 },
  }));
  assert.equal(result.resetAt, Date.parse('2026-10-16T17:21:48+08:00'));
});

test('model usage limit 6000 is distinct from frequency limit 6004', () => {
  const usage = inject.normalizeAutoContinueError({
    code: 500, requestModelId: 'deepseek-v4.1-flash', message: 'Request failed',
    terminal: { bizCode: 6000, details: '用量限制，请稍后再试' },
  });
  assert.equal(usage.code, 6000);
  assert.equal(usage.rateLimited, false);
  assert.equal(usage.usageLimited, true);
  assert.equal(usage.quotaExhausted, false);
  assert.equal(usage.nonRetryable, true);
  const frequency = inject.normalizeAutoContinueError(capError());
  assert.equal(frequency.rateLimited, true);
  assert.equal(frequency.quotaExhausted, false);
});

test('cap statistics subscribe without auto-continue, catch terminal warnings and clean up', () => {
  const listeners = new Set();
  let state = { model: 'deepseek-v4.1-flash' };
  let controllers = [{ conversationId: 'synthetic-conversation', sessionStore: {
    getState: () => state,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  } }];
  const records = [];
  let tick;
  let cleared = false;
  const observer = inject.createModelRateLimitObserver({
    discover: () => controllers,
    record: value => records.push(value),
    setInterval: fn => { tick = fn; return 123; },
    clearInterval: id => { assert.equal(id, 123); cleared = true; },
  });
  assert.equal(listeners.size, 1);
  // The normal reply has already finished. A short-lived terminal warning
  // follows a separate generic error and must be seen before the next scan.
  state = { ...state, error: { code: 'OTHER' }, warning: capError() };
  for (const fn of listeners) fn();
  state = { model: 'deepseek-v4.1-flash' };
  assert.equal(records.length, 1);
  assert.equal(records[0].errorCode, 6004);
  assert.equal(records[0].errorRequestModelId, 'deepseek-v4.1-flash');
  assert.equal(records[0].errorResetAt, Date.parse('2026-10-16T17:21:48+08:00'));
  assert.equal('message' in records[0], false);
  tick();
  assert.equal(records.length, 2, 'retry the sanitized cap after a transient error clears');
  controllers = [];
  tick();
  assert.equal(listeners.size, 0, 'unmounted controllers are unsubscribed');
  observer.destroy();
  assert.equal(cleared, true);
  tick();
  assert.equal(records.length, 2, 'disposed timers cannot report');
});

test('model usage limit observer records business code 6000 separately', () => {
  const listeners = new Set();
  const records = [];
  const state = { model: 'deepseek-v4.1-flash', error: {
    code: 6000, requestModelId: 'deepseek-v4.1-flash', message: '用量限制',
  } };
  const observer = inject.createModelRateLimitObserver({
    discover: () => [{ conversationId: 'usage-session', sessionStore: {
      getState: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    } }],
    record: value => records.push(value), setInterval: () => 1, clearInterval() {},
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].errorCode, 6000);
  assert.equal(records[0].limitType, 'usage');
  observer.destroy();
});

function reporterContext(api) {
  const start = source.indexOf('    function acRecordModelRateLimit(');
  const end = source.indexOf('\n    function acControllerSnapshot(', start);
  const context = { api, acRateLimitRecorded: Object.create(null), acCurrentUidPromise: null,
    window: { dispatchEvent() {} }, Event: function () {} };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return context;
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('failed cap writes and current-account lookups are retried; successful writes deduplicate', async () => {
  for (const failedRoute of ['/api/current', '/api/model-rate-limit']) {
    let fail = true;
    let attempts = 0;
    let posts = 0;
    const context = reporterContext(async route => {
      if (route === failedRoute) { attempts++; if (fail) throw Error('temporary local failure'); }
      if (route === '/api/current') return { uid: 'synthetic-user' };
      posts++;
      return { ok: true };
    });
    const snapshot = { conversationId: 'synthetic-conversation', assistantId: 'synthetic-assistant',
      rateLimited: true, errorCode: 6004, errorRequestModelId: 'deepseek-v4.1-flash', errorResetAt: 1792142508000 };
    context.acRecordModelRateLimit(snapshot);
    context.acRecordModelRateLimit(snapshot);
    await flush();
    assert.equal(attempts, 1, 'concurrent callbacks share the pending write');
    fail = false;
    context.acRecordModelRateLimit(snapshot);
    await flush();
    assert.equal(attempts, 2, failedRoute + ' retries after a failed attempt');
    assert.equal(posts, 1);
    context.acRecordModelRateLimit(snapshot);
    await flush();
    assert.equal(posts, 1, 'only a successful write becomes permanently deduplicated');
  }
});

test('model usage and frequency limit reports preserve their business codes', async () => {
  const posts = [];
  const context = reporterContext(async (route, options) => {
    if (route === '/api/current') return { uid: 'synthetic-user' };
    posts.push(JSON.parse(options.body));
    return { ok: true };
  });
  for (const errorCode of [6000, 6004]) {
    context.acRecordModelRateLimit({ conversationId: 'session-' + errorCode, assistantId: 'assistant-' + errorCode,
      errorCode, rateLimited: errorCode === 6004, limitType: errorCode === 6000 ? 'usage' : 'frequency', errorRequestModelId: 'model-test', errorResetAt: null });
  }
  await flush();
  assert.deepEqual(posts.map(post => post.reasonCode), [6000, 6004]);
});

test('daemon model-limit route stores 6000 and 6004 and warns on unsupported codes', async t => {
  const h = modelLimitRouteHarness(t);
  for (const [reasonCode, modelId] of [[6000, 'usage-model'], [6004, 'frequency-model']]) {
    const result = await h.request({ uid: 'synthetic-user', modelId, modelName: modelId, reasonCode, resetAt: null });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
  }
  const records = await h.store.listModelRateLimits(['synthetic-user']);
  assert.deepEqual(records['synthetic-user'].map(record => [record.modelId, record.reasonCode]), [
    ['frequency-model', 6004], ['usage-model', 6000],
  ]);
  const rejected = await h.request({ uid: 'synthetic-user', modelId: 'other-model', reasonCode: 6001, resetAt: null });
  assert.equal(rejected.status, 400);
  assert.ok(h.logs.some(line => line.includes('[model-rate-limit] WARN 拒绝上报: unsupported-reason-code')));
});

test('statistics never submit a generic HTTP 429 as a business cap 6004', async () => {
  let calls = 0;
  const context = reporterContext(async () => { calls++; return {}; });
  for (const errorCode of [null, 429, 14018, 6001]) {
    context.acRecordModelRateLimit({ rateLimited: true, errorCode });
  }
  await flush();
  assert.equal(calls, 0);
});

test('cap observer starts independently and is disposed on reinjection', () => {
  assert.ok(/createModelRateLimitObserver\(\{[\s\S]{0,600}record: acRecordModelRateLimit/.test(source));
  assert.ok(/registerDisposer\(function \(\) \{ modelRateLimitObserver\.destroy\(\); \}\)/.test(source));
});

test('account limit UI distinguishes usage limits from frequency limits', () => {
  assert.match(source, /Number\(record && record\.reasonCode\) === 6000[\s\S]{0,120}用量限制/);
  assert.match(source, /频率限制/);
  const start = source.indexOf('    function modelLimitKind(record) {');
  const end = source.indexOf('    function creditBlockHtml(', start);
  assert.ok(start >= 0 && end > start, 'model limit renderers missing');
  const context = {
    WBS_LANGUAGE: 'zh', state: { mask: false },
    wbsTranslateString: value => value,
    fmtDateTimeSeconds: () => '2026-11-03 12:00:00',
    fmtCreditExpiry: () => '10 分钟后',
    esc: value => String(value),
    accountDisplayName: account => account.nickname,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.account = { nickname: 'test account', modelRateLimits: [
    { modelId: 'usage-model', modelName: 'Usage Model', reasonCode: 6000, resetAt: 0 },
    { modelId: 'frequency-model', modelName: 'Frequency Model', reasonCode: 6004, resetAt: 1793707200000 },
  ] };
  const detail = vm.runInContext('modelRateLimitPopoverHtml(account)', context);
  const summary = vm.runInContext('modelRateLimitSummaryPopoverHtml([account])', context);
  for (const html of [detail, summary]) {
    assert.match(html, /用量限制/);
    assert.match(html, /频率限制/);
    assert.match(html, /预计恢复/);
    assert.match(html, /预计解封/);
  }
});

test('renderer cap cleanup calls the native timer API with a valid receiver', () => {
  const start = source.indexOf('    var modelRateLimitObserver = createModelRateLimitObserver({');
  const end = source.indexOf('\n    registerDisposer(', start);
  let options;
  let timerReceiver;
  const context = { CAPS: { accounts: false }, WBS_COMPAT: null,
    acRecordModelRateLimit() {}, setBuildInterval() {},
    createModelRateLimitObserver(value) { options = value; return {}; },
    clearInterval(id) { assert.equal(id, 123); timerReceiver = this; },
  };
  vm.runInNewContext(source.slice(start, end), context);
  options.clearInterval(123);
  assert.notEqual(timerReceiver, options, 'native clearInterval rejects the observer options as its receiver');
});
