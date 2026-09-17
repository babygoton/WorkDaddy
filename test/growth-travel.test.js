'use strict';
/* ===== 派猫猫旅行（account.travel）回归测试 =====
 *
 * 覆盖三层：
 *   1. scripts/growth-travel.js 的纯逻辑（状态机、失败分类、跨日缓存、记录合并）；
 *   2. HTTP 原语（响应解析、地点轮询、鉴权头），用假 fetch 驱动；
 *   3. 协议接线（op 目录/静态校验/执行透传、内置任务、能力开关、daemon 路由）。
 *
 * 机制出处：WorkBuddy 成长中心的 /activity/growth/buddy/travel/{config,status,depart,claim}，
 * 随账号自己签发的域名走（JWT iss）。真机只读实测见 docs/automation-buddy-travel.md。
 * 设计对照了参考项目 changexbc/workbuddy-switch 的 travel.rs，并保留它踩过的坑：
 *   - no-buddy 等可重试跳过不能把当天标成完成，否则账号有猫猫后也永不重试；
 *   - HTTP 429 是限流，不等于「今日已派」；
 *   - 缺 state / 未知 state 不能被当成 idle，否则会误判成可派发或已领取。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  TRAVEL_API_PREFIX,
  parseTravelState,
  decideTravelAction,
  classifyDepartError,
  isRetryableTravelSkip,
  arriveAtSeconds,
  travelRecordInFlight,
  inFlightDue,
  travelDueForRetry,
  rollTravelCacheToToday,
  mergeTravelRecord,
  travelCacheCompleted,
  truncateTravelMessage,
  planTravelStep,
  summarizeTravelRecord,
  fetchTravelConfig,
  fetchTravelStatus,
  claimTravel,
  departTravelWithLocations,
} = require('../scripts/growth-travel.js');
const { validateTask, executeTask, CAPABILITIES, SUPPORTED_OPS } = require('../scripts/automation.js');
const { analyzeTask } = require('../scripts/automation-packages.js');
const profiles = require('../scripts/profiles.js');

const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
const builtinPath = path.join(__dirname, '..', 'scripts', 'builtin', 'automations', 'daily-buddy-travel.json');
const builtin = JSON.parse(fs.readFileSync(builtinPath, 'utf8'));

/* ———— 1. 状态机 ———— */
test('travel state parsing is case-insensitive and never guesses on unknown values', () => {
  assert.equal(parseTravelState('idle'), 'idle');
  assert.equal(parseTravelState('  TRAVELING '), 'traveling');
  assert.equal(parseTravelState('Arrived'), 'arrived');
  assert.equal(parseTravelState('unknown'), null);
  assert.equal(parseTravelState(''), null);
  assert.equal(parseTravelState(null), null);
});

test('travel action follows the official state plus daily limit', () => {
  assert.equal(decideTravelAction('arrived', false), 'claim');
  assert.equal(decideTravelAction('traveling', true), 'wait');
  assert.equal(decideTravelAction('idle', true), 'skip-daily-limit');
  assert.equal(decideTravelAction('idle', false), 'depart');
  assert.equal(decideTravelAction('missing', false), 'status-error');
});

test('depart error classification keeps rate limiting out of the daily limit bucket', () => {
  assert.equal(classifyDepartError(400, 'Already traveling'), 'already-traveling');
  assert.equal(classifyDepartError(400, 'daily limit reached'), 'daily-limit');
  assert.equal(classifyDepartError(400, 'no active buddy'), 'no-buddy');
  assert.equal(classifyDepartError(400, 'location not available'), 'location-unavailable');
  // 429 只是限流：当成「今日已派」会让这一天永远不再重试。
  assert.equal(classifyDepartError(429, 'Too Many Requests'), 'other');
  assert.equal(classifyDepartError(500, 'internal error'), 'other');
});

test('retryable skips keep the day incomplete so the next cycle still tries', () => {
  for (const skip of ['no-buddy', 'error', 'config-error', 'no-location', 'location-unavailable', 'status-error', 'claim-error', 'retry-wait']) {
    assert.equal(isRetryableTravelSkip(skip), true, skip);
  }
  assert.equal(isRetryableTravelSkip('daily-limit'), false);
  assert.equal(isRetryableTravelSkip(null), false);
});

test('arrival timestamps accept seconds or milliseconds', () => {
  assert.equal(arriveAtSeconds(1789624926), 1789624926);
  assert.equal(arriveAtSeconds(1789624926000), 1789624926);
  assert.equal(arriveAtSeconds(0), 0);
  assert.equal(arriveAtSeconds(null), 0);
});

test('in-flight detection drives whether the arrival is due', () => {
  const traveling = { ok: true, claimed: false, arriveAt: 1000 };
  assert.equal(travelRecordInFlight(traveling), true);
  assert.equal(inFlightDue(traveling, 2000 * 1000), true);
  assert.equal(inFlightDue(traveling, 500 * 1000), false);
  assert.equal(inFlightDue({ ok: true, claimed: true, arriveAt: 1000 }, 2000 * 1000), false);
  assert.equal(inFlightDue({ ok: false, arriveAt: 0 }, 2000 * 1000), false);
  // 缓存缺到达时间时也要去问一次官方状态，不能干等。
  assert.equal(inFlightDue({ ok: true, claimed: false }, Date.now()), true);
});

test('departure retry is throttled to the reference cadence', () => {
  const now = 1000 * 1000;
  const retryMs = 30 * 60 * 1000;
  assert.equal(travelDueForRetry({}, now, retryMs), true);
  assert.equal(travelDueForRetry({ departAttemptAt: now - 10 * 60 * 1000 }, now, retryMs), false);
  assert.equal(travelDueForRetry({ departAttemptAt: now - 31 * 60 * 1000 }, now, retryMs), true);
});

/* ———— 2. 跨日缓存与记录合并 ———— */
test('rolling the cache to a new day drops finished records but keeps in-flight trips', () => {
  const cache = {
    date: '2026-09-16',
    completed: true,
    results: {
      done: { date: '2026-09-16', ok: true, claimed: true, state: 'idle', rewardCredit: 8 },
      flying: { date: '2026-09-16', ok: true, claimed: false, state: 'traveling', arriveAt: 1789624926 },
    },
  };
  const same = rollTravelCacheToToday(cache, '2026-09-16');
  assert.deepEqual(Object.keys(same.results).sort(), ['done', 'flying']);

  const next = rollTravelCacheToToday(cache, '2026-09-17');
  assert.equal(next.date, '2026-09-17');
  assert.equal(next.completed, false);
  assert.deepEqual(Object.keys(next.results), ['flying']);
});

test('a new trip never inherits the previous trip completion or reward', () => {
  const prior = { ok: true, claimed: true, state: 'idle', rewardCredit: 8, claimedAt: 111, location: '咖啡馆' };
  // daemon 侧写入的永远是完整形状（rewardCredit/claimedAt 显式为 null/0），测试照此构造。
  const next = { ok: true, claimed: false, state: 'traveling', arriveAt: 222, location: '', rewardCredit: null, claimedAt: 0 };
  const merged = mergeTravelRecord(prior, next);
  assert.equal(merged.claimed, false);
  assert.equal(merged.rewardCredit, null, '上一趟领到的积分不能被当成新行程的预计奖励');
  assert.equal(merged.claimedAt, 0);
  assert.equal(merged.location, '咖啡馆', '官方状态暂时没给地点时沿用已知地点');
  assert.equal(merged.arriveAt, 222);
});

test('claim merging keeps the prior reward when the new record lacks one', () => {
  const prior = { ok: true, claimed: true, state: 'idle', rewardCredit: 8, claimedAt: 111, location: '咖啡馆' };
  const merged = mergeTravelRecord(prior, { ok: true, claimed: true, state: 'idle', rewardCredit: null, location: '' });
  assert.equal(merged.claimed, true);
  assert.equal(merged.rewardCredit, 8);
  assert.equal(merged.claimedAt, 111);
  assert.equal(merged.location, '咖啡馆');
});

test('a claimed record without credit stays claimed and an unclaimed prior is a no-op', () => {
  const claimed = mergeTravelRecord({ ok: true, claimed: true, rewardCredit: null, claimedAt: 5 }, { ok: true, claimed: true, rewardCredit: null });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.claimedAt, 5);

  const next = { ok: false, skip: 'no-buddy', message: '无 Buddy' };
  assert.deepEqual(mergeTravelRecord({ ok: false }, next), next);
});

test('a fresh credit overrides a null prior credit', () => {
  const merged = mergeTravelRecord({ ok: true, claimed: true, rewardCredit: null }, { ok: true, claimed: true, rewardCredit: 6 });
  assert.equal(merged.rewardCredit, 6);
});

test('cache completion only ignores non-retryable outcomes', () => {
  assert.equal(travelCacheCompleted({ a: { skip: null, claimed: true } }), true);
  assert.equal(travelCacheCompleted({ a: { skip: 'daily-limit', claimed: true, state: 'idle' } }), true);
  assert.equal(travelCacheCompleted({ a: { skip: 'no-buddy' } }), false);
  assert.equal(travelCacheCompleted({ a: { skip: 'retry-wait' } }), false);
});

test('an in-flight trip is never reported as a finished day', () => {
  // 行程在飞：到达后还要领取，不能提前算完成（否则会漏领奖励）。
  assert.equal(travelCacheCompleted({ a: { skip: null, claimed: false, state: 'traveling' } }), false);
  // 已到达但还没领到（claim 返回 not arrived yet）同样不算完成。
  assert.equal(travelCacheCompleted({ a: { skip: null, claimed: false, state: 'arrived' } }), false);
  // 一个账号完成、另一个在飞 → 整体未完成。
  assert.equal(travelCacheCompleted({
    a: { skip: null, claimed: true, state: 'idle' },
    b: { skip: null, claimed: false, state: 'traveling' },
  }), false);
  // 空缓存不算完成。
  assert.equal(travelCacheCompleted({}), false);
});

/* ———— 3. 单轮决策 ———— */
test('auto mode claims when arrived, waits while traveling and departs when idle', () => {
  const now = 1_789_620_000_000;
  assert.equal(planTravelStep({ mode: 'auto', status: { ok: true, state: 'arrived', recordId: 7 }, prior: {}, now }).action, 'claim');
  assert.equal(planTravelStep({ mode: 'auto', status: { ok: true, state: 'traveling' }, prior: {}, now }).action, 'wait');
  assert.equal(planTravelStep({ mode: 'auto', status: { ok: true, state: 'idle', dailyLimitReached: false }, prior: {}, now }).action, 'depart');
  assert.equal(planTravelStep({ mode: 'auto', status: { ok: true, state: 'idle', dailyLimitReached: true }, prior: {}, now }).action, 'skip');
});

test('a status failure or an unknown state never degrades into a departure', () => {
  const failed = planTravelStep({ mode: 'auto', status: { ok: false, message: '旅行接口请求超时' }, prior: {}, now: Date.now() });
  assert.equal(failed.action, 'error');
  assert.equal(failed.skip, 'status-error');
  const unknown = planTravelStep({ mode: 'auto', status: { ok: true, state: 'sleeping' }, prior: {}, now: Date.now() });
  assert.equal(unknown.action, 'error');
});

test('departure retries are throttled inside auto mode', () => {
  const now = 1_789_620_000_000;
  const prior = { departAttemptAt: now - 5 * 60 * 1000 };
  const plan = planTravelStep({ mode: 'auto', status: { ok: true, state: 'idle' }, prior, now, retryMs: 30 * 60 * 1000 });
  assert.equal(plan.action, 'wait');
  assert.equal(plan.skip, 'retry-wait');
  const later = planTravelStep({ mode: 'auto', status: { ok: true, state: 'idle' }, prior, now: now + 31 * 60 * 1000, retryMs: 30 * 60 * 1000 });
  assert.equal(later.action, 'depart');
});

