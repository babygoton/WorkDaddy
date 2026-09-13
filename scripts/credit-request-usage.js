'use strict';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 8000;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatLocalDateTime(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function startOfLocalDay(date) {
  const result = new Date(date.getTime());
  result.setHours(0, 0, 0, 0);
  return result;
}

function parseRequestTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value).replace(/^(\d{4}-\d\d-\d\d)\s+/, '$1T'));
  return Number.isFinite(parsed) ? parsed : null;
}

function localDateString(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function safeText(value, maxLength = 200) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\0/g, '').slice(0, maxLength);
}

function normalizeUsageRow(row) {
  if (!row || typeof row !== 'object') throw new Error('用量记录不是对象');
  const requestId = safeText(row.requestId, 512).trim();
  const requestTime = parseRequestTime(row.requestTime);
  const credit = Number(row.credit);
  if (!requestId) throw new Error('用量记录缺少 requestId');
  if (requestTime === null) throw new Error(`用量记录 ${requestId.slice(0, 12)} 缺少有效 requestTime`);
  if (!Number.isFinite(credit) || credit < 0) throw new Error(`用量记录 ${requestId.slice(0, 12)} 的 credit 无效`);
  return {
    requestId,
    requestTime,
    usageDate: localDateString(requestTime),
    credit,
    model: safeText(row.model),
    client: safeText(row.client),
    agentPurpose: safeText(row.agentPurpose),
  };
}

async function fetchUsagePage(options) {
  const {
    accessToken,
    apiHost,
    startTime,
    endTime,
    pageNum,
    pageSize,
    fetchImpl,
    requestTimeoutMs,
  } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(`${apiHost}/billing/meter/get-user-request-usage`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'x-client-platform': 'web',
        origin: apiHost,
        referer: `${apiHost}/profile/plans-usage`,
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        startTime: formatLocalDateTime(startTime),
        endTime: formatLocalDateTime(endTime),
        pageNum,
        pageSize,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      throw new Error('官方用量接口返回了无法解析的数据');
    }
    if (!response.ok) throw new Error(`官方用量接口 HTTP ${response.status}`);
    if (payload.code !== 0 && payload.code !== undefined && payload.code !== null) {
      throw new Error(payload.msg || `官方用量接口 code=${payload.code}`);
    }
    const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
    const total = data && Number(data.total);
    if (!data || !Number.isSafeInteger(total) || total < 0 || !Array.isArray(data.data)) {
      throw new Error('官方用量接口分页结构无效');
    }
    return { total, rows: data.data };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('官方用量接口请求超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchUsageSinceAnchor(options = {}) {
  const accessToken = String(options.accessToken || '');
  const apiHost = String(options.apiHost || '').replace(/\/$/, '');
  const startTime = options.startTime instanceof Date ? options.startTime : null;
  const endTime = options.endTime instanceof Date ? options.endTime : null;
  const anchorRequestId = safeText(options.anchorRequestId, 512).trim();
  const pageSize = Number.isSafeInteger(options.pageSize) && options.pageSize > 0
    ? options.pageSize
    : DEFAULT_PAGE_SIZE;
  const maxPages = Number.isSafeInteger(options.maxPages) && options.maxPages > 0
    ? options.maxPages
    : DEFAULT_MAX_PAGES;
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) && options.requestTimeoutMs > 0
    ? Number(options.requestTimeoutMs)
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!accessToken || !apiHost || !startTime || !endTime || typeof fetchImpl !== 'function') {
    throw new Error('官方用量查询参数不完整');
  }
  if (startTime.getTime() > endTime.getTime()) throw new Error('官方用量查询时间范围无效');

  const records = [];
  let newestRequestId = '';
  let previousRequestTime = Infinity;
  let expectedTotal = null;
  let fetchedRows = 0;
  let reachedAnchor = false;

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const page = await fetchUsagePage({
      accessToken,
      apiHost,
      startTime,
      endTime,
      pageNum,
      pageSize,
      fetchImpl,
      requestTimeoutMs,
    });
    if (expectedTotal === null) expectedTotal = page.total;
    else if (page.total !== expectedTotal) throw new Error('官方用量接口分页总数发生变化');
    if (typeof options.onProgress === 'function') options.onProgress({
      page: pageNum, pages: Math.max(pageNum, Math.ceil(expectedTotal / pageSize)),
      records: fetchedRows + page.rows.length, total: expectedTotal,
    });
    if (!page.rows.length) {
      if (fetchedRows >= expectedTotal) {
        return { records, newestRequestId, total: expectedTotal, pages: pageNum, reachedAnchor };
      }
      throw new Error(`官方用量分页不完整: 已读取 ${fetchedRows}/${expectedTotal}`);
    }

    for (const raw of page.rows) {
      const record = normalizeUsageRow(raw);
      if (record.requestTime > previousRequestTime) {
        throw new Error('官方用量记录未按时间倒序返回');
      }
      previousRequestTime = record.requestTime;
      if (!newestRequestId) newestRequestId = record.requestId;
      if (anchorRequestId && record.requestId === anchorRequestId) {
        reachedAnchor = true;
        break;
      }
      records.push(record);
    }
    if (reachedAnchor) {
      return { records, newestRequestId, total: expectedTotal, pages: pageNum, reachedAnchor: true };
    }
    fetchedRows += page.rows.length;
    if (fetchedRows >= expectedTotal) {
      return { records, newestRequestId, total: expectedTotal, pages: pageNum, reachedAnchor: false };
    }
  }
  throw new Error(`官方用量分页不完整: 超过 ${maxPages} 页`);
}

module.exports = {
  fetchUsageSinceAnchor,
  formatLocalDateTime,
  normalizeUsageRow,
  parseRequestTime,
  startOfLocalDay,
};
