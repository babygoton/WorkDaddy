'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const inject = require('../scripts/inject.js');
const source = fs.readFileSync(require.resolve('../scripts/inject.js'), 'utf8');

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

test('statistics never submit a generic HTTP 429 as a business cap 6004', async () => {
  let calls = 0;
  const context = reporterContext(async () => { calls++; return {}; });
  for (const errorCode of [null, 429, 14018]) {
    context.acRecordModelRateLimit({ rateLimited: true, errorCode });
  }
  await flush();
  assert.equal(calls, 0);
});

test('cap observer starts independently and is disposed on reinjection', () => {
  assert.ok(/createModelRateLimitObserver\(\{[\s\S]{0,600}record: acRecordModelRateLimit/.test(source));
  assert.ok(/registerDisposer\(function \(\) \{ modelRateLimitObserver\.destroy\(\); \}\)/.test(source));
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