test('explicit depart mode still refuses when the daily trip is used up', () => {
  const plan = planTravelStep({ mode: 'depart', status: { ok: true, state: 'idle', dailyLimitReached: true }, prior: {}, now: Date.now() });
  assert.equal(plan.action, 'skip');
  assert.equal(plan.skip, 'daily-limit');
});

test('claim mode leaves a fresh account alone but still retries a known trip', () => {
  const now = Date.now();
  const fresh = planTravelStep({ mode: 'claim', status: { ok: true, state: 'idle' }, prior: {}, now });
  assert.equal(fresh.action, 'wait');
  const known = planTravelStep({ mode: 'claim', status: { ok: true, state: 'idle' }, prior: { ok: true, state: 'arrived' }, now });
  assert.equal(known.action, 'claim');
  const done = planTravelStep({ mode: 'claim', status: { ok: true, state: 'idle', dailyLimitReached: true }, prior: { claimed: true }, now });
  assert.equal(done.action, 'skip');
});

test('travel summaries stay short and human readable', () => {
  assert.equal(summarizeTravelRecord({ skipped: true, message: '无 Buddy' }), '已跳过(无 Buddy)');
  assert.equal(summarizeTravelRecord({ claimed: true, rewardCredit: 8, location: '咖啡馆' }), '已领取 +8 @咖啡馆');
  assert.equal(summarizeTravelRecord({ state: 'traveling', location: '健身房' }), '旅行中 @健身房');
  assert.equal(summarizeTravelRecord({ state: 'idle' }), '未出发');
  assert.equal(summarizeTravelRecord(null), '未查询');
});

test('long upstream messages are truncated before they reach the cache', () => {
  assert.equal(truncateTravelMessage('x'.repeat(200)).length, 80);
});

/* ———— 4. HTTP 原语（假 fetch） ———— */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body = {} } = handler(url, init) || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return { impl, calls };
}

test('travel status maps the official payload and rejects a missing state', async () => {
  const { impl, calls } = fakeFetch(() => ({
    body: {
      code: 0,
      data: {
        state: 'traveling', buddy_id: 6151615, record_id: 6106861,
        location: { id: 1, code: 'coffee', name: '咖啡馆' },
        depart_at: 1789617726, arrive_at: 1789624926, server_now: 1789618058,
        daily_limit_reached: true, duration_hours: 2, reward_credit: 8,
      },
    },
  }));
  const status = await fetchTravelStatus({ accessToken: 't', apiHost: 'https://www.workbuddy.cn', fetchImpl: impl });
  assert.equal(status.ok, true);
  assert.equal(status.state, 'traveling');
  assert.equal(status.location, '咖啡馆');
  assert.equal(status.recordId, 6106861);
  assert.equal(status.dailyLimitReached, true);
  assert.equal(status.rewardCredit, 8);
  assert.match(calls[0].url, new RegExp(TRAVEL_API_PREFIX + '/status' + '$'));
  assert.equal(calls[0].init.headers.authorization, 'Bearer t');
  assert.equal(calls[0].init.headers['x-client-platform'], 'web');
  assert.equal(calls[0].init.headers.origin, 'https://www.workbuddy.cn');
  assert.equal(calls[0].init.headers.referer, 'https://www.workbuddy.cn/profile/growth-center');

  const { impl: badImpl } = fakeFetch(() => ({ body: { code: 0, data: {} } }));
  const missing = await fetchTravelStatus({ accessToken: 't', fetchImpl: badImpl });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /旅行状态缺失/);
});

