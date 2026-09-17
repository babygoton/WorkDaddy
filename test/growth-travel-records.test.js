'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  travelDateKey,
  normalizeTravelRecord,
  reconcileTravelRecords,
  readDaySettlement,
  fetchTravelRecords,
  reconcileToday,
  DEFAULT_PAGE_SIZE,
} = require('../scripts/growth-travel-records.js');

const TOKEN = 'header.eyJpc3MiOiJ4In0.signature';

// 固件取自真实账号的 /travel/records 与 /travel/status（2026-09-17 实测快照）
//
// A：09-15 出发的行程，**次日**（09-16 19:27）才领取 —— 领取跨天，这是最容易判错的一类。
const TRIP_A_CLAIMED_NEXT_DAY = {
  record_id: 5467870,
  location: { id: 1, code: 'coffee', name: '咖啡馆', preview_photos: [], traveling_photos: [] },
  depart_at: 1789470233, // 2026-09-15 19:03:53 +08
  arrive_at: 1789484633, // 2026-09-15 23:03:53 +08
  claimed_at: 1789558075, // 2026-09-16 19:27:55 +08
  travel_date: '2026-09-15',
  reward_credit: 10,
  letter: { id: 1, text: '……' },
  use_deeplink: 'workbuddy://discover?cardId=x',
};

// B：09-16 出发、09-16 到家但**至今未领**的行程。实测它不出现在 records 里，
//    只在 /travel/status 里以 state="arrived" + record_id 出现。
const TRIP_B_PENDING = {
  record_id: 5834418,
  location: { id: 1, code: 'coffee', name: '咖啡馆' },
  depart_at: 1789558125, // 2026-09-16 19:28:45 +08
  arrive_at: 1789561725, // 2026-09-16 20:28:45 +08
  claimed_at: 0,
  travel_date: '2026-09-16',
  reward_credit: 9,
};

function mockFetch(payload, { ok = true, status = 200, onRequest } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return async (url, init) => {
    if (onRequest) onRequest(url, init);
    return { ok, status, text: async () => text };
  };
}

test('travelDateKey 按服务端时区切天，而不是本机时区', () => {
  assert.equal(travelDateKey(0), '');
  assert.equal(travelDateKey(null), '');
  // 2026-09-16T16:30:00Z → 北京时间已是 09-17 00:30
  assert.equal(travelDateKey(1789576200), '2026-09-17');
  // 偏移量可覆盖：按 UTC 算还是前一天
  assert.equal(travelDateKey(1789576200, 0), '2026-09-16');
});

test('travelDateKey 兼容毫秒级时间戳', () => {
  assert.equal(travelDateKey(1789576200000), travelDateKey(1789576200));
});

test('normalizeTravelRecord 丢掉无效记录，缺失字段归零而不是 NaN', () => {
  assert.equal(normalizeTravelRecord(null), null);
  assert.equal(normalizeTravelRecord('x'), null);
  const record = normalizeTravelRecord({ record_id: '7', travel_date: '2026-09-15', location: { name: ' 咖啡馆 ' } });
  assert.equal(record.recordId, 7);
  assert.equal(record.travelDate, '2026-09-15');
  assert.equal(record.claimedAt, 0);
  assert.equal(record.rewardCredit, null);
  assert.equal(record.location, '咖啡馆');
});

test('normalizeTravelRecord 幂等：二次归一化不能丢字段', () => {
  // 回归：reconcileTravelRecords 会对传入记录再归一化一次，
  // 若只认 snake_case，已归一化的 camelCase 记录会被清空成空记录。
  const once = normalizeTravelRecord(TRIP_A_CLAIMED_NEXT_DAY);
  assert.deepEqual(normalizeTravelRecord(once), once);
  assert.equal(once.locationId, 1);
  assert.equal(once.locationCode, 'coffee');
  assert.equal(once.location, '咖啡馆');
});

test('今天没派过、也没有记录 → 两个维度都为 false', () => {
  const result = reconcileTravelRecords([TRIP_A_CLAIMED_NEXT_DAY, TRIP_B_PENDING], '2026-09-17');
  assert.equal(result.departedToday, false);
  assert.equal(result.claimedToday, false);
  assert.equal(result.claimedReward, 0);
});

