'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { replaceFileWithRetry } = require('./atomic-file-write');
const { previewPackage } = require('./automation-packages');
const { SCHEMA_VERSION } = require('./automation');

const DISCOVERY_MARKER = 'WorkDaddyAutomationRepository';
const CACHE_VERSION = 3;
const CACHE_TTL_MS = 10 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_REPOSITORIES = 1000;
const MAX_TASKS_PER_REPOSITORY = 200;
const MAX_TASK_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const GITEE_WIDGET = 'wong1slagnlmzwvsu5ya';
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function documentIdentity(content) {
  const document = JSON.parse(String(content).replace(/^\uFEFF/, ''));
  const canonical = canonicalJson(document);
  return { document, key: crypto.createHash('sha256').update(canonical).digest('hex') };
}

function emptyCache() {
  return { version: CACHE_VERSION, checkedAt: 0, refreshedAt: 0, providers: { github: [], gitee: [] }, repositories: {}, errors: [] };
}

function readCache(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 32 * 1024 * 1024) return emptyCache();
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value && value.version === 2 && value.providers && value.repositories) {
      return { ...value, version: CACHE_VERSION, checkedAt: 0, providers: { github: [], gitee: value.providers.gitee || [] } };
    }
    if (!value || value.version !== CACHE_VERSION || !value.providers || !value.repositories) return emptyCache();
    return value;
  } catch (_) {
    return emptyCache();
  }
}

function writeCache(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  replaceFileWithRetry(file, JSON.stringify(value) + '\n', 0o600);
}

async function readBounded(response, limit) {
  const declared = Number(response.headers && response.headers.get && response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('远程响应超过大小限制');
  if (!response.body || typeof response.body.getReader !== 'function') {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) throw new Error('远程响应超过大小限制');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('远程响应超过大小限制');
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (size > limit) await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, size);
}

async function request(fetchImpl, url, options = {}) {
  const allowedHosts = options.allowedHosts || [];
  let target = new URL(url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!allowedHosts.includes(target.hostname) || options.validateUrl && !options.validateUrl(target)) throw new Error('不受信任的远程地址');
    const response = await fetchImpl(target.toString(), {
      headers: { Accept: options.accept || 'application/json', 'User-Agent': 'WorkDaddy-Automation-Discovery' },
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs || REQUEST_TIMEOUT_MS),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 3) throw new Error('远程请求跳转次数过多');
      const location = response.headers && response.headers.get && response.headers.get('location');
      if (!location) throw new Error('远程请求跳转地址无效');
      target = new URL(location, target);
      continue;
    }
    if (!response.ok) throw new Error('远程请求失败 (' + response.status + ')');
    if (response.url) {
      const finalUrl = new URL(response.url);
      if (!allowedHosts.includes(finalUrl.hostname) || options.validateUrl && !options.validateUrl(finalUrl)) throw new Error('远程请求跳转到不受信任的地址');
    }
    return readBounded(response, options.limit || MAX_JSON_BYTES);
  }
  throw new Error('远程请求跳转次数过多');
}

async function requestJson(fetchImpl, url, allowedHosts, options = {}) {
  const bytes = await request(fetchImpl, url, { allowedHosts, limit: MAX_JSON_BYTES, ...options });
  return JSON.parse(bytes.toString('utf8'));
}

function githubRepository(item, marker) {
  if (!String(item && item.description || '').includes(marker)) return null;
  const fullName = String(item.full_name || '');
  if (!REPOSITORY_NAME.test(fullName) || item.html_url !== 'https://github.com/' + fullName) return null;
  return {
    key: 'github:' + fullName.toLowerCase(), platform: 'github', fullName,
    repositoryUrl: item.html_url,
    stars: Math.max(0, Number(item.stargazers_count) || 0),
    pushedAt: String(item.pushed_at || ''), defaultBranch: String(item.default_branch || 'main'),
  };
}

async function searchGitHub(fetchImpl, marker, pageSize) {
  const repositories = [];
  for (let page = 1; repositories.length < MAX_REPOSITORIES; page++) {
    const url = new URL('https://api.github.com/search/repositories');
    url.searchParams.set('q', marker + ' in:description');
    url.searchParams.set('per_page', String(Math.min(100, pageSize)));
    url.searchParams.set('page', String(page));
    const result = await requestJson(fetchImpl, url, ['api.github.com'], { timeoutMs: 25000 });
    if (!result || !Array.isArray(result.items)) throw new Error('GitHub 搜索结果无效');
    result.items.forEach(item => { const repo = githubRepository(item, marker); if (repo) repositories.push(repo); });
    if (result.items.length < Math.min(100, pageSize) || page * Math.min(100, pageSize) >= Math.min(MAX_REPOSITORIES, Number(result.total_count) || 0)) break;
  }
  return repositories.slice(0, MAX_REPOSITORIES);
}