test('travel config treats a missing enabled flag as travelable when locations exist', async () => {
  const { impl } = fakeFetch(() => ({
    body: { code: 0, data: { locations: [{ id: 1, code: 'coffee', name: '咖啡馆', reward_credit_min: 5, reward_credit_max: 10 }] } },
  }));
  const config = await fetchTravelConfig({ accessToken: 't', fetchImpl: impl });
  assert.equal(config.ok, true);
  assert.equal(config.travelable, true);
  assert.deepEqual(config.locations[0], { id: 1, code: 'coffee', name: '咖啡馆', rewardMin: 5, rewardMax: 10 });

  const { impl: emptyImpl } = fakeFetch(() => ({ body: { code: 0, data: { locations: [] } } }));
  const empty = await fetchTravelConfig({ accessToken: 't', fetchImpl: emptyImpl });
  assert.equal(empty.ok, true);
  assert.equal(empty.travelable, false);
});

test('departure walks the location list and reports each failure kind distinctly', async () => {
  const locations = [{ id: 1, name: '咖啡馆' }, { id: 2, name: '商场店铺' }];
  const unavailable = fakeFetch((url, init) => {
    const id = JSON.parse(init.body).location_id;
    return id === 1 ? { body: { code: 400, msg: 'location not available' } } : { body: { code: 0, data: { state: 'traveling' } } };
  });
  const ok = await departTravelWithLocations(locations, { accessToken: 't', fetchImpl: unavailable.impl });
  assert.equal(ok.ok, true);
  assert.equal(ok.locationId, 2);
  assert.equal(ok.location, '商场店铺');

  const noBuddy = fakeFetch(() => ({ body: { code: 400, msg: 'no active buddy' } }));
  const skipped = await departTravelWithLocations(locations, { accessToken: 't', fetchImpl: noBuddy.impl });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.skip, 'no-buddy');

  const limit = fakeFetch(() => ({ body: { code: 400, msg: 'daily limit reached' } }));
  const capped = await departTravelWithLocations(locations, { accessToken: 't', fetchImpl: limit.impl });
  assert.equal(capped.ok, true);
  assert.equal(capped.dailyLimit, true);

  const broken = fakeFetch(() => ({ body: '<html>502</html>' }));
  const failed = await departTravelWithLocations(locations, { accessToken: 't', fetchImpl: broken.impl });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /无法解析/);
});

test('claim posts the record id and returns the reward credit', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { code: 0, data: { reward_credit: 6 } } }));
  const claim = await claimTravel(6106861, { accessToken: 't', fetchImpl: impl });
  assert.equal(claim.ok, true);
  assert.equal(claim.rewardCredit, 6);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(JSON.parse(calls[0].init.body).record_id, 6106861);

  const { impl: failImpl } = fakeFetch(() => ({ body: { code: 400, msg: 'not arrived yet' } }));
  const failed = await claimTravel(1, { accessToken: 't', fetchImpl: failImpl });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /not arrived yet/);
});

/* ———— 5. 协议层接线 ———— */
test('the travel op is registered in the capability catalog and executable', () => {
  const entry = CAPABILITIES.find((item) => item.id === 'account.travel');
  assert.ok(entry, 'account.travel missing from CAPABILITIES');
  assert.equal(entry.available, undefined);
  assert.ok(entry.zh && entry.en && entry.descriptionZh && entry.descriptionEn);
  assert.equal(entry.example.op, 'account.travel');
  assert.equal(entry.example.mode, 'auto');
  assert.equal(SUPPORTED_OPS.has('account.travel'), true);
});

test('task validation accepts the travel op and rejects an unknown mode', () => {
  const ok = validateTask({ id: 'travel-ok', name: '旅行', steps: [{ op: 'account.travel', mode: 'claim', saveAs: 'travel' }] });
  assert.equal(ok.id, 'travel-ok');
  assert.equal(validateTask({ id: 'travel-default', name: '旅行', steps: [{ op: 'account.travel' }] }).steps[0].op, 'account.travel');
  assert.throws(
    () => validateTask({ id: 'travel-bad', name: '旅行', steps: [{ op: 'account.travel', mode: 'fly' }] }),
    /mode 只支持 auto/,
  );
});