test('领取跨天：昨天出发的行程今天才领，算「今天领过」而不算「今天派过」', () => {
  // 09-15 出发（travel_date=09-15），09-16 领取；到 09-16 那天：
  const onClaimDay = reconcileTravelRecords([TRIP_A_CLAIMED_NEXT_DAY], '2026-09-16');
  assert.equal(onClaimDay.departedToday, false, 'travel_date 是 09-15，不算 09-16 派过');
  assert.equal(onClaimDay.claimedToday, true, 'claimed_at 落在 09-16，算今天领过');
  assert.equal(onClaimDay.claimedReward, 10);
  assert.equal(onClaimDay.claimedRecords.length, 1);

  // 而回到出发日当天，则相反
  const onDepartDay = reconcileTravelRecords([TRIP_A_CLAIMED_NEXT_DAY], '2026-09-15');
  assert.equal(onDepartDay.departedToday, true);
  assert.equal(onDepartDay.claimedToday, false);
});

test('未领取的行程（claimed_at=0）不算已领，即使它在 records 里', () => {
  const result = reconcileTravelRecords([TRIP_B_PENDING], '2026-09-16');
  assert.equal(result.departedToday, true);
  assert.equal(result.claimedToday, false);
  assert.equal(result.claimedReward, 0);
});

test('reconcileTravelRecords 不依赖 records 的排序', () => {
  const other = { ...TRIP_A_CLAIMED_NEXT_DAY, record_id: 1, travel_date: '2026-09-10', claimed_at: 0 };
  const target = TRIP_A_CLAIMED_NEXT_DAY; // travel_date = 2026-09-15
  assert.equal(reconcileTravelRecords([other, target], '2026-09-15').departedToday, true);
  assert.equal(reconcileTravelRecords([target, other], '2026-09-15').departedToday, true);
  assert.equal(reconcileTravelRecords([other], '2026-09-15').departedToday, false);
});

test('同一天多笔领取时积分累加', () => {
  const second = { ...TRIP_A_CLAIMED_NEXT_DAY, record_id: 99, reward_credit: 5 };
  const result = reconcileTravelRecords([TRIP_A_CLAIMED_NEXT_DAY, second], '2026-09-16');
  assert.equal(result.claimedToday, true);
  assert.equal(result.claimedReward, 15);
});

test('reconcileTravelRecords 对空输入与空日期返回空结果', () => {
  assert.deepEqual(reconcileTravelRecords([], '2026-09-17'), reconcileTravelRecords(null, '2026-09-17'));
  assert.equal(reconcileTravelRecords([TRIP_A_CLAIMED_NEXT_DAY], '').claimedToday, false);
});

test('readDaySettlement：arrived 时先领取，不派发', () => {
  const settlement = readDaySettlement({
    status: { state: 'arrived', dailyLimitReached: false },
    reconciliation: reconcileTravelRecords([], '2026-09-17'),
  });
  assert.equal(settlement.needsClaim, true);
  assert.equal(settlement.canDepart, false);
  assert.equal(settlement.settled, false, '有行程待领就不能算今天收敛');
});

test('readDaySettlement：idle 且配额未用 → 可以派发', () => {
  const settlement = readDaySettlement({
    status: { state: 'idle', dailyLimitReached: false },
    reconciliation: reconcileTravelRecords([], '2026-09-17'),
  });
  assert.equal(settlement.canDepart, true);
  assert.equal(settlement.settled, false);
});

test('readDaySettlement：idle + 配额已用 → 今天收敛', () => {
  const settlement = readDaySettlement({
    status: { state: 'idle', dailyLimitReached: true },
    reconciliation: reconcileTravelRecords([], '2026-09-17'),
  });
  assert.equal(settlement.settled, true);
  assert.equal(settlement.canDepart, false);
});

test('readDaySettlement：records 证明今天领过，即使配额字段缺失也判定收敛', () => {
  const settlement = readDaySettlement({
    status: { state: 'idle', dailyLimitReached: false },
    reconciliation: reconcileTravelRecords([TRIP_A_CLAIMED_NEXT_DAY], '2026-09-16'),
  });
  assert.equal(settlement.claimedToday, true);
  assert.equal(settlement.settled, true);
});

test('readDaySettlement：状态未知或缺 status 时不误判成可派发', () => {
  assert.equal(readDaySettlement({ status: { state: '' } }).canDepart, false);
  assert.equal(readDaySettlement({}).canDepart, false);
  assert.equal(readDaySettlement({}).settled, false);
  assert.equal(readDaySettlement().needsClaim, false);
});

