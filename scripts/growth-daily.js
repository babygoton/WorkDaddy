'use strict';

const crypto = require('node:crypto');

const REQUEST_TIMEOUT_MS = 12000;
const AUTOMATABLE_TASK_CODES = new Set([
  'create_canvas', 'template_5', 'expert_5', 'Expert_team_use_3',
  'automation_1', 'playbook_prompt', 'Expert_lighthouse', 'Buddy_App',
  'Buddy_App_QQ', 'Hp_Appearance', 'chat_5', 'Model_chat_GLM5.2',
  'black_cat', 'Library_read',
]);
const LOCKED_BUDDY_TASK_CODES = new Set(['first_buddy', 'RichMeow_Chat']);
const TASK_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,96}$/;

function ratio(value, total) {
  return total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;
}

function nonNegativeNumber(input, fallback = null) {
  const number = Number(input);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function boundedText(input, maxLength) {
  return typeof input === 'string' ? input.trim().slice(0, maxLength) : '';
}

function normalizeDailyProgress(tasks, travel, options = {}) {
  const list = Array.isArray(tasks) ? tasks.filter((task) => task && typeof task === 'object') : [];
  let completed = 0;
  let rewardTotal = 0;
  let rewardClaimed = 0;
  let rewardPending = 0;
  const manualTasks = [];
  const taskDetails = [];
  for (const task of list) {
    const status = String(task.accept_status || 'not_accepted');
    const progress = task.progress && typeof task.progress === 'object' ? task.progress : {};
    const current = Math.max(0, Number(progress.current) || 0);
    const target = Math.max(1, Number(progress.target) || 1);
    const isComplete = status === 'completed' || status === 'claimed' || current >= target;
    const state = status === 'claimed' ? 'claimed'
      : isComplete ? 'completed'
      : status === 'not_accepted' ? 'not_accepted'
      : 'in_progress';
    taskDetails.push({
      taskCode: TASK_CODE_PATTERN.test(String(task.task_code || '')) ? String(task.task_code) : '',
      title: String(task.title || task.task_desc || task.task_code || '未识别任务').slice(0, 80),
      guide: boundedText(task.description, 360) || boundedText(task.task_desc, 360),
      tag: boundedText(task.tag, 24),
      deadline: boundedText(task.valid_end, 64) || null,
      reward: {
        credits: nonNegativeNumber(task.reward_credit, 0),
        energy: nonNegativeNumber(task.reward_energy, 0),
        buddy: task.reward_buddy === true,
      },
      current,
      target,
      state,
    });
    if (isComplete) completed++;
    if (Number(task.reward_credit) > 0 || Number(task.reward_energy) > 0) {
      rewardTotal++;
      if (status === 'claimed') rewardClaimed++;
      else if (isComplete) rewardPending++;
    }
    if (!AUTOMATABLE_TASK_CODES.has(String(task.task_code || '')) && !isComplete) {
      manualTasks.push(String(task.title || task.task_desc || task.task_code || '未识别任务').slice(0, 60));
    }
  }

  const value = travel && typeof travel === 'object' ? travel : {};
  const available = value.available !== false;
  const buddies = Array.isArray(options.buddies) ? options.buddies : [];
  const state = !available ? 'locked'
    : options.buddyKnown === false ? 'unknown'
    : options.activeBuddy === false && buddies.length && value.state === 'idle' ? 'needs_selection'
    : String(value.state || 'unknown');
  const dailyLimitReached = value.daily_limit_reached === true;
  let catProgress = 0;
  if (dailyLimitReached || state === 'traveling') catProgress = 1;
  else if (state === 'arrived') catProgress = 0.72;
  const arriveAtSeconds = Number(value.arrive_at);
  const arriveAt = Number.isFinite(arriveAtSeconds) && arriveAtSeconds > 0 ? arriveAtSeconds * 1000 : null;
  const gacha = options.gacha && typeof options.gacha === 'object' ? options.gacha : null;
  const lottery = options.lottery && typeof options.lottery === 'object' ? options.lottery : null;
  const travelReward = {
    credits: nonNegativeNumber(value.reward_credit, 0),
    energy: nonNegativeNumber(value.reward_energy, 0),
  };

  return {
    status: 'ready',
    fetchedAt: Number(options.fetchedAt) || Date.now(),
    growth: { completed, total: list.length, ratio: ratio(completed, list.length), tasks: taskDetails.slice(0, 50) },
    rewards: { claimed: rewardClaimed, total: rewardTotal, pending: rewardPending, ratio: ratio(rewardClaimed, rewardTotal) },
    cat: { state, progress: catProgress, arriveAt, dailyLimitReached, available, activeBuddy: options.activeBuddy === true, buddies, reward: travelReward },
    actions: {
      gacha: {
        available: gacha !== null,
        count: gacha ? nonNegativeNumber(gacha.affordable) : null,
        energy: gacha ? nonNegativeNumber(gacha.balance) : null,
        cost: gacha ? nonNegativeNumber(gacha.cost_per_open) : null,
      },
      lottery: {
        available: lottery !== null,
        count: lottery ? nonNegativeNumber(lottery.balance) : null,
      },
    },
    manualTasks: manualTasks.slice(0, 8),
  };
}

function requestHeaders(apiHost, accessToken) {
  return {
    accept: 'application/json, text/plain, */*',
    authorization: `Bearer ${accessToken}`,
    origin: apiHost,
    referer: `${apiHost}/profile/growth-center`,
    'x-client-platform': 'web',
  };
}

async function fetchJson(apiHost, accessToken, paths, options) {
  let lastError;
  for (const endpoint of paths) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await options.fetchImpl(`${apiHost}${endpoint}`, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: requestHeaders(apiHost, accessToken),
      });
      const text = await response.text();
      let payload;
      try { payload = JSON.parse(text); }
      catch (_) { throw new Error('成长中心接口返回了无法解析的数据'); }
      if (!response.ok) throw new Error(`成长中心接口 HTTP ${response.status}`);
      if (payload.code !== 0 && payload.code !== undefined && payload.code !== null) throw new Error(payload.msg || `成长中心接口 code=${payload.code}`);
      return payload.data && typeof payload.data === 'object' ? payload.data : {};
    } catch (error) {
      lastError = error && error.name === 'AbortError' ? new Error('成长中心接口请求超时') : error;
    } finally { clearTimeout(timer); }
  }
  throw lastError || new Error('成长中心接口请求失败');
}

async function fetchOptionalJson(apiHost, accessToken, paths, options) {
  try { return await fetchJson(apiHost, accessToken, paths, options); }
  catch (_) { return null; }
}

async function postGrowthJson(accessToken, endpoint, body, label, options = {}) {
  const apiHost = String(options.apiHost || 'https://www.codebuddy.cn').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!accessToken || typeof fetchImpl !== 'function') throw new Error(`${label}参数不完整`);
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${apiHost}${endpoint}`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { ...requestHeaders(apiHost, accessToken), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch (_) { throw new Error(`${label}接口返回了无法解析的数据`); }
    if (!response.ok) throw new Error(payload.msg || `${label}接口 HTTP ${response.status}`);
    if (payload.code !== 0) throw new Error(payload.msg || `${label}接口 code=${payload.code}`);
    return payload.data && typeof payload.data === 'object' ? payload.data : {};
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error(`${label}请求超时`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function claimFirstBuddy(accessToken, options = {}) {
  return postGrowthJson(accessToken, '/activity/growth/buddy/first', undefined, '解锁 Buddy', options);
}

function openBuddyBlindBox(accessToken, options = {}) {
  return postGrowthJson(accessToken, '/v2/activity/growth/buddy/open', { count: 1 }, '开启盲盒', options);
}

function drawGrowthLottery(accessToken, options = {}) {
  const clientToken = boundedText(options.clientToken, 120) || `draw-${crypto.randomUUID()}`;
  return postGrowthJson(accessToken, '/v2/activity/growth/lottery/draw', { client_token: clientToken }, '抽奖', options);
}

function summarizeGrowthActionReward(kind, data) {
  const value = data && typeof data === 'object' ? data : {};
  if (kind === 'gacha') {
    const first = Array.isArray(value.results) && value.results[0] && typeof value.results[0] === 'object' ? value.results[0] : {};
    const instance = first.instance && typeof first.instance === 'object' ? first.instance : {};
    const template = first.template && typeof first.template === 'object' ? first.template : {};
    const name = boundedText(instance.name, 80) || boundedText(template.name, 80) || boundedText(value.name, 80);
    const rarity = boundedText(instance.rarity, 32) || boundedText(template.rarity, 32);
    if (name) return name + (rarity ? ` · ${rarity}` : '');
  }
  const name = boundedText(value.prize_name, 80) || boundedText(value.name, 80) || boundedText(value.reward_name, 80);
  if (name) return name;
  const parts = [];
  const credits = nonNegativeNumber(value.credit_granted ?? value.credits ?? value.reward_credit, 0);
  const energy = nonNegativeNumber(value.energy_granted ?? value.energy ?? value.reward_energy, 0);
  if (credits > 0) parts.push(`${credits} Credits`);
  if (energy > 0) parts.push(`${energy} 能量`);
  return parts.join(' · ') || '奖励已到账';
}

async function acceptGrowthTasks(accessToken, taskCodes, options = {}) {
  const apiHost = String(options.apiHost || 'https://www.codebuddy.cn').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const codes = Array.isArray(taskCodes) ? taskCodes.map((code) => String(code || '').trim()) : [];
  if (!accessToken || typeof fetchImpl !== 'function') throw new Error('成长任务接取参数不完整');
  if (!codes.length || codes.length > 20 || new Set(codes).size !== codes.length || codes.some((code) => !TASK_CODE_PATTERN.test(code))) {
    throw new Error('任务码无效');
  }
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${apiHost}/activity/growth/tasks/accept`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { ...requestHeaders(apiHost, accessToken), 'content-type': 'application/json' },
      body: JSON.stringify({ task_codes: codes }),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch (_) { throw new Error('成长任务接取接口返回了无法解析的数据'); }
    if (!response.ok) throw new Error(payload.msg || `成长任务接取接口 HTTP ${response.status}`);
    if (payload.code !== 0) throw new Error(payload.msg || `成长任务接取接口 code=${payload.code}`);
    return payload.data && typeof payload.data === 'object' ? payload.data : {};
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('成长任务接取请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function claimBuddyTravelReward(accessToken, options = {}) {
  const apiHost = String(options.apiHost || 'https://www.codebuddy.cn').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!accessToken || typeof fetchImpl !== 'function') throw new Error('Buddy 旅行领奖参数不完整');
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${apiHost}/activity/growth/buddy/travel/claim`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { ...requestHeaders(apiHost, accessToken), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch (_) { throw new Error('Buddy 旅行领奖接口返回了无法解析的数据'); }
    if (!response.ok) throw new Error(payload.msg || `Buddy 旅行领奖接口 HTTP ${response.status}`);
    if (payload.code !== 0) throw new Error(payload.msg || `Buddy 旅行领奖接口 code=${payload.code}`);
    return payload.data && typeof payload.data === 'object' ? payload.data : {};
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('Buddy 旅行领奖请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function departBuddyTravel(accessToken, options = {}) {
  const apiHost = String(options.apiHost || 'https://www.codebuddy.cn').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!accessToken || typeof fetchImpl !== 'function') throw new Error('Buddy 旅行派出参数不完整');
  const requestOptions = {
    fetchImpl,
    timeoutMs: Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : REQUEST_TIMEOUT_MS,
  };
  const config = await fetchJson(apiHost, accessToken, ['/v2/activity/growth/buddy/travel/config'], requestOptions);
  const locations = Array.isArray(config.locations) ? config.locations : [];
  const location = locations.find((item) => item && (typeof item.id === 'string' || typeof item.id === 'number'));
  if (!location) throw new Error('暂无可用旅行地点');
  return postGrowthJson(accessToken, '/v2/activity/growth/buddy/travel/depart', { location_id: location.id }, '派出 Buddy 旅行', {
    apiHost,
    fetchImpl,
    timeoutMs: requestOptions.timeoutMs,
  });
}

async function selectCurrentBuddy(accessToken, instanceId, options = {}) {
  const id = Number(instanceId);
  if (!Number.isSafeInteger(id) || id <= 0 || String(instanceId).trim() !== String(id)) throw new Error('Buddy 编号无效');
  return postGrowthJson(accessToken, '/activity/growth/buddy/switch', { instance_id: id }, '选择 Buddy', options);
}

async function fetchDailyProgress(accessToken, options = {}) {
  const apiHost = String(options.apiHost || 'https://www.codebuddy.cn').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  if (!accessToken || typeof fetchImpl !== 'function') throw new Error('成长中心查询参数不完整');
  const requestOptions = {
    fetchImpl,
    timeoutMs: Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : REQUEST_TIMEOUT_MS,
  };
  const [taskData, travel, buddyInfo, buddyList, gacha, lottery] = await Promise.all([
    fetchJson(apiHost, accessToken, ['/v2/activity/growth/tasks', '/activity/growth/tasks'], requestOptions),
    fetchJson(apiHost, accessToken, ['/activity/growth/buddy/travel/status', '/v2/activity/growth/buddy/travel/status'], requestOptions),
    fetchOptionalJson(apiHost, accessToken, ['/activity/growth/buddy/info'], requestOptions),
    fetchOptionalJson(apiHost, accessToken, ['/activity/growth/buddy/list'], requestOptions),
    fetchOptionalJson(apiHost, accessToken, ['/activity/growth/buddy/quota'], requestOptions),
    fetchOptionalJson(apiHost, accessToken, ['/activity/growth/lottery/chances'], requestOptions),
  ]);
  const buddyKnown = buddyInfo !== null || buddyList !== null;
  const buddyRows = buddyList && Array.isArray(buddyList.buddies) ? buddyList.buddies : [];
  const hasBuddy = !!(buddyInfo && buddyInfo.buddy) || buddyRows.length > 0;
  const activeBuddy = !!(buddyInfo && buddyInfo.buddy) || buddyRows.some((buddy) => buddy && (buddy.current_buddy === true || buddy.current_buddy === 1));
  const buddies = buddyRows.filter((buddy) => buddy && Number.isSafeInteger(Number(buddy.instance_id)) && Number(buddy.instance_id) > 0)
    .map((buddy) => ({ instanceId: Number(buddy.instance_id), name: boundedText(buddy.name, 80) || 'Buddy' }));
  const allTasks = Array.isArray(taskData.tasks) ? taskData.tasks : [];
  const hasVersionedTaskCodes = allTasks.some((task) => task && typeof task.task_code === 'string');
  const visibleTasks = buddyKnown && !hasBuddy && hasVersionedTaskCodes
    ? allTasks.filter((task) => LOCKED_BUDDY_TASK_CODES.has(String(task && task.task_code || '')))
    : allTasks;
  return normalizeDailyProgress(visibleTasks, { ...travel, available: buddyKnown ? hasBuddy : undefined }, {
    fetchedAt: now(),
    buddyKnown,
    activeBuddy,
    buddies,
    gacha,
    lottery,
  });
}

function createDailyProgressCache(load, options = {}) {
  const now = options.now || Date.now;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 60000;
  const entries = new Map();
  const pending = new Map();
  const get = (uid, detail = {}) => {
    const hit = entries.get(uid);
    if (!detail.force && hit && now() < hit.expiresAt) return Promise.resolve(hit.value);
    if (pending.has(uid)) return pending.get(uid);
    const request = Promise.resolve().then(() => load(uid)).then((value) => {
      entries.set(uid, { value, expiresAt: now() + ttlMs });
      if (entries.size > 500) entries.delete(entries.keys().next().value);
      return value;
    }).finally(() => pending.delete(uid));
    pending.set(uid, request);
    return request;
  };
  return { get, peek: (uid) => entries.get(uid) && entries.get(uid).value || null, clear: (uid) => entries.delete(uid) };
}

module.exports = {
  AUTOMATABLE_TASK_CODES,
  acceptGrowthTasks,
  claimBuddyTravelReward,
  claimFirstBuddy,
  createDailyProgressCache,
  departBuddyTravel,
  drawGrowthLottery,
  fetchDailyProgress,
  normalizeDailyProgress,
  openBuddyBlindBox,
  selectCurrentBuddy,
  summarizeGrowthActionReward,
};