test('execution forwards the travel mode to the account travel capability', async () => {
  const seen = [];
  await executeTask(
    { id: 'travel-forward', steps: [{ op: 'account.travel', mode: 'claim', saveAs: 'travel' }] },
    {
      currentAccount: async () => ({ uid: 'u1', nickname: 'Demo' }),
      accountTravel: async (account, detail) => { seen.push({ account, detail }); return { ok: true, claimed: true, rewardCredit: 8 }; },
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].account.uid, 'u1');
  assert.equal(seen[0].detail.mode, 'claim');

  const defaulted = [];
  await executeTask(
    { id: 'travel-default-mode', steps: [{ op: 'account.travel' }] },
    {
      currentAccount: async () => ({ uid: 'u1' }),
      accountTravel: async (_account, detail) => { defaulted.push(detail); return { ok: true }; },
    },
  );
  assert.equal(defaulted[0].mode, 'auto');
});

test('the builtin travel task validates and follows the 15 minute cadence', () => {
  const task = validateTask(builtin);
  assert.equal(task.id, 'daily-buddy-travel');
  assert.equal(task.enabled, false);
  assert.deepEqual(task.trigger.types, ['clientLoaded', 'panelOpened']);
  assert.deepEqual(task.schedule, { type: 'interval', minutes: 15 });
  const step = task.steps[0];
  assert.equal(step.op, 'account.forEach');
  assert.equal(step.switch, false);
  assert.equal(step.steps[0].op, 'logic.catch');
  assert.equal(step.steps[0].steps[0].op, 'account.travel');
  assert.equal(step.steps[0].steps[0].mode, 'auto');
});

test('the travel op is reported as an account-travel effect in packages', () => {
  const result = analyzeTask({ id: 'pkg', name: 'pkg', steps: [{ op: 'account.travel' }] });
  assert.equal(result.effects.includes('account-travel'), true);
  assert.equal(result.capabilities.includes('account.travel'), true);
  // 旅行不做账号切换，不能带出 account-switch 效果。
  assert.equal(result.effects.includes('account-switch'), false);
});

test('travel capability is enabled for the CN client only', () => {
  const list = profiles.listProfiles();
  const byId = Object.fromEntries(list.map((p) => [p.id, p]));
  assert.equal(byId['workbuddy-cn'].capabilities.travel, true);
  assert.equal(byId['workbuddy-ai'].capabilities.travel, false);
  assert.equal(byId['codebuddy-cn'].capabilities.travel, false);
  assert.equal(byId['codebuddy-intl'].capabilities.travel, false);
});

/* ———— 6. daemon 接线 ———— */
test('daemon exposes travel routes, cache, task installer and version bump', () => {
  assert.match(daemonSource, /TRAVEL_CACHE_FILE = path\.join\(DATA_DIR, 'travel-cache\.json'\)/);
  assert.match(daemonSource, /async function performAccountTravel\(uid, mode\)/);
  assert.match(daemonSource, /function claimTravelForUid\(uid, mode\)/);
  assert.match(daemonSource, /accountTravel: async \(account, detail\) =>/);
  assert.match(daemonSource, /'\/api\/travel\/status'/);
  assert.match(daemonSource, /'\/api\/travel\/run'/);
  assert.match(daemonSource, /builtin\/automations\/daily-buddy-travel\.json/);
  assert.match(daemonSource, /PROFILE\.capabilities\.travel === false/);
  assert.match(daemonSource, /const DAEMON_VERSION = '1\.2\.45';/);
});

test('the travel daemon path never switches accounts and only uses per-account tokens', () => {
  const start = daemonSource.indexOf('async function performAccountTravel');
  const end = daemonSource.indexOf('/** 单账号旅行入口', start);
  assert.ok(start > 0 && end > start);
  const body = daemonSource.slice(start, end);
  assert.match(body, /refreshAccountBackupToken\(uid\)/);
  assert.match(body, /travelApiHost\(accessToken, auth\)/);
  // 不能在这个路径里调用账号切换。
  assert.equal(/automationSwitchAccount|withInput\(/.test(body), false);
});
