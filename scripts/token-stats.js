'use strict';

const fs = require('fs');
const path = require('path');

const TOKEN_FIELDS = {
  input: ['input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokens'],
  output: ['output_tokens', 'completion_tokens', 'outputTokens', 'completionTokens'],
  cacheRead: ['cache_read_input_tokens', 'cache_read_tokens', 'cacheReadTokens', 'cached_tokens'],
  cacheWrite: ['cache_creation_input_tokens', 'cache_write_tokens', 'cacheWriteTokens'],
};

function numberField(value, fields) {
  for (const field of fields) {
    const number = Number(value && value[field]);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return 0;
}

function findUsage(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  const hasUsage = Object.values(TOKEN_FIELDS).some((fields) => fields.some((field) => value[field] !== undefined));
  if (hasUsage) return value;
  for (const child of Object.values(value)) {
    const found = findUsage(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function findText(value, fields, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return '';
  for (const field of fields) {
    if (typeof value[field] === 'string' && value[field].trim()) return value[field].trim();
  }
  for (const child of Object.values(value)) {
    const found = findText(child, fields, depth + 1);
    if (found) return found;
  }
  return '';
}

function walkJsonl(root, maxFiles = 5000) {
  const out = [];
  function walk(dir) {
    if (out.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name === 'subagents' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  }
  // Official session files live under projects; logs contain duplicate usage snapshots.
  const projects = path.join(root, 'projects');
  walk(fs.existsSync(projects) ? projects : root);
  return out;
}

function dayString(timestamp) {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function localDayString(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function timestampValue(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

const CACHE_VERSION = 7;
const MAX_CACHE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function dateBounds(now, options = {}) {
  const days = Math.max(1, Math.min(MAX_CACHE_DAYS, Number(options.days) || 7));
  const localStart = new Date(now); localStart.setHours(0, 0, 0, 0);
  localStart.setDate(localStart.getDate() - (days - 1));
  const defaultSince = localStart.getTime();
  const parsedFrom = options.from ? Date.parse(options.from) : NaN;
  const parsedUntil = options.until ? Date.parse(options.until) + DAY_MS - 1 : now;
  if (options.from && !Number.isFinite(parsedFrom)) throw new Error('开始日期无效');
  if (options.until && !Number.isFinite(parsedUntil)) throw new Error('结束日期无效');
  const from = Number.isFinite(parsedFrom) ? parsedFrom : defaultSince;
  const until = Number.isFinite(parsedUntil) ? Math.min(parsedUntil, now) : now;
  if (from > until) throw new Error('开始日期不能晚于结束日期');
  if (until - from > MAX_CACHE_DAYS * DAY_MS) throw new Error('日期范围不能超过 90 天');
  return { from, until, days };
}

function parseRecords(root, options = {}) {
  const now = Number(options.now) || Date.now();
  const lowerBound = Number.isFinite(options.lowerBound) ? options.lowerBound : now - MAX_CACHE_DAYS * DAY_MS;
  const upperBound = Number.isFinite(options.upperBound) ? options.upperBound : now + 60 * 1000;
  const files = Array.isArray(options.files) ? options.files : walkJsonl(root, options.maxFiles || 5000);
  const accountIds = new Set((options.accountOptions || []).map((item) => String(item && (item.uid || item.account) || '').trim()).filter(Boolean));
  const records = [];
  let parseErrors = 0;
  let parsedLines = 0;
  const parseErrorFiles = new Set();
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (options.skipUnchanged && options.knownFileState && options.knownFileState[relative]) {
      try {
        const stat = fs.statSync(file);
        const known = options.knownFileState[relative];
        if (Number(known.mtimeMs) === Number(stat.mtimeMs) && Number(known.size) === Number(stat.size)) continue;
      } catch (_) { continue; }
    }
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    let lineIndex = 0;
    for (const line of text.split(/\r?\n/)) {
      lineIndex++;
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch (_) {
        // Only object-like lines are likely structured records. WorkBuddy may
        // place plain text, stack traces, or array annotations in the same file.
        if (/^\s*\{/.test(line) && /"(?:usage|input_tokens|output_tokens|model)"/i.test(line)) {
          parseErrors++;
          parseErrorFiles.add(relative);
        }
        continue;
      }
      if (record.isSnapshotUpdate) continue;
      const usage = findUsage(record.message && record.message.usage) || findUsage(record.providerData && record.providerData.usage) || findUsage(record);
      if (!usage) continue;
      const timestamp = timestampValue(record.timestamp || record.created_at || record.createdAt || usage.timestamp, now);
      if (!Number.isFinite(timestamp) || timestamp < lowerBound || timestamp > upperBound) continue;
      const input = numberField(usage, TOKEN_FIELDS.input);
      const output = numberField(usage, TOKEN_FIELDS.output);
      const cacheRead = numberField(usage, TOKEN_FIELDS.cacheRead);
      const cacheWrite = numberField(usage, TOKEN_FIELDS.cacheWrite);
      if (!(input || output || cacheRead || cacheWrite)) continue;
      const model = findText(record, ['model', 'modelName', 'model_id', 'modelId']) || findText(usage, ['model', 'modelName', 'model_id', 'modelId']);
      let account = findText(record, ['accountUid', 'accountId', 'uid', 'userId']) || findText(usage, ['accountUid', 'accountId', 'uid', 'userId']);
      if (!account && options.sessionAccounts) {
        const sessionId = path.basename(file, '.jsonl');
        account = options.sessionAccounts instanceof Map
          ? String(options.sessionAccounts.get(sessionId) || '')
          : String(options.sessionAccounts[sessionId] || '');
      }
      if (!account && accountIds.size) {
        const pathPart = relative.split('/').find((part) => accountIds.has(part.replace(/\.jsonl$/i, '')));
        if (pathPart) account = pathPart.replace(/\.jsonl$/i, '');
      }
      records.push({
        key: relative + ':' + lineIndex,
        timestamp,
        model: model || '',
        account: account || '',
        input,
        output,
        cacheRead,
        cacheWrite,
        calls: 1,
      });
      parsedLines++;
    }
  }
  return { records, files: files.length, parsedLines, parseErrors, parseErrorFiles: Array.from(parseErrorFiles) };
}

function cacheFile(root, options = {}) {
  return options.cacheFile || path.join(root, '.workdaddy-token-stats-cache.json');
}

function readCache(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.version !== CACHE_VERSION || !Array.isArray(value.historicalBuckets) || !value.todayFiles || typeof value.todayFiles !== 'object') return null;
    return value;
  } catch (_) { return null; }
}

function usableCache(cache, now) {
  return !!cache && Number.isFinite(cache.generatedAt) && cache.generatedAt <= now &&
    Number.isFinite(cache.cutoff) && cache.cutoff <= dateBounds(now, { days: MAX_CACHE_DAYS }).from &&
    cache.timezone === Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function tokenStatsCacheReady(root, options = {}) {
  return usableCache(readCache(cacheFile(root, options)), Number(options.now) || Date.now());
}

function writeCache(file, payload) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (_) { return false; /* cache failure must not break statistics */ }
}

function aggregateRecords(records, options = {}) {
  const now = Number(options.now) || Date.now();
  const bounds = dateBounds(now, options);
  const accountFilter = String(options.account || '').trim();
  const modelFilter = String(options.model || '').trim();
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  const byDay = new Map();
  const byModel = new Map();
  const byAccount = new Map();
  for (const record of records) {
    if (!record || record.timestamp < bounds.from || record.timestamp > bounds.until) continue;
    if (accountFilter && record.account !== accountFilter) continue;
    if (modelFilter && record.model !== modelFilter) continue;
    const values = { input: Number(record.input) || 0, output: Number(record.output) || 0, cacheRead: Number(record.cacheRead) || 0, cacheWrite: Number(record.cacheWrite) || 0, calls: Number(record.calls) || 1 };
    for (const key of Object.keys(totals)) totals[key] += values[key];
    const day = localDayString(record.timestamp);
    if (day) {
      const row = byDay.get(day) || { day, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
      for (const key of Object.keys(values)) row[key] += values[key];
      byDay.set(day, row);
    }
    if (record.model) {
      const row = byModel.get(record.model) || { model: record.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
      for (const key of Object.keys(values)) row[key] += values[key];
      byModel.set(record.model, row);
    }
    if (record.account) {
      const row = byAccount.get(record.account) || { account: record.account, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
      for (const key of Object.keys(values)) row[key] += values[key];
      byAccount.set(record.account, row);
    }
  }
  const accountOptions = Array.isArray(options.accountOptions) ? options.accountOptions : [];
  for (const account of accountOptions) {
    const uid = String(account && (account.uid || account.account) || '').trim();
    if (!uid) continue;
    if (!byAccount.has(uid)) byAccount.set(uid, { account: uid, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, nickname: account.nickname || '' });
    else if (account.nickname) byAccount.get(uid).nickname = account.nickname;
  }
  return {
    source: 'local-workbuddy-jsonl',
    since: bounds.from,
    until: bounds.until,
    totals,
    daily: Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day)),
    models: Array.from(byModel.values()).sort((a, b) => (b.input + b.output) - (a.input + a.output)),
    accounts: Array.from(byAccount.values()).sort((a, b) => (b.input + b.output) - (a.input + a.output)),
  };
}

function aggregateBuckets(records) {
  const buckets = new Map();
  for (const record of records || []) {
    const day = localDayString(record.timestamp);
    if (!day) continue;
    const account = String(record.account || '');
    const model = String(record.model || '');
    const key = day + '\u0000' + account + '\u0000' + model;
    const bucket = buckets.get(key) || { day, account, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
    bucket.input += Number(record.input) || 0;
    bucket.output += Number(record.output) || 0;
    bucket.cacheRead += Number(record.cacheRead) || 0;
    bucket.cacheWrite += Number(record.cacheWrite) || 0;
    bucket.calls += Number(record.calls) || 1;
    buckets.set(key, bucket);
  }
  return Array.from(buckets.values());
}

function aggregateCachedBuckets(buckets, options = {}) {
  const now = Number(options.now) || Date.now();
  const bounds = dateBounds(now, options);
  const accountFilter = String(options.account || '').trim();
  const modelFilter = String(options.model || '').trim();
  const firstDay = localDayString(bounds.from);
  const lastDay = localDayString(bounds.until);
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  const byDay = new Map();
  const byModel = new Map();
  const byAccount = new Map();
  for (const bucket of buckets || []) {
    if (!bucket || !bucket.day) continue;
    if (bucket.day < firstDay || bucket.day > lastDay) continue;
    if (accountFilter && String(bucket.account || '') !== accountFilter) continue;
    if (modelFilter && String(bucket.model || '') !== modelFilter) continue;
    const values = {
      input: Number(bucket.input) || 0,
      output: Number(bucket.output) || 0,
      cacheRead: Number(bucket.cacheRead) || 0,
      cacheWrite: Number(bucket.cacheWrite) || 0,
      calls: Number(bucket.calls) || 0,
    };
    for (const key of Object.keys(totals)) totals[key] += values[key];
    const day = String(bucket.day);
    const dayRow = byDay.get(day) || { day, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
    for (const key of Object.keys(values)) dayRow[key] += values[key];
    byDay.set(day, dayRow);
    if (bucket.model) {
      const modelRow = byModel.get(bucket.model) || { model: bucket.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
      for (const key of Object.keys(values)) modelRow[key] += values[key];
      byModel.set(bucket.model, modelRow);
    }
    if (bucket.account) {
      const accountRow = byAccount.get(bucket.account) || { account: bucket.account, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
      for (const key of Object.keys(values)) accountRow[key] += values[key];
      byAccount.set(bucket.account, accountRow);
    }
  }
  const accountOptions = Array.isArray(options.accountOptions) ? options.accountOptions : [];
  for (const account of accountOptions) {
    const uid = String(account && (account.uid || account.account) || '').trim();
    if (!uid) continue;
    if (!byAccount.has(uid)) byAccount.set(uid, { account: uid, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, nickname: account.nickname || '' });
    else if (account.nickname) byAccount.get(uid).nickname = account.nickname;
  }
  return {
    source: 'local-workbuddy-jsonl', since: bounds.from, until: bounds.until, totals,
    daily: Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day)),
    models: Array.from(byModel.values()).sort((a, b) => (b.input + b.output) - (a.input + a.output)),
    accounts: Array.from(byAccount.values()).sort((a, b) => (b.input + b.output) - (a.input + a.output)),
  };
}

function scanTokenStatsCached(root, options = {}) {
  const now = Number(options.now) || Date.now();
  // Always cache the complete retained range, independent of the UI filter.
  // Each file owns its buckets: replacing a changed file cannot drop another
  // file's usage on the same date or count immutable/live history twice.
  const cutoff = dateBounds(now, { days: MAX_CACHE_DAYS }).from;
  const file = cacheFile(root, options);
  const cache = readCache(file);
  const hadValidCache = usableCache(cache, now);
  const currentFiles = walkJsonl(root, options.maxFiles || 5000);
  const todayFiles = {};
  let parsedLines = 0, parseErrors = 0;
  const parseErrorFiles = new Set();
  for (const currentFile of currentFiles) {
    const relative = path.relative(root, currentFile).split(path.sep).join('/');
    let stat;
    try { stat = fs.statSync(currentFile); } catch (_) { continue; }
    const known = hadValidCache && cache.todayFiles[relative];
    let item;
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) {
      item = known;
    } else {
      const parsed = parseRecords(root, { ...options, now, lowerBound: cutoff, upperBound: now,
        files: [currentFile] });
      item = { mtimeMs: stat.mtimeMs, size: stat.size, buckets: aggregateBuckets(parsed.records),
        parsedLines: parsed.parsedLines, parseErrors: parsed.parseErrors, parseErrorFiles: parsed.parseErrorFiles };
    }
    item.buckets = item.buckets.filter(bucket => bucket.day >= localDayString(cutoff));
    todayFiles[relative] = item;
    parsedLines += item.parsedLines || 0;
    parseErrors += item.parseErrors || 0;
    for (const errorFile of item.parseErrorFiles || []) parseErrorFiles.add(errorFile);
  }
  const buckets = Object.values(todayFiles).flatMap(item => item.buckets);
  const cacheReady = writeCache(file, { version: CACHE_VERSION, generatedAt: now, cutoff,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    historicalBuckets: [], todayFiles });
  const stats = aggregateCachedBuckets(buckets, { ...options, now });
  return { ...stats, files: currentFiles.length, parsedLines, parseErrors,
    parseErrorFiles: Array.from(parseErrorFiles), cached: hadValidCache, cacheHit: hadValidCache,
    cacheReady, cacheGeneratedAt: hadValidCache ? cache.generatedAt : now };
}

function scanTokenStats(root, options = {}) {
  const now = Number(options.now) || Date.now();
  const days = Math.max(1, Math.min(90, Number(options.days) || 7));
  const localStart = new Date(now); localStart.setHours(0, 0, 0, 0);
  const since = dateBounds(now, { days }).from;
  const from = options.from ? Date.parse(options.from) : since;
  const until = options.until ? Date.parse(options.until) + 24 * 60 * 60 * 1000 - 1 : now;
  const accountFilter = String(options.account || '').trim();
  const modelFilter = String(options.model || '').trim();
  const files = walkJsonl(root, options.maxFiles || 5000);
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  const byDay = new Map();
  const byModel = new Map();
  const byAccount = new Map();
  let parsedLines = 0;
  let parseErrors = 0;
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    const relative = path.relative(root, file).split(path.sep);
    const project = relative.length > 1 ? relative[0] : '';
    const session = path.basename(file, '.jsonl');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch (_) {
        // Some WorkBuddy files contain non-JSON annotations between records; only
        // count malformed object/array lines as parse errors worth surfacing.
        if (/^\s*[\[{]/.test(line)) parseErrors++;
        continue;
      }
      if (record.isSnapshotUpdate) continue;
      const usage = findUsage(record.message && record.message.usage) || findUsage(record.providerData && record.providerData.usage) || findUsage(record);
      if (!usage) continue;
      const timestamp = timestampValue(record.timestamp || record.created_at || record.createdAt || usage.timestamp, now);
      if (!Number.isFinite(timestamp) || timestamp < since || timestamp > now + 60 * 1000) continue;
      const input = numberField(usage, TOKEN_FIELDS.input);
      const output = numberField(usage, TOKEN_FIELDS.output);
      const cacheRead = numberField(usage, TOKEN_FIELDS.cacheRead);
      const cacheWrite = numberField(usage, TOKEN_FIELDS.cacheWrite);
      if (!(input || output || cacheRead || cacheWrite)) continue;
      const model = findText(record, ['model', 'modelName', 'model_id', 'modelId']) || findText(usage, ['model', 'modelName', 'model_id', 'modelId']);
      const account = findText(record, ['accountUid', 'accountId', 'uid', 'userId']) || findText(usage, ['accountUid', 'accountId', 'uid', 'userId']);
      if (Number.isFinite(from) && timestamp < from) continue;
      if (Number.isFinite(until) && timestamp > until) continue;
      if (accountFilter && account !== accountFilter) continue;
      if (modelFilter && model !== modelFilter) continue;
      const values = { input, output, cacheRead, cacheWrite, calls: 1 };
      for (const key of Object.keys(totals)) totals[key] += values[key];
      const day = localDayString(timestamp);
      if (day) {
        const current = byDay.get(day) || { day, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
        for (const key of Object.keys(values)) current[key] += values[key];
        byDay.set(day, current);
      }
      if (model) {
        const modelRow = byModel.get(model) || { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
        for (const key of Object.keys(values)) modelRow[key] += values[key];
        byModel.set(model, modelRow);
      }
      if (account) {
        const accountRow = byAccount.get(account) || { account, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
        for (const key of Object.keys(values)) accountRow[key] += values[key];
        byAccount.set(account, accountRow);
      }
      parsedLines++;
    }
  }
  return {
    source: 'local-workbuddy-jsonl',
    since,
    until: now,
    files: files.length,
    parsedLines,
    parseErrors,
    totals,
    daily: Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day)),
    models: Array.from(byModel.values()).sort((a, b) => (b.input + b.output) - (a.input + a.output)),
    accounts: Array.from(byAccount.values()).sort((a, b) => (b.input + b.output) - (a.input + a.output)),
  };
}

module.exports = { tokenStatsCacheReady, scanTokenStats, scanTokenStatsCached, findUsage, walkJsonl, dateBounds };
