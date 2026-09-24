'use strict';

const TASK_KEY = /^[0-9a-f]{64}$/i;
const CACHE_TTL_MS = 20 * 1000;
const DEFAULT_ENDPOINT = 'https://workdaddy.dev/api/automation-likes';

function normalizeKeys(tasks) {
  return [...new Set((Array.isArray(tasks) ? tasks : []).map(task => String(task && task.key || '').trim().toLowerCase()).filter(key => TASK_KEY.test(key)))];
}

function normalizeResult(keys, payload) {
  const source = payload && payload.favorites && typeof payload.favorites === 'object' ? payload.favorites : {};
  return Object.fromEntries(keys.map(key => {
    const item = source[key] || {};
    return [key, { count: Math.max(0, Number(item.count) || 0), favorited: item.favorited === true }];
  }));
}

function decorateCatalog(catalog, favorites) {
  const tasks = Array.isArray(catalog && catalog.tasks) ? catalog.tasks : [];
  return {
    ...(catalog || {}),
    tasks: tasks.map(task => {
      const item = favorites[String(task.key || '').toLowerCase()] || {};
      return { ...task, favoriteCount: Math.max(0, Number(item.count) || 0), favorited: item.favorited === true };
    }),
  };
}

function createAutomationLikesClient(options = {}) {
  const endpoint = String(options.endpoint || process.env.WORKDADDY_AUTOMATION_LIKES_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getActorId = options.getActorId || (() => null);
  let cache = null;
  let lastFavorites = {};

  function actorHeaders() {
    const actor = String(getActorId() || '').trim().toLowerCase();
    return actor ? { 'X-WorkDaddy-Actor': actor } : {};
  }

  async function request(url, init = {}) {
    const response = await fetchImpl(url, { ...init, headers: { Accept: 'application/json', ...(init.headers || {}) } });
    let body = null;
    try { body = await response.json(); } catch (_) {}
    if (!response.ok || !body || body.ok === false) throw new Error(body && body.error || '收藏服务暂时不可用');
    return body;
  }

  async function getFavorites(tasks) {
    const keys = normalizeKeys(tasks);
    if (!keys.length) return {};
    const signature = keys.join(',');
    if (cache && cache.signature === signature && cache.expiresAt > Date.now()) return cache.value;
    const url = endpoint + '?keys=' + encodeURIComponent(signature);
    const value = normalizeResult(keys, await request(url, { headers: actorHeaders() }));
    cache = { signature, value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  }

  async function decorate(catalog) {
    try {
      lastFavorites = await getFavorites(catalog && catalog.tasks);
      return decorateCatalog(catalog, lastFavorites);
    } catch (_) { return decorateCatalog(catalog, lastFavorites); }
  }

  async function toggle(taskKey, favorite) {
    const key = String(taskKey || '').trim().toLowerCase();
    if (!TASK_KEY.test(key) || typeof favorite !== 'boolean') throw new Error('收藏任务参数无效');
    const result = await request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...actorHeaders() },
      body: JSON.stringify({ taskKey: key, favorite }),
    });
    cache = null;
    return { taskKey: key, favoriteCount: Math.max(0, Number(result.favoriteCount) || 0), favorited: result.favorited === true };
  }

  return { getFavorites, decorate, toggle, normalizeKeys };
}

module.exports = { CACHE_TTL_MS, createAutomationLikesClient, decorateCatalog, normalizeKeys };