function giteeRepository(hit, marker) {
  const fields = hit && hit.fields || {};
  if (!String(fields.description && fields.description[0] || '').includes(marker)) return null;
  const fullName = String(fields.title && fields.title[0] || '');
  if (!REPOSITORY_NAME.test(fullName)) return null;
  const repositoryUrl = 'https://gitee.com/' + fullName;
  if (String(fields.url && fields.url[0] || '') !== repositoryUrl) return null;
  return {
    key: 'gitee:' + fullName.toLowerCase(), platform: 'gitee', fullName, repositoryUrl,
    stars: Math.max(0, Number(fields['count.star'] && fields['count.star'][0]) || 0),
    pushedAt: String(fields.last_push_at && fields.last_push_at[0] || ''), defaultBranch: '',
  };
}

async function searchGitee(fetchImpl, marker, pageSize) {
  const repositories = [];
  for (let from = 0; repositories.length < MAX_REPOSITORIES; from += pageSize) {
    const url = new URL('https://so.gitee.com/v1/search/widget/' + GITEE_WIDGET);
    url.searchParams.set('q', marker);
    url.searchParams.set('from', String(from));
    url.searchParams.set('size', String(pageSize));
    const result = await requestJson(fetchImpl, url, ['so.gitee.com']);
    const hits = result && result.hits;
    if (!hits || !Array.isArray(hits.hits)) throw new Error('Gitee 搜索结果无效');
    hits.hits.forEach(hit => { const repo = giteeRepository(hit, marker); if (repo) repositories.push(repo); });
    const total = Number(hits.total && hits.total.value) || 0;
    const exact = hits.total && hits.total.relation === 'eq';
    if (hits.hits.length < pageSize || exact && from + hits.hits.length >= total) break;
  }
  return repositories.slice(0, MAX_REPOSITORIES);
}

function encodeRepository(fullName) {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

function encodeRemotePath(value) {
  return String(value).split('/').map(encodeURIComponent).join('/');
}

function fallbackDownloadUrl(repository, taskPath) {
  const branch = encodeRemotePath(repository.defaultBranch || 'main');
  const remotePath = encodeRemotePath(taskPath);
  return 'https://gitee.com/' + encodeRepository(repository.fullName) + '/raw/' + branch + '/' + remotePath;
}

function safeDownloadUrl(repository, entry) {
  const candidate = String(entry.download_url || fallbackDownloadUrl(repository, entry.path));
  let parsed;
  try { parsed = new URL(candidate); } catch (_) { throw new Error('任务下载地址无效'); }
  const prefix = '/' + repository.fullName + '/';
  const valid = parsed.protocol === 'https:' && parsed.hostname === 'gitee.com' && parsed.pathname.startsWith(prefix) && parsed.pathname.includes('/raw/');
  if (!valid) throw new Error('任务下载地址不受信任');
  return parsed.toString();
}

function safeGithubDownloadUrl(repository, entry) {
  const fallback = 'https://raw.githubusercontent.com/' + encodeRepository(repository.fullName) + '/' + encodeURIComponent(repository.defaultBranch || 'main') + '/' + encodeRemotePath(entry.path);
  const candidate = new URL(String(entry.download_url || fallback));
  const prefix = '/' + repository.fullName + '/';
  const suffix = '/' + encodeRemotePath(entry.path);
  if (candidate.protocol !== 'https:' || candidate.hostname !== 'raw.githubusercontent.com' ||
      candidate.search || candidate.hash || !candidate.pathname.startsWith(prefix) ||
      !candidate.pathname.endsWith(suffix) || candidate.pathname.length <= prefix.length + suffix.length) {
    throw new Error('任务下载地址不受信任');
  }
  return candidate.toString();
}

function trustedTaskUrl(repository, url) {
  const prefix = '/' + repository.fullName + '/';
  return url.protocol === 'https:' && ['gitee.com', 'raw.giteeusercontent.com'].includes(url.hostname) && url.pathname.startsWith(prefix) && url.pathname.includes('/raw/');
}

async function scanRepository(fetchImpl, repository) {
  const github = repository.platform === 'github';
  const listing = await requestJson(fetchImpl, github
    ? 'https://api.github.com/repos/' + encodeRepository(repository.fullName) + '/contents/tasks?ref=' + encodeURIComponent(repository.defaultBranch || 'main')
    : 'https://gitee.com/api/v5/repos/' + encodeRepository(repository.fullName) + '/contents/tasks',
  [github ? 'api.github.com' : 'gitee.com'], github ? { timeoutMs: 25000 } : {});
  if (!Array.isArray(listing)) throw new Error('仓库 tasks 目录无效');
  const entries = listing.filter(entry => entry && entry.type === 'file' && /\.json$/i.test(entry.name || '') &&
    !/[\\/]/.test(entry.name) && entry.path === 'tasks/' + entry.name).slice(0, MAX_TASKS_PER_REPOSITORY);
  const tasks = [];
  for (const entry of entries) {
    const downloadUrl = github ? safeGithubDownloadUrl(repository, entry) : safeDownloadUrl(repository, entry);
    const allowedHosts = github ? ['raw.githubusercontent.com'] : ['gitee.com', 'raw.giteeusercontent.com'];
    const trusted = github
      ? url => url.protocol === 'https:' && url.hostname === 'raw.githubusercontent.com' && url.pathname === new URL(downloadUrl).pathname
      : url => trustedTaskUrl(repository, url);
    const content = (await request(fetchImpl, downloadUrl, { allowedHosts, validateUrl: trusted, accept: 'application/json,text/plain', limit: MAX_TASK_BYTES, timeoutMs: github ? 25000 : REQUEST_TIMEOUT_MS })).toString('utf8');
    tasks.push({ path: String(entry.path || 'tasks/' + entry.name), downloadUrl, content });
  }
  return tasks;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

function catalogFromState(state, runtime) {
  const merged = new Map();
  for (const repository of Object.values(state.repositories || {})) {
    for (const file of repository.tasks || []) {
      try {
        const identity = documentIdentity(file.content);
        const preview = previewPackage(file.content, { runtime });
        if (!preview.task) continue;
        const document = identity.document;
        const definition = document.kind ? document.task : document.task || document;
        const item = merged.get(identity.key) || {
          key: identity.key,
          name: String(document.name || preview.task.name || file.path).slice(0, 120),
          description: String(document.description || preview.task.description || '').slice(0, 1000),
          compatible: preview.compatible,
          issues: preview.issues || [],
          schemaVersion: definition.schemaVersion == null ? 1 : definition.schemaVersion,
          stars: 0,
          sources: [],
        };
        if (!item.sources.some(source => source.platform === repository.platform && source.repository === repository.fullName)) {
          item.sources.push({
            platform: repository.platform,
            repository: repository.fullName,
            repositoryUrl: repository.repositoryUrl,
            fileUrl: file.downloadUrl,
            path: file.path,
            stars: repository.stars,
          });
          item.stars += repository.stars;
        }
        merged.set(identity.key, item);
      } catch (_) {}
    }
  }
  return [...merged.values()].sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name, 'zh-CN'));
}

