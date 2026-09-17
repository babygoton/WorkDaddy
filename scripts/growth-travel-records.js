'use strict';

/**
 * 派猫猫旅行：用官方行程历史做权威对账。
 *
 * 目的：回答「今天到底领没领」，而不是靠本地缓存反推。
 *
 * ---------------------------------------------------------------- 接口语义（实测）
 *
 * 1. `records` 里**只有已领取的行程**。猫已到家但还没领的行程（`status` 里是
 *    `state = "arrived"` 且有 `record_id`）**不会出现在 records 里** —— 实测某趟
 *    09-16 出发、09-16 到家的行程未领取，两页 records 共 41 条里都查不到它。
 *    所以「有没有待领取的行程」只能问 `/travel/status`，records 帮不上。
 *
 * 2. `travel_date` 是**出发日**（用 8 条历史样本逐条比对 depart_at，8/8 一致），
 *    不是到达日。
 *
 * 3. **领取可以跨天**。实测：09-11 出发的行程 09-13 才领；09-15 出发的 09-16 才领。
 *    因此「今天领过没」必须看 `claimed_at` 落在哪一天，**不能**用
 *    `travel_date === 今天` 判断 —— 那个字段回答的是「哪天的配额被用掉了」。
 *
 * ---------------------------------------------------------------- 三个问题分开答
 *
 *   今天配额用掉没   → `/travel/status` 的 `daily_limit_reached`
 *                      （待领取的行程不进 records，所以 records 答不了这个）
 *   今天还有要领的吗 → `/travel/status` 的 `state === 'arrived'`
 *   今天领过没       → `records` 里 `claimed_at` 落在今天的记录（本模块）
 *
 * 本模块只做只读接口 + 纯函数：不读不写任何本地文件，也不改变 `growth-travel.js`
 * 里既有的 planTravelStep 结构。调用方把它当成「给今天的 prior 记录做一次权威 seeding」。
 *
 * 与缓存的关系（职责不同，不是二选一）：
 *   - 缓存负责**节流**：多账号并发的去重、TRAVEL_DEPART_RETRY_MS 的派发重试间隔；
 *   - records 负责**终局判定**：今天是不是真的已经领完收敛了。
 */

const TRAVEL_RECORDS_PATH = '/activity/growth/buddy/travel/records';
const TRAVEL_TIMEZONE_OFFSET_HOURS = 8; // 成长中心按北京时间切天
const DEFAULT_PAGE_SIZE = 20;

function nonEmptyString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nonZeroCredit(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return null;
  return number;
}

function seconds(value) {
  const number = Number(value) || 0;
  if (number <= 0) return 0;
  return number > 1000000000000 ? Math.floor(number / 1000) : Math.floor(number);
}

/**
 * 服务端秒级时间戳 → 成长中心口径的 YYYY-MM-DD。
 * 时区偏移显式传入而不是依赖本机时区：对账口径必须和服务端一致，
 * 否则跨零点前后会把"昨天那趟"认成今天的。
 */
function travelDateKey(timestamp, offsetHours = TRAVEL_TIMEZONE_OFFSET_HOURS) {
  const value = Number(timestamp) || 0;
  if (value <= 0) return '';
  const offset = Number.isFinite(Number(offsetHours)) ? Number(offsetHours) : TRAVEL_TIMEZONE_OFFSET_HOURS;
  const shifted = value > 1000000000000 ? value + offset * 3600 * 1000 : value * 1000 + offset * 3600 * 1000;
  return new Date(shifted).toISOString().slice(0, 10);
}

function pick(source, snake, camel) {
  const value = source[snake];
  return value === undefined || value === null || value === '' ? source[camel] : value;
}

/**
 * 归一化一条行程记录。
 * 幂等：同时接受服务端 snake_case 和本模块已归一化后的 camelCase 形态，
 * 否则本模块内部（或调用方）对同一份数据二次归一化时会把字段全部丢掉。
 */
function normalizeTravelRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawLocation = raw.location;
  const nested = rawLocation && typeof rawLocation === 'object' ? rawLocation : {};
  const flatName = typeof rawLocation === 'string' ? rawLocation : '';
  const nestedId = nested.id;
  return {
    recordId: Number(pick(raw, 'record_id', 'recordId')) || 0,
    travelDate: nonEmptyString(pick(raw, 'travel_date', 'travelDate')),
    departedAt: seconds(pick(raw, 'depart_at', 'departedAt')),
    arriveAt: seconds(pick(raw, 'arrive_at', 'arriveAt')),
    claimedAt: seconds(pick(raw, 'claimed_at', 'claimedAt')),
    rewardCredit: nonZeroCredit(pick(raw, 'reward_credit', 'rewardCredit')),
    locationId: nestedId !== undefined && nestedId !== null ? nestedId : raw.locationId === undefined ? null : raw.locationId,
    locationCode: nonEmptyString(nested.code) || nonEmptyString(raw.locationCode),
    location: nonEmptyString(nested.name) || nonEmptyString(raw.location) || flatName.trim(),
  };
}

/**
 * 对账（纯函数）。两个维度分开算，因为它们的判定字段不同：
 *   departedToday — 今天用掉过配额（`travel_date === today`）
 *   claimedToday  — 今天真正领到过奖励（`claimed_at` 落在 today，可跨天补领）
 */
function reconcileTravelRecords(records, today, offsetHours = TRAVEL_TIMEZONE_OFFSET_HOURS) {
  const date = nonEmptyString(today);
  const empty = { today: date, departedToday: false, claimedToday: false, claimedReward: 0, departedRecords: [], claimedRecords: [] };
  if (!date) return empty;
  const list = (Array.isArray(records) ? records : []).map(normalizeTravelRecord).filter(Boolean);
  const departedRecords = list.filter((item) => item.travelDate === date);
  const claimedRecords = list.filter((item) => item.claimedAt > 0 && travelDateKey(item.claimedAt, offsetHours) === date);
  return {
    today: date,
    departedToday: departedRecords.length > 0,
    claimedToday: claimedRecords.length > 0,
    claimedReward: claimedRecords.reduce((sum, item) => sum + (item.rewardCredit || 0), 0),
    departedRecords,
    claimedRecords,
  };
}

/**
 * 把「官方 status」和「权威历史」合成一个当日结算判定。
 * 两者回答的是不同问题，缺一不可：
 *   status  — 此刻猫在哪、今天的出发配额用没用掉（待领取的行程不进 records，只有 status 知道）
 *   records — 今天到底领没领（领取可跨天，只能看 claimed_at 落在哪一天）
 */
function readDaySettlement({ status, reconciliation } = {}) {
  const source = status && typeof status === 'object' ? status : {};
  const state = String(source.state || '');
  // 同时接受服务端 snake_case 和已归一化后的 camelCase：调用方通常直接把
  // `/travel/status` 的 data 原样传进来，只认驼峰会把它永远读成 false。
  const dailyLimitReached = !!pick(source, 'daily_limit_reached', 'dailyLimitReached');
  const needsClaim = state === 'arrived';
  const canDepart = state === 'idle' && !dailyLimitReached;
  const claimedToday = !!(reconciliation && reconciliation.claimedToday === true);
  // 今天再无动作可做：没有待领取的行程，且配额已用掉（或今天已经领过）。
  const settled = state === 'idle' && (dailyLimitReached || claimedToday);
  return { state, needsClaim, canDepart, claimedToday, dailyLimitReached, settled };
}

function travelHeaders(apiHost, accessToken, extra = {}) {
  return Object.assign({
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'x-codebuddy-request': '1',
    'x-client-platform': 'web',
    origin: apiHost,
    referer: `${apiHost}/profile/growth-center`,
    authorization: `Bearer ${accessToken}`,
  }, extra);
}

/** 读取行程历史。失败一律返回 ok:false，调用方据此退回缓存推断，绝不当作"今天没派"。 */
async function fetchTravelRecords(options = {}) {
  const apiHost = String(options.apiHost || 'https://www.workbuddy.cn').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!options.accessToken || typeof fetchImpl !== 'function') {
    return { ok: false, error: '行程历史接口参数不完整', records: [], total: 0 };
  }
  const page = Number(options.page) > 0 ? Number(options.page) : 1;
  const pageSize = Number(options.pageSize) > 0 ? Number(options.pageSize) : DEFAULT_PAGE_SIZE;
  const url = `${apiHost}${TRAVEL_RECORDS_PATH}?page=${page}&page_size=${pageSize}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 12000);
  try {
    const response = await fetchImpl(url, { method: 'GET', headers: travelHeaders(apiHost, options.accessToken), signal: controller.signal });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      return { ok: false, error: '行程历史返回了无法解析的数据', records: [], total: 0 };
    }
    if (!response.ok) {
      return { ok: false, error: `行程历史 HTTP ${response.status}`, records: [], total: 0 };
    }
    if (payload && payload.code !== undefined && payload.code !== null && payload.code !== 0) {
      return { ok: false, error: payload.msg || payload.message || `行程历史 code=${payload.code}`, records: [], total: 0 };
    }
    const data = payload && typeof payload.data === 'object' && payload.data !== null ? payload.data : {};
    const records = (Array.isArray(data.records) ? data.records : []).map(normalizeTravelRecord).filter(Boolean);
    return { ok: true, error: '', records, total: Number(data.total) || 0, totalPage: Number(data.total_page) || 0 };
  } catch (error) {
    if (error && error.name === 'AbortError') return { ok: false, error: '行程历史请求超时', records: [], total: 0 };
    return { ok: false, error: String((error && error.message) || error), records: [], total: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 对账"今天"（发给 daemon 的一行调用）。
 * serverNow 用 `/travel/status` 返回的 `server_now`，不要用本机时钟 ——
 * 时钟漂移会让跨零点判定错一天。
 */
async function reconcileToday(options = {}) {
  const offsetHours = Number.isFinite(Number(options.offsetHours)) ? Number(options.offsetHours) : TRAVEL_TIMEZONE_OFFSET_HOURS;
  const today = nonEmptyString(options.today) || travelDateKey(options.serverNow, offsetHours);
  const empty = reconcileTravelRecords([], today, offsetHours);
  if (!today) return { ok: false, error: '缺少服务端时间，无法判定归属日', today: '', reconciliation: empty };
  const page = await fetchTravelRecords(options);
  if (!page.ok) return { ok: false, error: page.error, today, reconciliation: empty };
  return { ok: true, error: '', today, total: page.total, reconciliation: reconcileTravelRecords(page.records, today, offsetHours) };
}

module.exports = {
  TRAVEL_RECORDS_PATH,
  TRAVEL_TIMEZONE_OFFSET_HOURS,
  DEFAULT_PAGE_SIZE,
  travelDateKey,
  normalizeTravelRecord,
  reconcileTravelRecords,
  readDaySettlement,
  fetchTravelRecords,
  reconcileToday,
};
