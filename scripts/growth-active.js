'use strict';

const GROWTH_ACTIVE_TIMEOUT_MS = 12000;

/**
 * 查询指定账号今日是否活跃（WorkBuddy 成长中心活跃地图）。
 * 复用签到/积分的 Bearer 鉴权与 profile 归属域名（国内 www.workbuddy.cn / 国际 www.workbuddy.ai）。
 * 返回 { is_active, date, score, status_text }；失败抛 Error。
 */
async function fetchGrowthTodayActive(accessToken, options = {}) {
  const apiHost = String(options.apiHost || 'https://www.workbuddy.cn').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : GROWTH_ACTIVE_TIMEOUT_MS;
  if (!accessToken || typeof fetchImpl !== 'function') {
    throw new Error('成长活跃查询参数不完整');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${apiHost}/activity/growth/heatmap`, {
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        'x-client-platform': 'web',
        origin: apiHost,
        referer: `${apiHost}/profile/growth-center`,
        authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      throw new Error('成长活跃接口返回了无法解析的数据');
    }
    if (!response.ok) throw new Error(`成长活跃接口 HTTP ${response.status}`);
    if (payload.code !== 0 && payload.code !== undefined && payload.code !== null) {
      throw new Error(payload.msg || `成长活跃接口 code=${payload.code}`);
    }
    const today = payload.data && typeof payload.data === 'object' ? payload.data.today : null;
    if (!today || typeof today !== 'object') throw new Error('成长活跃接口缺少 data.today');
    return {
      is_active: today.is_active === true,
      date: typeof today.date === 'string' ? today.date : null,
      score: Number.isFinite(Number(today.score)) ? Number(today.score) : null,
      status_text: typeof today.status_text === 'string' ? today.status_text : '',
    };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('成长活跃接口请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchGrowthTodayActive };
