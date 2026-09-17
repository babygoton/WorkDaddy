'use strict';

/**
 * 派猫猫旅行：状态机、接口封装与每日缓存合并。
 *
 * 官方接口（成长中心，随账号域名走）：
 *   GET  {apiHost}/activity/growth/buddy/travel/config   → { data: { locations: [...] } }
 *   GET  {apiHost}/activity/growth/buddy/travel/status   → { data: { state, arrive_at, daily_limit_reached, ... } }
 *   POST {apiHost}/activity/growth/buddy/travel/depart   { location_id } → { data: { state } }
 *   POST {apiHost}/activity/growth/buddy/travel/claim    { record_id }   → { data: { reward_credit } }
 *
 * 状态机以服务端 `data.state` 为准：idle ->(depart)-> traveling ->(到点)-> arrived ->(claim)-> idle。
 * `daily_limit_reached` 是「今天这次机会已经用掉了」，所以 idle + daily_limit_reached 不能再派发。
 *
 * 本模块只做纯逻辑与 HTTP 原语，不碰文件、不碰账号：缓存读写与并发去重在 daemon 侧。
 */

const TRAVEL_API_PREFIX = '/activity/growth/buddy/travel';
const TRAVEL_TIMEOUT_MS = 12000;
/** 派发失败后的重试节流：任务每 15 分钟跑一轮，靠它把「派发重试」压到 30 分钟一次。 */
const TRAVEL_DEPART_RETRY_MS = 30 * 60 * 1000;
const TRAVEL_MESSAGE_MAX = 80;
const TRAVEL_STATES = ['idle', 'traveling', 'arrived'];

/** 这些跳过原因不算「今天已经办完」，下一轮还要再试。 */
const TRAVEL_RETRYABLE_SKIPS = [
  'no-buddy',
  'error',
  'config-error',
  'no-location',
  'location-unavailable',
  'status-error',
  'claim-error',
  // 派发重试冷却中：这一轮只是等下一次机会，不能算今天办完。
  'retry-wait',
];

function travelCapabilityError() {
  return new Error('当前客户端不支持派猫猫旅行');
}

// ---------------------------------------------------------------- 纯逻辑

/** `data.state` → 已知状态；未知/缺失一律返回 null（不能当成 idle，否则会误判成「可以派发」）。 */
function parseTravelState(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return TRAVEL_STATES.includes(value) ? value : null;
}

/**
 * 与官网同一套判断：先看 state，再看 daily_limit_reached。
 * 返回 'claim' | 'wait' | 'skip-daily-limit' | 'depart' | 'status-error'。
 */
function decideTravelAction(state, dailyLimitReached) {
  const normalized = parseTravelState(state);
  if (normalized === 'arrived') return 'claim';
  if (normalized === 'traveling') return 'wait';
  if (normalized !== 'idle') return 'status-error';
  return dailyLimitReached ? 'skip-daily-limit' : 'depart';
}

/**
 * 派发失败的分类。注意 HTTP 429/限流不是「今日已派」——只有文案明确 daily limit 才算，
 * 否则被限流的那天会被永久标成已完成，之后再也不会重试。
 */
function classifyDepartError(code, message) {
  const raw = String(message || '').toLowerCase();
  if (raw.includes('already traveling') || raw.includes('already_traveling')) return 'already-traveling';
  if (raw.includes('daily limit') || raw.includes('daily_limit')) return 'daily-limit';
  if (raw.includes('no active buddy') || raw.includes('no_buddy')) return 'no-buddy';
  if (raw.includes('location not available') || raw.includes('location_unavailable')) return 'location-unavailable';
  return 'other';
}

function isRetryableTravelSkip(skip) {
  return TRAVEL_RETRYABLE_SKIPS.includes(String(skip || ''));
}

/** 秒级/毫秒级时间戳统一成秒。 */
function arriveAtSeconds(value) {
  const n = Number(value) || 0;
  if (n <= 0) return 0;
  return n > 1000000000000 ? Math.floor(n / 1000) : Math.floor(n);
}

function travelRecordInFlight(record) {
  if (!record || typeof record !== 'object') return false;
  return record.ok === true && record.claimed !== true;
}

function travelRecordClaimed(record) {
  return !!(record && typeof record === 'object' && record.claimed === true);
}

/** 旅行中、且到达时间已过（或缓存里没有到达时间）→ 该去问一次官方状态并领取。 */
function inFlightDue(record, now) {
  if (!travelRecordInFlight(record)) return false;
  const arrive = arriveAtSeconds(record.arriveAt);
  return arrive <= 0 || arrive <= Math.floor(Number(now) / 1000);
}

/** 派发重试节流：上一次尝试在 retryMs 之内就再等一轮（默认 30 分钟）。 */
function travelDueForRetry(record, now, retryMs = TRAVEL_DEPART_RETRY_MS) {
  const last = Number(record && record.departAttemptAt) || 0;
  if (!last) return true;
  return Math.floor(Number(now) - last) >= retryMs;
}

/** 跨日：丢掉昨天的收尾记录，但保留仍在 traveling/arrived 的未领行程。 */
function rollTravelCacheToToday(cache, today) {
  const base = cache && typeof cache === 'object' ? cache : {};
  if (base.date === today) return { date: today, completed: !!base.completed, results: { ...(base.results || {}) } };
  const results = {};
  for (const [uid, entry] of Object.entries(base.results || {})) {
    if (travelRecordInFlight(entry)) results[uid] = { ...entry };
  }
  return { date: today, completed: false, results };
}

function nonEmptyString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function nonZeroCredit(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

/**
 * 合并同一账号的新旧记录。
 * 官方状态显示新的 traveling/arrived 时视为新行程，不能把上一趟的 claimed / 积分带过来。
 */
function mergeTravelRecord(prior, next) {
  const merged = { ...(next || {}) };
  if (travelRecordInFlight(merged)) {
    if (!nonEmptyString(merged.location)) {
      const name = nonEmptyString(prior && prior.location);
      if (name) merged.location = name;
    }
    // 只有「上一趟也还在飞」时，才把积分/到达时间当作同一趟的信息补上。
    if (travelRecordInFlight(prior)) {
      if (nonZeroCredit(merged.rewardCredit) === null) {
        const credit = nonZeroCredit(prior.rewardCredit);
        if (credit !== null) merged.rewardCredit = credit;
      }
      if (arriveAtSeconds(merged.arriveAt) <= 0 && arriveAtSeconds(prior.arriveAt) > 0) {
        merged.arriveAt = prior.arriveAt;
      }
    }
    return merged;
  }
  if (!travelRecordClaimed(prior)) return merged;
  merged.claimed = true;
  if (nonZeroCredit(merged.rewardCredit) === null) {
    merged.rewardCredit = prior.rewardCredit === undefined ? null : prior.rewardCredit;
    merged.claimedAt = Number(prior.claimedAt) || 0;
  }
  if (!nonEmptyString(merged.location)) {
    const name = nonEmptyString(prior.location);
    if (name) merged.location = name;
  }
  merged.state = 'idle';
  return merged;
}

/** 只要还有可重试的跳过，今天就不算办完（参考项目在这点上踩过坑：no-buddy 被标完成后再也不重试）。 */
/**
 * 当日完成标记：所有账号都已到达终态才算完成。
 * 「终态」= 奖励已领（含今日已派/网页端已领），且没有待重试项、也没有还在飞的行程——
 * 行程在飞时稍后到达仍要领取，因此绝不能提前标成完成。
 */
function travelCacheCompleted(results) {
  const entries = Object.values(results || {});
  if (!entries.length) return false;
  return entries.every((entry) => {
    if (isRetryableTravelSkip(entry && entry.skip)) return false;
    if (String((entry && entry.state) || '') === 'traveling') return false;
    return entry && entry.claimed === true;
  });
}

function truncateTravelMessage(message) {
  const text = String(message || '').trim();
  return text.length > TRAVEL_MESSAGE_MAX ? text.slice(0, TRAVEL_MESSAGE_MAX) : text;
}

/**
 * 决定这一轮要做什么（纯函数，便于单测）。
 * mode: 'auto' 全自动对账 | 'depart' 只派发 | 'claim' 只领取。
 * 返回 { action, reason, skip }；action ∈ depart|claim|wait|skip|error。
 */
function planTravelStep(input) {
  const options = input || {};
  const mode = options.mode === 'depart' || options.mode === 'claim' ? options.mode : 'auto';
  const now = Number(options.now) || Date.now();
  const retryMs = Number(options.retryMs) > 0 ? Number(options.retryMs) : TRAVEL_DEPART_RETRY_MS;
  const prior = options.prior && typeof options.prior === 'object' ? options.prior : {};
  const status = options.status && typeof options.status === 'object' ? options.status : {};
  if (!status.ok) {
    return { action: 'error', reason: String(status.error || '查询旅行状态失败'), skip: 'status-error' };
  }
  const state = parseTravelState(status.state);
  if (!state) {
    return { action: 'error', reason: '旅行状态无法识别：' + String(status.state), skip: 'status-error' };
  }
  const dailyLimit = status.dailyLimitReached === true;
  if (mode === 'claim') {
    if (state === 'arrived') return { action: 'claim', reason: '已到达，领取奖励' };
    if (state === 'traveling') return { action: 'wait', reason: '旅行中' };
    if (dailyLimit) return { action: 'skip', reason: '今日已派', skip: 'daily-limit' };
    if (travelRecordClaimed(prior)) return { action: 'wait', reason: '今日已完成' };
    // 状态在两次请求之间翻转（arrived→idle）时，官方 status 可能已经扣掉了记录，
    // 这里仍然试一次 claim：claim 是幂等的，失败也不会重复发奖。
    if (prior.ok === true) return { action: 'claim', reason: '补领奖励' };
    return { action: 'wait', reason: '今日尚无行程' };
  }
  if (state === 'arrived') return { action: 'claim', reason: '已到达，领取奖励' };
  if (state === 'traveling') return { action: 'wait', reason: '旅行中' };
  if (dailyLimit) return { action: 'skip', reason: '今日已派', skip: 'daily-limit' };
  if (mode === 'depart') {
    if (!travelDueForRetry(prior, now, retryMs)) {
      return { action: 'wait', reason: '派发重试冷却中', skip: 'retry-wait' };
    }
    return { action: 'depart', reason: '派猫猫出门' };
  }
  if (!travelDueForRetry(prior, now, retryMs)) {
    return { action: 'wait', reason: '派发重试冷却中', skip: 'retry-wait' };
  }
  return { action: 'depart', reason: '派猫猫出门' };
}

/** 运行日志/回执用的一行摘要。 */
function summarizeTravelRecord(record, today) {
  if (!record) return '未查询';
  if (record.skipped === true) return '已跳过' + (record.message ? '(' + record.message + ')' : '');
  if (record.claimed === true) {
    const credit = nonZeroCredit(record.rewardCredit);
    const where = nonEmptyString(record.location);
    return '已领取' + (credit !== null ? ' +' + credit : '') + (where ? ' @' + where : '');
  }
  if (record.state === 'traveling') {
    const where = nonEmptyString(record.location);
    return '旅行中' + (where ? ' @' + where : '');
  }
  if (record.state === 'arrived') return '已到达待领取';
  if (record.state === 'idle') return '未出发';
  if (record.ok === false) return '失败' + (record.message ? '(' + record.message + ')' : '');
  return '待确认';
}

/** 记录是否属于今天（跨日时要丢掉）。 */
function travelRecordDate(record, today) {
  return !!record && record.date === today;
}

// ---------------------------------------------------------------- HTTP 原语

function travelHeaders(apiHost, accessToken, extra = {}) {
  return Object.assign({
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'x-codebuddy-request': '1',
    'x-client-platform': 'web',
    origin: apiHost,
    // 成长中心来源，官方按这个校验 Referer。
    referer: `${apiHost}/profile/growth-center`,
    authorization: `Bearer ${accessToken}`,
  }, extra);
}

async function travelRequest(path, options, { method = 'GET', body } = {}) {
  const opts = options || {};
  const apiHost = String(opts.apiHost || 'https://www.workbuddy.cn').replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : TRAVEL_TIMEOUT_MS;
  if (!opts.accessToken || typeof fetchImpl !== 'function') throw new Error('旅行接口参数不完整');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${apiHost}${TRAVEL_API_PREFIX}${path}`, {
      method,
      headers: travelHeaders(apiHost, opts.accessToken),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      return { ok: false, code: response.status, message: '旅行接口返回了无法解析的数据' };
    }
    if (!response.ok) {
      return {
        ok: false,
        code: response.status,
        message: payload && (payload.msg || payload.message) || `旅行接口 HTTP ${response.status}`,
      };
    }
    if (payload && payload.code !== undefined && payload.code !== null && payload.code !== 0) {
      return { ok: false, code: payload.code, message: payload.msg || payload.message || `旅行接口 code=${payload.code}` };
    }
    return { ok: true, data: payload && typeof payload.data === 'object' && payload.data !== null ? payload.data : {} };
  } catch (error) {
    if (error && error.name === 'AbortError') return { ok: false, code: -1, message: '旅行接口请求超时' };
    return { ok: false, code: -1, message: String(error && error.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 读取旅行地点配置。
 *
 * 注意：官方 `/config` 里**没有** `enabled` 字段（实测 2026-09-17），所以「能不能派」
 * 只由 `locations` 是否为空决定——照抄参考项目里 `enabled` 的写法会误判成关闭。
 */
async function fetchTravelConfig(options) {
  const result = await travelRequest('/config', options);
  if (!result.ok) return result;
  const locations = Array.isArray(result.data.locations)
    ? result.data.locations.map((item) => ({
      id: item && item.id !== undefined ? item.id : null,
      code: item && typeof item.code === 'string' ? item.code : '',
      name: item && typeof item.name === 'string' ? item.name : '',
      rewardMin: item && Number(item.reward_credit_min) || null,
      rewardMax: item && Number(item.reward_credit_max) || null,
    })).filter((item) => item.id !== null)
    : [];
  return { ok: true, locations, travelable: locations.length > 0 };
}

/** 读取当前旅行状态；缺 state / 未知 state 视为失败，避免被当成 idle 后误判。 */
async function fetchTravelStatus(options) {
  const result = await travelRequest('/status', options);
  if (!result.ok) return result;
  const data = result.data;
  const state = parseTravelState(data.state);
  if (!state) {
    return {
      ok: false,
      code: -1,
      message: nonEmptyString(data.state) ? `未知旅行状态：${data.state}` : '旅行状态缺失',
    };
  }
  const location = data.location && typeof data.location === 'object' ? data.location : {};
  return {
    ok: true,
    state,
    buddyId: Number(data.buddy_id) || 0,
    recordId: Number(data.record_id) || 0,
    locationId: location.id !== undefined ? location.id : null,
    locationCode: typeof location.code === 'string' ? location.code : '',
    location: typeof location.name === 'string' ? location.name : '',
    departAt: Number(data.depart_at) || 0,
    arriveAt: Number(data.arrive_at) || 0,
    serverNow: Number(data.server_now) || 0,
    durationHours: Number(data.duration_hours) || 0,
    rewardCredit: data.reward_credit === undefined ? null : data.reward_credit,
    dailyLimitReached: data.daily_limit_reached === true,
    letter: data.letter === undefined ? null : data.letter,
  };
}

/** 派猫猫出门。 */
async function departTravel(locationId, options) {
  const result = await travelRequest('/depart', options, {
    method: 'POST',
    body: { location_id: locationId === undefined ? null : locationId },
  });
  if (!result.ok) return result;
  return { ok: true, state: parseTravelState(result.data.state) || 'traveling' };
}

/** 领取旅行奖励。record_id 缺失时官方也接受空 body。 */
async function claimTravel(recordId, options) {
  const id = Number(recordId) || 0;
  const result = await travelRequest('/claim', options, { method: 'POST', body: id > 0 ? { record_id: id } : {} });
  if (!result.ok) return result;
  return { ok: true, rewardCredit: result.data.reward_credit === undefined ? null : result.data.reward_credit };
}

/** 按顺序尝试地点列表，遇到「地点不可用」换下一个。 */
async function departTravelWithLocations(locations, options) {
  let unavailable = false;
  for (const location of locations || []) {
    const result = await departTravel(location && location.id, options);
    if (result.ok) return { ...result, locationId: location.id, location: location.name || '' };
    const kind = classifyDepartError(result.code, result.message);
    if (kind === 'already-traveling') {
      return { ok: true, already: true, state: 'traveling', locationId: location.id, location: location.name || '', message: '已在旅行中' };
    }
    if (kind === 'daily-limit') {
      return { ok: true, already: true, dailyLimit: true, state: 'idle', message: '今日已派' };
    }
    if (kind === 'no-buddy') return { ok: false, skip: 'no-buddy', message: '账号还没有猫猫', code: result.code };
    if (kind === 'location-unavailable') {
      unavailable = true;
      continue;
    }
    return { ok: false, skip: 'error', message: truncateTravelMessage(result.message), code: result.code };
  }
  return unavailable
    ? { ok: false, skip: 'location-unavailable', message: '地点都不可用' }
    : { ok: false, skip: 'error', message: '派发失败' };
}

module.exports = {
  TRAVEL_API_PREFIX,
  TRAVEL_TIMEOUT_MS,
  TRAVEL_DEPART_RETRY_MS,
  TRAVEL_RETRYABLE_SKIPS,
  travelCapabilityError,
  parseTravelState,
  decideTravelAction,
  classifyDepartError,
  isRetryableTravelSkip,
  arriveAtSeconds,
  travelRecordInFlight,
  travelRecordClaimed,
  inFlightDue,
  travelDueForRetry,
  rollTravelCacheToToday,
  mergeTravelRecord,
  travelCacheCompleted,
  truncateTravelMessage,
  planTravelStep,
  summarizeTravelRecord,
  travelRecordDate,
  fetchTravelConfig,
  fetchTravelStatus,
  departTravel,
  claimTravel,
  departTravelWithLocations,
};