function createAutomationDiscovery(options) {
  const dataDir = options.dataDir;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const marker = options.marker || DISCOVERY_MARKER;
  const pageSize = options.pageSize || PAGE_SIZE;
  const runtime = options.runtime || {};
  const cacheFile = path.join(dataDir, 'automation-discovery-cache.json');
  let state = readCache(cacheFile);
  let inFlight = null;

  function publicCatalog() {
    return {
      marker,
      schemaVersion: SCHEMA_VERSION,
      loading: false,
      stale: !!(state.errors && state.errors.length),
      checkedAt: Number(state.checkedAt) || 0,
      refreshedAt: Number(state.refreshedAt) || 0,
      errors: Array.isArray(state.errors) ? state.errors : [],
      tasks: catalogFromState(state, runtime),
    };
  }

  async function refresh() {
    const errors = [];
    const search = await Promise.allSettled([searchGitHub(fetchImpl, marker, pageSize), searchGitee(fetchImpl, marker, pageSize)]);
    const providers = { github: state.providers.github || [], gitee: state.providers.gitee || [] };
    for (const [index, platform] of ['github', 'gitee'].entries()) {
      if (search[index].status === 'fulfilled') providers[platform] = search[index].value;
      else errors.push({ platform, message: String(search[index].reason && search[index].reason.message || search[index].reason) });
    }
    const repositories = {};
    const allRepositories = [...providers.github, ...providers.gitee];
    await mapLimit(allRepositories, 4, async repository => {
      const cached = state.repositories && state.repositories[repository.key];
      let tasks = cached && cached.pushedAt === repository.pushedAt && Array.isArray(cached.tasks) ? cached.tasks : null;
      if (!tasks) {
        try { tasks = await scanRepository(fetchImpl, repository); }
        catch (error) {
          errors.push({ platform: repository.platform, repository: repository.fullName, message: String(error.message || error) });
          tasks = cached && Array.isArray(cached.tasks) ? cached.tasks : [];
        }
      }
      repositories[repository.key] = { ...repository, tasks };
    });
    const searchSucceeded = search.some(result => result.status === 'fulfilled');
    state = {
      version: CACHE_VERSION,
      checkedAt: now(),
      refreshedAt: searchSucceeded ? now() : Number(state.refreshedAt) || 0,
      providers,
      repositories,
      errors,
    };
    writeCache(cacheFile, state);
    return publicCatalog();
  }

  async function getCatalog() {
    if (now() - Number(state.checkedAt || 0) < CACHE_TTL_MS) return publicCatalog();
    if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
    return inFlight;
  }

  function getTaskContent(key) {
    const wanted = String(key || '');
    for (const repository of Object.values(state.repositories || {})) {
      for (const file of repository.tasks || []) {
        try { if (documentIdentity(file.content).key === wanted) return file.content; } catch (_) {}
      }
    }
    throw new Error('公开任务不存在或缓存已更新');
  }

  return { getCatalog, getTaskContent };
}

module.exports = {
  DISCOVERY_MARKER,
  CACHE_TTL_MS,
  createAutomationDiscovery,
  documentIdentity,
};