test('readDaySettlement：直接吃官方 status（snake_case）也能读到配额字段', () => {
  // 调用方通常把 `/travel/status` 的 data 原样传进来，字段是 daily_limit_reached。
  const reached = readDaySettlement({ status: { state: 'idle', daily_limit_reached: true } });
  assert.equal(reached.dailyLimitReached, true);
  assert.equal(reached.settled, true);
  assert.equal(reached.canDepart, false);

  const notReached = readDaySettlement({ status: { state: 'idle', daily_limit_reached: false } });
  assert.equal(notReached.dailyLimitReached, false);
  assert.equal(notReached.canDepart, true);
});

test('readDaySettlement：snake_case 的 false 不会被驼峰缺省值盖掉', () => {
  // 只认驼峰时 daily_limit_reached:false 会读成 undefined → false，结果巧合正确；
  // 但 true 一定会被读成 false，所以这条用 true 才能锁住行为。
  const settlement = readDaySettlement({
    status: { state: 'idle', daily_limit_reached: true, dailyLimitReached: false },
  });
  assert.equal(settlement.dailyLimitReached, true, '服务端字段优先于同名的驼峰缺省值');
});

test('fetchTravelRecords 走官方路径并带 page/page_size 与 Bearer', async () => {
  let seen = null;
  const result = await fetchTravelRecords({
    accessToken: TOKEN,
    apiHost: 'https://www.codebuddy.cn',
    fetchImpl: mockFetch({ code: 0, data: { records: [TRIP_A_CLAIMED_NEXT_DAY], total: 41, total_page: 3 } }, {
      onRequest: (url, init) => { seen = { url, init }; },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.total, 41);
  assert.equal(result.records.length, 1);
  assert.equal(seen.url, `https://www.codebuddy.cn/activity/growth/buddy/travel/records?page=1&page_size=${DEFAULT_PAGE_SIZE}`);
  assert.equal(seen.init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen.init.headers.referer, 'https://www.codebuddy.cn/profile/growth-center');
});

test('fetchTravelRecords 失败一律 ok:false，绝不当成「今天没派」', async () => {
  const noToken = await fetchTravelRecords({ fetchImpl: mockFetch({}) });
  assert.equal(noToken.ok, false);
  assert.equal(noToken.records.length, 0);

  const httpError = await fetchTravelRecords({ accessToken: TOKEN, fetchImpl: mockFetch({}, { ok: false, status: 500 }) });
  assert.equal(httpError.ok, false);
  assert.match(httpError.error, /500/);

  const badCode = await fetchTravelRecords({ accessToken: TOKEN, fetchImpl: mockFetch({ code: 40001, msg: '限流' }) });
  assert.equal(badCode.ok, false);
  assert.equal(badCode.error, '限流');

  const unparsable = await fetchTravelRecords({ accessToken: TOKEN, fetchImpl: mockFetch('<html>') });
  assert.equal(unparsable.ok, false);

  const thrown = await fetchTravelRecords({
    accessToken: TOKEN,
    fetchImpl: async () => { throw new Error('socket hang up'); },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error, 'socket hang up');
});

test('reconcileToday 用 server_now 判定归属日，不读本机时钟', async () => {
  const result = await reconcileToday({
    accessToken: TOKEN,
    serverNow: 1789576200, // 北京时间 09-17 00:30
    fetchImpl: mockFetch({ code: 0, data: { records: [TRIP_A_CLAIMED_NEXT_DAY], total: 1 } }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.today, '2026-09-17');
  assert.equal(result.reconciliation.claimedToday, false, '那笔是 09-16 领的，不算 09-17');
});

test('reconcileToday 缺服务端时间时拒绝猜测', async () => {
  const result = await reconcileToday({ accessToken: TOKEN, fetchImpl: mockFetch({ code: 0, data: { records: [] } }) });
  assert.equal(result.ok, false);
  assert.equal(result.reconciliation.departedToday, false);
});

test('reconcileToday 透传接口失败，交由调用方退回缓存推断', async () => {
  const result = await reconcileToday({
    accessToken: TOKEN,
    serverNow: 1789576200,
    fetchImpl: mockFetch({}, { ok: false, status: 502 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.today, '2026-09-17');
  assert.match(result.error, /502/);
});
