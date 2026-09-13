'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fetchUsageSinceAnchor, startOfLocalDay } = require('./credit-request-usage.js');

function dateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function historyRange(days = 7, now = new Date()) {
  days = Number(days);
  if (!Number.isSafeInteger(days) || days < 1) throw new Error('用量日期范围无效');
  days = Math.min(90, days);
  const endTime = new Date(now);
  const startTime = startOfLocalDay(endTime);
  startTime.setDate(startTime.getDate() - days + 1);
  return { days, startTime, endTime, from: dateString(startTime), to: dateString(endTime) };
}

// Only validated daily API totals are persisted, including verified zero days.
// Today's snapshot expires briefly; after midnight its unfinished day is fetched
// once more before becoming immutable history. Never reuse the today-usage anchor.
function createCreditHistorySync(options) {
  const cache = new Map();
  const clock = options.now || (() => new Date());
  const todayTtl = options.todayTtlMs || 60000;
  const key = (uid, date) => uid + ':' + date;
  try {
    const stored = JSON.parse(fs.readFileSync(options.cacheFile, 'utf8'));
    if (stored.version === 1 && Array.isArray(stored.daily)) for (const row of stored.daily) {
      if (typeof row.uid !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(row.date) ||
          !Number.isFinite(row.used) || row.used < 0 || !Number.isSafeInteger(row.count) || row.count < 0 ||
          !Number.isFinite(row.queriedAt) || typeof row.final !== 'boolean') continue;
      cache.set(key(row.uid, row.date), row);
    }
  } catch (_) { /* Absent or invalid cache: query the official API. */ }
  function persist() {
    if (!options.cacheFile) return;
    const tmp = options.cacheFile + '.tmp';
    try {
      fs.mkdirSync(path.dirname(options.cacheFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, daily: Array.from(cache.values()) }), { mode: 0o600 });
      fs.renameSync(tmp, options.cacheFile);
    } catch (_) { /* In-memory results remain usable if disk is unavailable. */ }
  }
  let job = null;
  let completion = Promise.resolve({ running: false });
  function status() { return job ? JSON.parse(JSON.stringify(job)) : { running: false }; }
  function start({ accounts, days }) {
    const range = historyRange(days, clock());
    const selected = Array.from(new Map(accounts.map(a => [a.uid, { uid: a.uid, nickname: a.nickname || a.uid }])).values());
    const sameScope = job && job.from === range.from && job.to === range.to &&
      job.accounts.map(a => a.uid).sort().join(',') === selected.map(a => a.uid).sort().join(',');
    if (job && job.running) {
      if (sameScope) return status();
      const error = new Error('另一个积分查询正在进行，请稍后重试');
      error.status = 409;
      throw error;
    }
    const cutoff = historyRange(90, range.endTime).from;
    for (const [id, row] of cache) if (row.date < cutoff || row.queriedAt > range.endTime.getTime()) cache.delete(id);
    const dates = [];
    for (const date = new Date(range.startTime); date <= range.endTime; date.setDate(date.getDate() + 1)) dates.push(new Date(date));
    const fresh = row => row && (row.final || (row.date === range.to && range.endTime.getTime() - row.queriedAt < todayTtl));
    const plans = selected.map(account => {
      const gaps = [];
      for (const date of dates) {
        if (fresh(cache.get(key(account.uid, dateString(date))))) continue;
        const end = new Date(date); end.setDate(end.getDate() + 1); end.setSeconds(end.getSeconds() - 1);
        const endTime = new Date(Math.min(end.getTime(), range.endTime.getTime()));
        const previous = gaps[gaps.length - 1];
        if (previous && previous.endTime.getTime() + 1000 === date.getTime()) previous.endTime = endTime;
        else gaps.push({ startTime: date, endTime });
      }
      return { account, gaps };
    });
    function readDaily() {
      return selected.flatMap(a => dates.map(date => cache.get(key(a.uid, dateString(date)))).filter(Boolean)
        .map(row => ({ uid: row.uid, date: row.date, used: row.used, count: row.count, complete: true })));
    }
    const initial = readDaily();
    const cacheHit = plans.every(plan => !plan.gaps.length);
    job = { id: randomUUID(), running: !cacheHit, from: range.from, to: range.to,
      source: 'server', accounts: selected, daily: initial, queriedAt: range.endTime.getTime(),
      cacheHit, hasCachedData: initial.length > 0, total: selected.length,
      completed: 0, synced: 0, failures: [], current: '', page: 0, pages: 0, records: 0, percent: 0 };
    const active = job;
    if (cacheHit) {
      Object.assign(active, { completed: selected.length, synced: selected.length, percent: 100 });
      completion = Promise.resolve(status());
      return status();
    }
    async function run() {
      for (const { account, gaps } of plans) {
        active.current = account.nickname;
        active.page = 0; active.pages = 0; active.records = 0;
        try {
          const accessToken = gaps.length ? await options.getAccessToken(account.uid) : '';
          if (gaps.length && !accessToken) throw new Error('账号凭据不可用');
          for (let i = 0; i < gaps.length; i++) {
            const gap = gaps[i];
            const result = await (options.fetchUsage || fetchUsageSinceAnchor)({
              accessToken, apiHost: options.apiHost, ...gap,
              onProgress: ({ page, pages, records }) => {
                active.page = page; active.pages = pages; active.records = records;
                active.percent = Math.min(99, Math.floor((active.completed + (i + (pages ? page / pages : 0)) / gaps.length) / active.total * 100));
              },
            });
            const daily = new Map();
            for (const date = new Date(gap.startTime); date <= gap.endTime; date.setDate(date.getDate() + 1)) {
              const day = dateString(date);
              daily.set(day, { uid: account.uid, date: day, used: 0, count: 0,
                queriedAt: range.endTime.getTime(), final: day < range.to });
            }
            const seen = new Set();
            for (const record of result.records) {
              const day = daily.get(record.usageDate);
              if (!day || seen.has(record.requestId)) continue;
              seen.add(record.requestId);
              day.used += record.credit; day.count++;
            }
            for (const day of daily.values()) {
              day.used = Math.round(day.used * 100) / 100;
              cache.set(key(day.uid, day.date), day);
            }
            persist();
          }
          active.synced++;
        } catch (error) {
          const text = String(error && error.message || '');
          const reason = /401|403|凭据|accessToken|token/i.test(text) ? '登录身份过期或不可用，请重新登录后重试' :
            /超时|timeout/i.test(text) ? '请求超时，请稍后重试' : '记录未完整获取，请稍后重试';
          active.failures.push({ uid: account.uid, nickname: account.nickname, error: reason });
        }
        active.daily = readDaily();
        active.completed++;
        active.percent = Math.floor(active.completed / active.total * 100);
      }
      active.running = false;
      active.current = '';
      active.percent = 100;
      return JSON.parse(JSON.stringify(active));
    }
    completion = run();
    return status();
  }
  return { start, status, wait: () => completion };
}

module.exports = { createCreditHistorySync, historyRange };
