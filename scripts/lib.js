/**
 * WorkBuddy 多账号切换器 - 共享逻辑
 *
 * 原理：WorkBuddy 桌面端的登录信息保存在
 *   ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
 * 其中 account.uid 是用户唯一 ID。本插件把该文件按 <uid>.info 分文件备份到稳定目录，
 * 切换登录时把对应备份复制回原文件即可。
 *
 * 环境变量（均可覆盖默认值）：
 *   WBSWITCH_AUTH_FILE  登录信息文件路径
 *   WBSWITCH_DATA_DIR   备份数据目录
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { getProfile, profileDataDir, sharedDataDir } = require('./profiles.js');

const IS_WIN = process.platform === 'win32';

const PLATFORM_DATA_DIR = IS_WIN
  ? path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'WorkDaddy'
    )
  : path.join(os.homedir(), 'Library', 'Application Support', 'WorkDaddy');
const LEGACY_DATA_DIR = IS_WIN
  ? null
  : path.join(os.homedir(), 'Library', 'Application Support', 'HelloBuddy');

function samePath(a, b) {
  return !!a && !!b && path.resolve(a) === path.resolve(b);
}

function isLegacyDataDir(dataDir) {
  return !IS_WIN && samePath(dataDir, LEGACY_DATA_DIR);
}

// macOS: ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info
// Windows: %LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info（真机已确认）
const ACTIVE_PROFILE = getProfile();
const AUTH_FILE = process.env.WBSWITCH_AUTH_FILE !== undefined
  ? process.env.WBSWITCH_AUTH_FILE
  : (ACTIVE_PROFILE.authFile === null ? null : (ACTIVE_PROFILE.authFile || (IS_WIN
    ? path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'CodeBuddyExtension',
        'Data',
        'Public',
        'auth',
        'workbuddy-desktop.info'
      )
    : path.join(
        os.homedir(),
        'Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info'
      ))));

const LOGOUT_MARKER = `${AUTH_FILE}.logged-out`;
const EXPLICIT_AUTH_FILE = process.env.WBSWITCH_AUTH_FILE !== undefined;
const DYNAMIC_AUTH_DISCOVERY = !EXPLICIT_AUTH_FILE && !!ACTIVE_PROFILE.authFile && !!ACTIVE_PROFILE.capabilities.accounts;

function authDir(file = AUTH_FILE) {
  return file ? path.dirname(path.resolve(file)) : null;
}

function safeAuthFileName(name) {
  const value = String(name || '');
  return value.length > 0 && value.length <= 255 && path.basename(value) === value &&
    !value.includes('\0') && !value.endsWith('.tmp') && /\.info$/i.test(value);
}

function normalizeAuthDomain(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.origin.toLowerCase().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

function tokenIssuerOrigin(accessToken) {
  try {
    const part = String(accessToken || '').split('.')[1];
    if (!part) return '';
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return normalizeAuthDomain(payload.iss);
  } catch (_) {
    return '';
  }
}

function allowedAuthOrigins(profile = ACTIVE_PROFILE) {
  const origins = new Set();
  const profileOrigin = normalizeAuthDomain(profile.apiHost);
  if (profileOrigin) origins.add(profileOrigin);
  if (profile.region === 'cn') {
    origins.add('https://www.workbuddy.cn');
    origins.add('https://www.codebuddy.cn');
  } else if (profile.region === 'intl') {
    origins.add('https://www.workbuddy.ai');
    origins.add('https://www.codebuddy.ai');
  }
  return origins;
}

function authRecordFromJson(file, json, { strict = DYNAMIC_AUTH_DISCOVERY } = {}) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const acct = json.account || (Array.isArray(json.accounts) && json.accounts[0]) || null;
  if (!acct || !acct.uid) return null;
  const auth = json.auth && typeof json.auth === 'object' ? json.auth : {};
  const accessToken = String(auth.accessToken || auth.access_token || auth.token || '');
  const authDomain = normalizeAuthDomain(auth.domain || auth.issuer || '');
  const authIssuer = tokenIssuerOrigin(accessToken);
  if (strict) {
    if (!accessToken) return null;
    const allowed = allowedAuthOrigins();
    if (![authDomain, authIssuer].some((origin) => origin && allowed.has(origin))) return null;
  }
  return {
    uid: String(acct.uid),
    nickname: acct.nickname || '',
    uin: acct.uin || '',
    phone: acct.phoneNumber || '',
    type: acct.type || '',
    raw: json,
    file,
    authFileName: file ? path.basename(file) : '',
    authDomain,
    authIssuer,
    lastLogin: acct.lastLogin === true,
    lastRefreshTime: Number(auth.lastRefreshTime) || 0,
  };
}

function parseAuthFile(file, options = {}) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return authRecordFromJson(file, json, options);
  } catch (_) {
    return null;
  }
}

function listAuthRecords() {
  if (!AUTH_FILE) return [];
  if (!DYNAMIC_AUTH_DISCOVERY) {
    const record = parseAuthFile(AUTH_FILE, { strict: false });
    return record ? [record] : [];
  }
  const dir = authDir();
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names
    .filter(safeAuthFileName)
    .map((name) => parseAuthFile(path.join(dir, name)))
    .filter(Boolean);
}

function resolveCurrentAuth() {
  if (!DYNAMIC_AUTH_DISCOVERY) return { file: AUTH_FILE, record: parseAuthFile(AUTH_FILE, { strict: false }), ambiguous: false };
  const records = listAuthRecords();
  if (records.length === 1) return { file: records[0].file, record: records[0], ambiguous: false };
  // 官方固定文件（workbuddy-desktop.info / workbuddy-desktop-ai.info）是官方实际读取的
  // 当前登录文件：多份历史备份可能都残留 lastLogin 标记，只有固定文件是可信的「当前」。
  // 固定文件有效时优先采用，避免被历史标记拖入 ambiguous 而拒绝切换/备份。
  const canonical = records.find((record) => AUTH_FILE && path.resolve(record.file) === path.resolve(AUTH_FILE));
  if (canonical) return { file: canonical.file, record: canonical, ambiguous: false };
  const marked = records.filter((record) => record.lastLogin);
  if (records.length > 1 && marked.length === 1) return { file: marked[0].file, record: marked[0], ambiguous: false };
  return { file: null, record: null, ambiguous: records.length > 1, records };
}

function currentAuthFile() {
  return resolveCurrentAuth().file;
}

function defaultDataDir() {
  // 旧版 launchd 可能把 WBSWITCH_DATA_DIR 设成 HelloBuddy；新版本始终落到 WorkDaddy，
  // 避免旧服务被新 daemon 拉起后继续写入旧目录。
  const configured = process.env.WBSWITCH_DATA_DIR;
  return configured && !isLegacyDataDir(configured) ? configured : profileDataDir(ACTIVE_PROFILE);
}

function accountsDir(dataDir) {
  return path.join(dataDir, 'accounts');
}
function metaFile(dataDir) {
  return path.join(dataDir, 'meta.json');
}

function workbuddyModelsFile() {
  return ACTIVE_PROFILE.modelsFile || path.join(os.homedir(), '.workbuddy', 'models.json');
}

function isManagedProfileDataDir(dataDir) {
  const root = path.resolve(sharedDataDir());
  const current = path.resolve(dataDir || '');
  return current === root || current.startsWith(root + path.sep + 'profiles' + path.sep);
}

function migrateLegacyModelBackups(dataDir) {
  if (!isManagedProfileDataDir(dataDir)) return;
  const root = sharedDataDir();
  const target = path.join(root, 'models');
  const marker = path.join(target, '.legacy-migrated-v1');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  // 迁移只允许发生一次。旧 profile 目录保留作兼容/恢复，但不能在用户删除
  // 共享备份后再次把同一个文件复制回来。
  if (fs.existsSync(marker)) return;
  let profileDirs = [];
  try { profileDirs = fs.readdirSync(path.join(root, 'profiles'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, 'profiles', entry.name, 'models')); } catch (_) {}
  for (const source of profileDirs) {
    let names = [];
    try { names = fs.readdirSync(source).filter((name) => /^[A-Za-z0-9_-]{8,100}\.json$/.test(name)); } catch (_) { continue; }
    for (const name of names) {
      const from = path.join(source, name);
      const to = path.join(target, name);
      if (fs.existsSync(to)) continue;
      try { fs.copyFileSync(from, to); fs.chmodSync(to, 0o600); } catch (_) {}
    }
  }
  try {
    fs.writeFileSync(marker, JSON.stringify({ version: 1, migratedAt: new Date().toISOString(), deleted: [] }) + '\n', { mode: 0o600 });
    fs.chmodSync(marker, 0o600);
  } catch (_) {}
}

function modelBackupsDir(dataDir) {
  if (isManagedProfileDataDir(dataDir)) {
    migrateLegacyModelBackups(dataDir);
    return path.join(sharedDataDir(), 'models');
  }
  return path.join(dataDir, 'models');
}

function maskApiKey(apiKey) {
  const value = String(apiKey || '');
  if (!value) return '';
  if (value.length <= 8) return '••••••';
  const prefix = value.slice(0, Math.min(3, value.length - 4));
  const suffix = value.slice(-4);
  const middleLength = Math.max(1, value.length - prefix.length - suffix.length);
  return `${prefix}${'•'.repeat(middleLength)}${suffix}`;
}

// 模型列表摘要。默认脱敏 apiKey；UI 需要明文展示（模型页 cell / 编辑弹窗）时传 { revealKey: true }。
function sanitizeModel(model, opts) {
  const value = model && typeof model === 'object' && !Array.isArray(model) ? model : {};
  const revealKey = !!(opts && opts.revealKey);
  return {
    id: String(value.id || value.name || ''),
    name: String(value.name || value.id || ''),
    vendor: String(value.vendor || ''),
    url: String(value.url || '').split('?')[0].split('#')[0],
    apiKey: revealKey ? String(value.apiKey || '') : maskApiKey(value.apiKey),
    supportsToolCall: !!value.supportsToolCall,
    supportsImages: !!value.supportsImages,
    supportsReasoning: !!value.supportsReasoning,
  };
}

function checkinDisplayValue(record, today, pending) {
  if (!record || record.date !== today) return null;
  // 正在签到时保留已确认的成功标记；只有失败/未完成记录才暂不展示，避免首屏把已签到账号误显示为“签到中”。
  if (pending && !record.ok) return null;
  return { ok: !!record.ok, already: !!record.already, code: record.code, message: record.message };
}

function readModelsFile(file = workbuddyModelsFile()) {
  // 文件不存在视为"还没有模型"，返回空列表而不是抛错——模型页应显示
  // "当前还未添加模型"占位，而不是"当前模型加载失败: 未找到模型配置文件"。
  if (!fs.existsSync(file)) return { file, format: 'array', models: [] };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`模型配置文件不是有效 JSON: ${e.message}`);
  }
  if (Array.isArray(parsed)) return { file, format: 'array', models: parsed };
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.models)) {
    return { file, format: 'object', models: parsed.models, wrapper: parsed };
  }
  throw new Error('模型配置文件格式不受支持：应为数组或包含 models 数组的对象');
}

function writeModelsFile(parsed, models) {
  const output = parsed.format === 'array' ? models : Object.assign({}, parsed.wrapper, { models });
  const file = parsed.file;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch (_) {}
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(output, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch (_) {}
}

function modelBackupPath(dataDir, backupId) {
  const id = String(backupId || '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) throw new Error('非法模型备份标识');
  return path.join(modelBackupsDir(dataDir), `${id}.json`);
}

function readModelBackup(dataDir, backupId) {
  const file = modelBackupPath(dataDir, backupId);
  if (!fs.existsSync(file)) throw new Error('模型备份不存在');
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`模型备份损坏: ${e.message}`); }
  if (!record || record.schema !== 1 || !record.model || typeof record.model !== 'object' || Array.isArray(record.model)) {
    throw new Error('模型备份格式不受支持');
  }
  return { file, record };
}

function listModelBackups(dataDir) {
  const dir = modelBackupsDir(dataDir);
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => /^[A-Za-z0-9_-]{8,100}\.json$/.test(name)); } catch (_) {}
  const records = [];
  for (const name of names) {
    const backupId = name.slice(0, -5);
    try {
      const { record } = readModelBackup(dataDir, backupId);
      const model = record.model;
      const id = typeof model.id === 'string' ? model.id.trim() : '';
      const summary = sanitizeModel(model, { revealKey: true });
      records.push({ backupId, createdAt: record.createdAt || null, ...summary, id });
    } catch (_) {
      // Ignore damaged files in the list; an explicit enable/delete still reports an error.
    }
  }
  records.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const groups = new Map();
  for (const record of records) {
    // 分组严格依据原始模型配置的 id（模型名），不能使用用户自定义 name。
    const key = record.id || '(未命名模型)';
    if (!groups.has(key)) groups.set(key, { id: key, items: [] });
    groups.get(key).items.push(record);
  }
  return Array.from(groups.values());
}

function listOfficialModels(file = workbuddyModelsFile()) {
  const parsed = readModelsFile(file);
  return parsed.models.map((model, index) => Object.assign({ index }, sanitizeModel(model, { revealKey: true })));
}

function readOfficialModel(file = workbuddyModelsFile(), index) {
  const parsed = readModelsFile(file);
  const position = Number(index);
  if (!Number.isInteger(position) || position < 0 || position >= parsed.models.length) throw new Error('模型索引无效');
  const model = parsed.models[position];
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('模型配置无效');
  return model;
}

function deleteOfficialModels(file = workbuddyModelsFile(), indexes) {
  const parsed = readModelsFile(file);
  const positions = Array.isArray(indexes)
    ? Array.from(new Set(indexes.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value < parsed.models.length)))
    : [];
  if (!positions.length) throw new Error('未选择当前模型');
  const selected = new Set(positions);
  const next = parsed.models.filter((_, index) => !selected.has(index));
  writeModelsFile(parsed, next);
  return { deleted: positions.length, official: next.map((model, index) => Object.assign({ index }, sanitizeModel(model))) };
}

function backupOfficialModel(dataDir, index, modelsFile = workbuddyModelsFile()) {
  const parsed = readModelsFile(modelsFile);
  const position = Number(index);
  if (!Number.isInteger(position) || position < 0 || position >= parsed.models.length) throw new Error('模型索引无效');
  const model = parsed.models[position];
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('模型配置无效');
  const backupId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  fs.mkdirSync(modelBackupsDir(dataDir), { recursive: true, mode: 0o700 });
  const file = modelBackupPath(dataDir, backupId);
  fs.writeFileSync(file, JSON.stringify({ schema: 1, backupId, createdAt, model }, null, 2) + '\n', { mode: 0o600 });
  return { backupId, createdAt, ...sanitizeModel(model) };
}

function writeModelBackup(dataDir, record) {
  fs.mkdirSync(modelBackupsDir(dataDir), { recursive: true, mode: 0o700 });
  const file = modelBackupPath(dataDir, record.backupId);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function copyModelBackup(dataDir, backupId) {
  const { record } = readModelBackup(dataDir, backupId);
  const copied = Object.assign({}, record, {
    backupId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    model: Object.assign({}, record.model),
  });
  writeModelBackup(dataDir, copied);
  return { backupId: copied.backupId, createdAt: copied.createdAt, ...sanitizeModel(copied.model) };
}

function editModelBackup(dataDir, backupId, patch) {
  const { record } = readModelBackup(dataDir, backupId);
  const input = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const model = Object.assign({}, record.model);
  // 模型名对应配置里的 id（例如 deepseek-v4-flash），name 是用户自定义的显示名称；两者都允许编辑。
  for (const field of ['id', 'name', 'url', 'apiKey']) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    if (typeof input[field] !== 'string' || input[field].length > 20000) throw new Error(`模型${field}格式无效`);
    model[field] = input[field];
  }
  const modelId = String(model.id || model.name || '').trim();
  if (!modelId) throw new Error('模型备份缺少 id/name，无法保存');
  model.id = modelId;
  if (!String(model.name || '').trim()) model.name = modelId;
  const updated = Object.assign({}, record, { model });
  writeModelBackup(dataDir, updated);
  return { backupId: updated.backupId, createdAt: updated.createdAt || null, ...sanitizeModel(model) };
}

function deleteModelBackups(dataDir, backupIds) {
  const ids = Array.isArray(backupIds) ? backupIds : [];
  let deleted = 0;
  const removed = [];
  for (const id of ids) {
    try {
      const file = modelBackupPath(dataDir, id);
      if (fs.existsSync(file)) { fs.unlinkSync(file); deleted++; removed.push(String(id)); }
    } catch (_) {}
  }
  if (removed.length && isManagedProfileDataDir(dataDir)) {
    const marker = path.join(sharedDataDir(), 'models', '.legacy-migrated-v1');
    try {
      const state = JSON.parse(fs.readFileSync(marker, 'utf8'));
      const deletedIds = new Set(Array.isArray(state.deleted) ? state.deleted : []);
      removed.forEach((id) => deletedIds.add(id));
      fs.writeFileSync(marker, JSON.stringify(Object.assign({}, state, { deleted: Array.from(deletedIds) })) + '\n', { mode: 0o600 });
      fs.chmodSync(marker, 0o600);
    } catch (_) {}
  }
  return deleted;
}

function enableModelBackup(dataDir, backupId, file = workbuddyModelsFile()) {
  const { record } = readModelBackup(dataDir, backupId);
  const modelId = String(record.model.id || record.model.name || '').trim();
  if (!modelId) throw new Error('模型备份缺少 id/name，无法启用');
  const parsed = readModelsFile(file);
  const models = parsed.models.slice();
  const first = models.findIndex((model) => String(model && (model.id || model.name) || '') === modelId);
  const next = [];
  let inserted = false;
  for (const model of models) {
    const id = String(model && (model.id || model.name) || '');
    if (id === modelId) {
      if (!inserted) { next.push(record.model); inserted = true; }
    } else next.push(model);
  }
  if (!inserted) next.push(record.model);
  writeModelsFile(parsed, next);
  return { backupId, id: modelId, replaced: first >= 0, ...sanitizeModel(record.model) };
}

function modelImportName(model) {
  return String(model && (model.name || model.id) || '').trim();
}

function importModels(targetFile, sourceFile) {
  const target = readModelsFile(targetFile);
  const source = readModelsFile(sourceFile);
  if (path.resolve(target.file) === path.resolve(source.file)) throw new Error('不能从当前客户端导入模型');
  const existing = new Set(target.models.map(modelImportName).filter(Boolean));
  const imported = [];
  const skipped = [];
  for (const model of source.models) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
    const name = modelImportName(model);
    if (!name || existing.has(name)) { if (name) skipped.push(name); continue; }
    target.models.push(model);
    existing.add(name);
    imported.push(name);
  }
  if (imported.length) writeModelsFile(target, target.models);
  return { imported, skipped, official: target.models.map((model, index) => Object.assign({ index }, sanitizeModel(model, { revealKey: true }))) };
}

function readMeta(dataDir) {
  let meta = { accounts: {} };
  try {
    meta = JSON.parse(fs.readFileSync(metaFile(dataDir), 'utf8'));
  } catch (_) {
    /* 首次运行或旧版本没有 meta.json */
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
  if (!meta.accounts || typeof meta.accounts !== 'object' || Array.isArray(meta.accounts)) meta.accounts = {};
  return meta;
}

function writeMeta(dataDir, meta) {
  ensureDirs(dataDir);
  const mf = metaFile(dataDir);
  const tmp = `${mf}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, mf);
  try { fs.chmodSync(mf, 0o600); } catch (_) {}
}

/** 使用稳定路径键，不要求路径当前存在（空间可能已被移动或卸载）。 */
function canonicalWorkspace(cwd) {
  let value = String(cwd || '').trim();
  if (!value) return '';
  value = value.replace(/\\/g, '/');
  value = path.posix.normalize(value);
  if (value === '.') return '';
  if (value.length > 1) value = value.replace(/\/+$/, '');
  // Windows filesystem matching is case-insensitive, but this key is also
  // displayed to users and must retain WorkBuddy's original path spelling.
  return value;
}

function ensureAutoCopyMeta(meta) {
  const current = meta.autoCopy;
  if (current && current.version === 2 && current.sessions && current.sessionIndex && current.workspaces && current.copies) {
    return current;
  }

  // 1.0.15 stored rules under sourceUid. Convert them once to global session lineages
  // and global workspace paths so a migration/copy keeps the same shared identity.
  const legacy = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const next = { version: 2, allSessions: false, sessions: {}, sessionIndex: {}, workspaces: {}, copies: {} };
  const legacySessions = legacy.sessions && typeof legacy.sessions === 'object' ? legacy.sessions : {};
  for (const sourceUid of Object.keys(legacySessions)) {
    const bucket = legacySessions[sourceUid];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    for (const sessionId of Object.keys(bucket)) {
      const legacyRule = bucket[sessionId];
      if (legacyRule === false || (legacyRule && typeof legacyRule === 'object' && legacyRule.enabled === false)) continue;
      const lineageId = crypto.randomUUID();
      next.sessions[lineageId] = { enabled: true, members: [{ uid: sourceUid, id: sessionId }], createdAt: Date.now() };
      if (!next.sessionIndex[sourceUid]) next.sessionIndex[sourceUid] = {};
      next.sessionIndex[sourceUid][sessionId] = lineageId;
    }
  }
  const legacyWorkspaces = legacy.workspaces && typeof legacy.workspaces === 'object' ? legacy.workspaces : {};
  for (const sourceUid of Object.keys(legacyWorkspaces)) {
    const bucket = legacyWorkspaces[sourceUid];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
    for (const cwd of Object.keys(bucket)) {
      if (bucket[cwd] === false) continue;
      const canonical = canonicalWorkspace(cwd);
      if (canonical) next.workspaces[canonical] = String(bucket[cwd] || cwd);
    }
  }
  const legacyCopies = legacy.copies && typeof legacy.copies === 'object' ? legacy.copies : {};
  for (const oldKey of Object.keys(legacyCopies)) {
    try {
      const parts = JSON.parse(oldKey);
      if (!Array.isArray(parts) || parts.length !== 3) continue;
      const lineageId = next.sessionIndex[String(parts[0] || '')] && next.sessionIndex[String(parts[0] || '')][String(parts[2] || '')];
      if (lineageId) next.copies[JSON.stringify([lineageId, String(parts[1] || '')])] = legacyCopies[oldKey];
    } catch (_) {}
  }
  meta.autoCopy = next;
  return next;
}

function readAutoCopyConfig(dataDir) {
  const meta = readMeta(dataDir);
  const wasCurrent = !!(meta.autoCopy && meta.autoCopy.version === 2);
  const autoCopy = ensureAutoCopyMeta(meta);
  if (!wasCurrent) writeMeta(dataDir, meta);
  return {
    allSessions: autoCopy.allSessions === true,
    sessions: autoCopy.sessions,
    sessionIndex: autoCopy.sessionIndex,
    workspaces: autoCopy.workspaces,
    copies: autoCopy.copies,
  };
}

function autoCopyRuleKey(lineageId, targetUid) {
  return JSON.stringify([String(lineageId || ''), String(targetUid || '')]);
}

function getAutoCopyRules(dataDir, uid) {
  const config = readAutoCopyConfig(dataDir);
  const sourceUid = String(uid || '').trim();
  const index = config.sessionIndex[sourceUid] || {};
  const sessionIds = [];
  const lineages = {};
  const allLineages = {};
  for (const sessionId of Object.keys(index)) {
    const lineageId = index[sessionId];
    const lineage = config.sessions[lineageId];
    if (lineage) allLineages[sessionId] = lineageId;
    if (lineage && lineage.enabled !== false) {
      sessionIds.push(sessionId);
      lineages[sessionId] = lineageId;
    }
  }
  return {
    allSessions: config.allSessions === true,
    sessionIds,
    lineages,
    allLineages,
    workspaces: Object.keys(config.workspaces),
  };
}

// A lineage represents one logical session per account. Older copies can
// leave multiple physical rows indexed under the same lineage; keep the first
// row (the SQL callers order newest activity first) for plans and UI counts.
function dedupeAutoCopySessionRows(rows, lineagesByUid) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  return rows.filter((row) => {
    const uid = String(row && row.user_id || '').trim();
    const id = String(row && row.id || '').trim();
    const lineageId = lineagesByUid && lineagesByUid[uid] && lineagesByUid[uid][id];
    if (!lineageId) return true;
    const key = uid + '::' + String(lineageId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function setAutoCopyAllSessions(dataDir, enabled) {
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  config.allSessions = enabled === true;
  writeMeta(dataDir, meta);
  return { allSessions: config.allSessions };
}

function isAutoCopySessionSelected(rules, session) {
  if (rules && rules.allSessions === true) return true;
  const sessionId = String(session && session.id || '');
  const workspace = canonicalWorkspace(session && session.cwd);
  const sessionIds = rules && Array.isArray(rules.sessionIds) ? rules.sessionIds : [];
  const workspaces = rules && Array.isArray(rules.workspaces) ? rules.workspaces : [];
  return sessionIds.some((id) => String(id) === sessionId)
    || workspaces.some((cwd) => canonicalWorkspace(cwd) === workspace);
}

function setAutoCopyRule(dataDir, { uid, kind, key, enabled }) {
  const sourceUid = String(uid || '').trim();
  if (kind !== 'session' && kind !== 'workspace') throw new Error('无效的自动复制规则类型');
  const value = kind === 'workspace' ? canonicalWorkspace(key) : String(key || '').trim();
  if (!value) throw new Error('缺少自动复制规则标识');
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  if (kind === 'workspace') {
    if (enabled) config.workspaces[value] = String(key || '').trim();
    else delete config.workspaces[value];
    writeMeta(dataDir, meta);
    return getAutoCopyRules(dataDir, sourceUid);
  }
  if (!sourceUid) throw new Error('缺少源账号 uid');
  if (!config.sessionIndex[sourceUid]) config.sessionIndex[sourceUid] = {};
  const lineageId = config.sessionIndex[sourceUid][value];
  if (enabled) {
    const lineage = lineageId && config.sessions[lineageId]
      ? config.sessions[lineageId]
      : { enabled: true, members: [], createdAt: Date.now() };
    if (!lineageId) {
      const createdId = crypto.randomUUID();
      config.sessions[createdId] = lineage;
      config.sessionIndex[sourceUid][value] = createdId;
      addLineageMember(lineage, sourceUid, value);
    } else {
      lineage.enabled = true;
      addLineageMember(lineage, sourceUid, value);
    }
  } else {
    if (lineageId && config.sessions[lineageId]) config.sessions[lineageId].enabled = false;
  }
  writeMeta(dataDir, meta);
  return getAutoCopyRules(dataDir, sourceUid);
}

function addLineageMember(lineage, uid, id) {
  if (!Array.isArray(lineage.members)) lineage.members = [];
  if (!lineage.members.some((member) => member && member.uid === uid && member.id === id)) {
    lineage.members.push({ uid, id });
  }
}

function getAutoCopySession(dataDir, uid, sessionId) {
  const config = readAutoCopyConfig(dataDir);
  const lineageId = config.sessionIndex[String(uid || '').trim()] && config.sessionIndex[String(uid || '').trim()][String(sessionId || '').trim()];
  const lineage = lineageId ? config.sessions[lineageId] : null;
  return { lineageId: lineageId || null, enabled: !!(lineage && lineage.enabled !== false) };
}

// Return all persisted session ids for one account in a lineage.  A lineage
// should have at most one live session per uid, but keeping the full list lets
// the copier repair stale mappings without creating another row.
function getAutoCopySessionMembers(dataDir, lineageId, uid) {
  const config = readAutoCopyConfig(dataDir);
  const lineage = config.sessions[String(lineageId || '')];
  if (!lineage || !Array.isArray(lineage.members)) return [];
  const targetUid = uid === undefined || uid === null ? null : String(uid);
  const seen = new Set();
  const result = [];
  for (const member of lineage.members) {
    if (!member || (targetUid !== null && String(member.uid || '') !== targetUid)) continue;
    const id = String(member.id || '').trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

// Return the de-duplicated account/session pairs for a lineage.  The copier
// needs the uid as well as the id so it can refresh every live account member,
// not only the account that happened to be active during the switch.
function getAutoCopySessionMemberRecords(dataDir, lineageId) {
  const config = readAutoCopyConfig(dataDir);
  const lineage = config.sessions[String(lineageId || '')];
  if (!lineage || !Array.isArray(lineage.members)) return [];
  const seen = new Set();
  const result = [];
  for (const member of lineage.members) {
    const uid = String(member && member.uid || '').trim();
    const id = String(member && member.id || '').trim();
    if (!uid || !id) continue;
    const key = JSON.stringify([uid, id]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ uid, id });
  }
  return result;
}

// Pick the freshest member snapshot.  Message files are authoritative; the
// database timestamp is only a deterministic fallback for legacy/missing
// files.  Ties are resolved by member order so repeated switches stay stable.
function selectLatestAutoCopyMember(members) {
  if (!Array.isArray(members) || !members.length) return null;
  let best = null;
  members.forEach((member, index) => {
    if (!member || !member.id) return;
    const contentMtime = Number(member.contentMtime || 0);
    const updatedAt = Number(member.updatedAt || 0);
    if (!best || contentMtime > best.contentMtime ||
        (contentMtime === best.contentMtime && updatedAt > best.updatedAt)) {
      best = Object.assign({ memberIndex: index }, member, { contentMtime, updatedAt });
    }
  });
  return best ? members[best.memberIndex] : null;
}

function ensureAutoCopySessions(dataDir, uid, sessionIds, options) {
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  const sourceUid = String(uid || '').trim();
  const ids = Array.from(new Set((Array.isArray(sessionIds) ? sessionIds : [sessionIds])
    .map((id) => String(id || '').trim())
    .filter(Boolean)));
  if (!sourceUid || !ids.length) throw new Error('缺少共享会话标识');
  if (!config.sessionIndex[sourceUid]) config.sessionIndex[sourceUid] = {};
  const lineages = {};
  ids.forEach((id) => {
    let lineageId = config.sessionIndex[sourceUid][id];
    if (!lineageId || !config.sessions[lineageId]) {
      lineageId = crypto.randomUUID();
      config.sessions[lineageId] = { enabled: !(options && options.enabled === false), members: [], createdAt: Date.now() };
      config.sessionIndex[sourceUid][id] = lineageId;
    }
    addLineageMember(config.sessions[lineageId], sourceUid, id);
    lineages[id] = lineageId;
  });
  writeMeta(dataDir, meta);
  return lineages;
}

function ensureAutoCopySession(dataDir, uid, sessionId, options) {
  const id = String(sessionId || '').trim();
  if (!id) throw new Error('缺少共享会话标识');
  return ensureAutoCopySessions(dataDir, uid, [id], options)[id];
}

// Keep the core lineage invariant: one physical session per account in each
// lineage. Older copy jobs could append a second session for the same account
// when a mapping was stale. Preserve every physical row, but move duplicates
// to their own lineage so the next all-session reconciliation can pair them.
function normalizeAutoCopyLineages(dataDir) {
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  let changed = false;
  for (const lineageId of Object.keys(config.sessions)) {
    const lineage = config.sessions[lineageId];
    if (!lineage || !Array.isArray(lineage.members)) continue;
    const seenUids = new Set();
    const kept = [];
    for (const member of lineage.members) {
      const uid = String(member && member.uid || '').trim();
      const id = String(member && member.id || '').trim();
      if (!uid || !id || !seenUids.has(uid)) {
        if (uid) seenUids.add(uid);
        kept.push(member);
        continue;
      }
      const replacementId = crypto.randomUUID();
      config.sessions[replacementId] = {
        enabled: lineage.enabled !== false,
        members: [{ uid, id }],
        createdAt: Date.now(),
      };
      if (!config.sessionIndex[uid]) config.sessionIndex[uid] = {};
      config.sessionIndex[uid][id] = replacementId;
      changed = true;
    }
    if (kept.length !== lineage.members.length) lineage.members = kept;
  }
  if (changed) writeMeta(dataDir, meta);
  return changed;
}

function addAutoCopySessionMember(dataDir, lineageId, uid, sessionId) {
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  const lineage = config.sessions[String(lineageId || '')];
  if (!lineage) return false;
  const sourceUid = String(uid || '').trim();
  const id = String(sessionId || '').trim();
  if (!sourceUid || !id) return false;
  if (!config.sessionIndex[sourceUid]) config.sessionIndex[sourceUid] = {};
  const previousLineageId = config.sessionIndex[sourceUid][id];
  if (previousLineageId && previousLineageId !== String(lineageId) && config.sessions[previousLineageId]) {
    config.sessions[previousLineageId].members = (config.sessions[previousLineageId].members || [])
      .filter((member) => !(member && member.uid === sourceUid && member.id === id));
  }
  config.sessionIndex[sourceUid][id] = String(lineageId);
  addLineageMember(lineage, sourceUid, id);
  writeMeta(dataDir, meta);
  return true;
}

// Remove only one member from a lineage.  Unlike removeAutoCopySession this
// intentionally leaves the lineage and other account members intact.
function removeAutoCopySessionMember(dataDir, lineageId, uid, sessionId) {
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  const id = String(lineageId || '').trim();
  const sourceUid = String(uid || '').trim();
  const sessionIdValue = String(sessionId || '').trim();
  const lineage = config.sessions[id];
  if (!lineage || !sourceUid || !sessionIdValue) return false;
  const before = Array.isArray(lineage.members) ? lineage.members.length : 0;
  lineage.members = (lineage.members || []).filter((member) => !(member && String(member.uid || '') === sourceUid && String(member.id || '') === sessionIdValue));
  if (config.sessionIndex[sourceUid] && config.sessionIndex[sourceUid][sessionIdValue] === id) {
    delete config.sessionIndex[sourceUid][sessionIdValue];
    if (!Object.keys(config.sessionIndex[sourceUid]).length) delete config.sessionIndex[sourceUid];
  }
  const mappingKey = autoCopyRuleKey(id, sourceUid);
  if (config.copies[mappingKey] && String(config.copies[mappingKey].targetId || '') === sessionIdValue) delete config.copies[mappingKey];
  if (before === lineage.members.length) return false;
  writeMeta(dataDir, meta);
  return true;
}

function moveAutoCopySession(dataDir, fromUid, toUid, sessionId) {
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  const from = String(fromUid || '').trim();
  const to = String(toUid || '').trim();
  const id = String(sessionId || '').trim();
  if (!from || !to || !id || from === to) return false;
  const lineageId = config.sessionIndex[from] && config.sessionIndex[from][id];
  if (!lineageId || !config.sessions[lineageId]) return false;
  if (config.sessionIndex[from]) delete config.sessionIndex[from][id];
  if (!config.sessionIndex[to]) config.sessionIndex[to] = {};
  config.sessionIndex[to][id] = lineageId;
  const lineage = config.sessions[lineageId];
  lineage.members = (lineage.members || []).filter((member) => !(member && member.uid === from && member.id === id));
  addLineageMember(lineage, to, id);
  writeMeta(dataDir, meta);
  return true;
}

function removeAutoCopySession(dataDir, uid, sessionId) {
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  const sourceUid = String(uid || '').trim();
  const id = String(sessionId || '').trim();
  const lineageId = config.sessionIndex[sourceUid] && config.sessionIndex[sourceUid][id];
  if (!lineageId) return false;
  delete config.sessionIndex[sourceUid][id];
  const lineage = config.sessions[lineageId];
  if (lineage) {
    lineage.members = (lineage.members || []).filter((member) => !(member && member.uid === sourceUid && member.id === id));
    if (!lineage.members.length) {
      delete config.sessions[lineageId];
      for (const key of Object.keys(config.copies)) {
        try {
          const parts = JSON.parse(key);
          if (Array.isArray(parts) && parts[0] === lineageId) delete config.copies[key];
        } catch (_) {
          // Ignore malformed legacy mapping keys; they cannot match a valid lineage.
        }
      }
    }
  }
  writeMeta(dataDir, meta);
  return true;
}

function removeAutoCopyAccount(dataDir, uid) {
  const sourceUid = String(uid || '').trim();
  if (!sourceUid) return 0;
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  const index = config.sessionIndex[sourceUid] || {};
  const entries = Object.keys(index).map((sessionId) => ({ sessionId, lineageId: index[sessionId] }));
  let removed = 0;
  for (const entry of entries) {
    delete index[entry.sessionId];
    const lineage = config.sessions[entry.lineageId];
    if (!lineage) continue;
    lineage.members = (lineage.members || []).filter((member) => !(member && member.uid === sourceUid && member.id === entry.sessionId));
    if (!lineage.members.length) {
      delete config.sessions[entry.lineageId];
      for (const key of Object.keys(config.copies)) {
        try {
          const parts = JSON.parse(key);
          if (Array.isArray(parts) && parts[0] === entry.lineageId) delete config.copies[key];
        } catch (_) {}
      }
    }
    removed++;
  }
  if (entries.length) {
    delete config.sessionIndex[sourceUid];
    writeMeta(dataDir, meta);
  }
  return removed;
}

function resolveMappingLineage(config, lineageOrUid, maybeSessionId) {
  if (maybeSessionId === undefined) return String(lineageOrUid || '');
  const sourceUid = String(lineageOrUid || '').trim();
  const sessionId = String(maybeSessionId || '').trim();
  return config.sessionIndex[sourceUid] && config.sessionIndex[sourceUid][sessionId]
    ? config.sessionIndex[sourceUid][sessionId]
    : '';
}

// The optional legacy sessionId argument keeps 1.0.15 local callers compatible
// while all persisted keys use lineageId + targetUid.
function getAutoCopyMapping(dataDir, lineageOrUid, targetUid, maybeSessionId) {
  const config = readAutoCopyConfig(dataDir);
  const lineageId = resolveMappingLineage(config, lineageOrUid, maybeSessionId);
  return config.copies[autoCopyRuleKey(lineageId, targetUid)] || null;
}

function setAutoCopyMapping(dataDir, lineageOrUid, targetUid, mappingOrSessionId, maybeMapping) {
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  const legacyCall = arguments.length >= 5;
  const lineageId = resolveMappingLineage(config, lineageOrUid, legacyCall ? mappingOrSessionId : undefined);
  const mapping = legacyCall ? maybeMapping : mappingOrSessionId;
  const key = autoCopyRuleKey(lineageId, targetUid);
  config.copies[key] = Object.assign({}, mapping, { updatedAt: Date.now() });
  writeMeta(dataDir, meta);
  return config.copies[key];
}

function deleteAutoCopyMapping(dataDir, lineageOrUid, targetUid, maybeSessionId) {
  const meta = readMeta(dataDir);
  const config = ensureAutoCopyMeta(meta);
  const lineageId = resolveMappingLineage(config, lineageOrUid, maybeSessionId);
  delete config.copies[autoCopyRuleKey(lineageId, targetUid)];
  writeMeta(dataDir, meta);
}
function logFile(dataDir) {
  return path.join(dataDir, 'daemon.log');
}
function backupPath(dataDir, uid) {
  return path.join(accountsDir(dataDir), `${uid}.info`);
}

/** WorkBuddy ignores auth files while this marker exists; retire it after a switch. */
function retireLogoutMarker(log = () => {}, file = AUTH_FILE) {
  const marker = file ? `${file}.logged-out` : LOGOUT_MARKER;
  if (!marker || !fs.existsSync(marker)) return false;
  try {
    const retired = `${marker}.retired.${process.pid}.${Date.now()}`;
    fs.renameSync(marker, retired);
    try {
      fs.unlinkSync(retired);
    } catch (_) {
      // A leftover retired marker is harmless and keeps the operation recoverable.
    }
    log('[switch] 已清理 WorkBuddy 登录退出标记');
    return true;
  } catch (e) {
    if (IS_WIN) {
      throw new Error(`清理登录退出标记失败(${e.code || ''}): ${(e.message || e).toString().slice(0, 200)}`);
    }
    // WorkBuddy may launch the daemon in a sandbox that cannot unlink auth files.
    try {
      const { execFileSync } = require('child_process');
      const markerQ = marker.replace(/"/g, '\\"');
      execFileSync('osascript', ['-e', `do shell script "rm -f \\\"${markerQ}\\\""`], {
        timeout: 15000,
        stdio: 'pipe',
      });
      if (fs.existsSync(LOGOUT_MARKER)) throw new Error('标记仍然存在');
      log('[switch] 已通过系统授权清理 WorkBuddy 登录退出标记');
      return true;
    } catch (e2) {
      throw new Error(`清理登录退出标记失败: ${(e2.message || e2).toString().slice(0, 200)}`);
    }
  }
}

/**
 * 兼容旧版账号备份：把 HelloBuddy/accounts 中尚未存在于 WorkDaddy 的账号复制过来。
 * 只对平台默认 WorkDaddy 目录执行，显式自定义数据目录不做隐式迁移。
 * 源目录和文件均保留，重复调用幂等。
 */
function migrateLegacyDataDir(dataDir, log = () => {}) {
  if (IS_WIN || !samePath(dataDir, PLATFORM_DATA_DIR)) {
    return { migrated: 0, skipped: 0, source: null, target: dataDir };
  }

  const sourceAccounts = accountsDir(LEGACY_DATA_DIR);
  if (!fs.existsSync(sourceAccounts)) {
    return { migrated: 0, skipped: 0, source: LEGACY_DATA_DIR, target: dataDir };
  }

  let names;
  try {
    names = fs
      .readdirSync(sourceAccounts)
      .filter((name) => name.endsWith('.info') && !name.endsWith('.tmp'));
  } catch (_) {
    return { migrated: 0, skipped: 0, source: LEGACY_DATA_DIR, target: dataDir };
  }

  const targetAccounts = accountsDir(dataDir);
  fs.mkdirSync(targetAccounts, { recursive: true, mode: 0o700 });
  let migrated = 0;
  let skipped = 0;
  for (const name of names) {
    const source = path.join(sourceAccounts, name);
    const target = path.join(targetAccounts, name);
    if (fs.existsSync(target)) {
      skipped += 1;
      continue;
    }
    try {
      fs.copyFileSync(source, target);
      fs.chmodSync(target, 0o600);
      migrated += 1;
    } catch (e) {
      log(`[migration] 迁移账号 ${name} 失败: ${e.message}`);
    }
  }
  if (migrated) {
    log(`[migration] 已从 ${LEGACY_DATA_DIR}/accounts 迁移 ${migrated} 个账号到 ${dataDir}/accounts`);
  }
  return { migrated, skipped, source: LEGACY_DATA_DIR, target: dataDir };
}

function ensureDirs(dataDir, log = () => {}) {
  migrateLegacyDataDir(dataDir, log);
  fs.mkdirSync(accountsDir(dataDir), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dataDir, 0o700);
  } catch (_) {
    /* 已存在时可能失败，忽略 */
  }
}

/** 读取登录信息文件并抽取账号关键字段（不返回令牌内容） */
function readAuthFile(file = currentAuthFile()) {
  if (!ACTIVE_PROFILE.authFile && !process.env.WBSWITCH_AUTH_FILE) {
    throw new Error(`${ACTIVE_PROFILE.name} 没有可读取的明文认证文件`);
  }
  if (!file) throw new Error('未找到唯一的当前登录信息文件');
  const info = parseAuthFile(file, { strict: DYNAMIC_AUTH_DISCOVERY });
  if (!info) throw new Error(`auth 文件无效或不属于当前客户端: ${path.basename(file)}`);
  return info;
}

/** 更新 meta.json（uid -> nickname/uin/phone/时间） */
function updateMeta(dataDir, info) {
  const meta = readMeta(dataDir);
  const now = Date.now();
  const prev = meta.accounts[info.uid] || {};
  meta.accounts[info.uid] = {
    uid: info.uid,
    nickname: info.nickname || prev.nickname || '',
    uin: info.uin || prev.uin || '',
    phone: info.phone || prev.phone || '',
    authFileName: info.authFileName || prev.authFileName || '',
    authDomain: info.authDomain || prev.authDomain || '',
    authIssuer: info.authIssuer || prev.authIssuer || '',
    firstSeen: prev.firstSeen || now,
    lastSeen: now,
  };
  writeMeta(dataDir, meta);
  return meta;
}

function backupAuthFile(dataDir, file, log = () => {}) {
  const info = readAuthFile(file);
  const dest = backupPath(dataDir, info.uid);
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, fs.readFileSync(file), { mode: 0o600 });
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o600);
  updateMeta(dataDir, info);
  log(`[sync] 已备份账号 ${info.nickname || info.uid} (${info.uid}) -> ${dest}`);
  return info;
}

/** 把活动登录信息备份到 accounts/<uid>.info（原子写入，0600）。 */
function backupCurrent(dataDir, log = () => {}) {
  if (!ACTIVE_PROFILE.capabilities.accounts) throw new Error(`${ACTIVE_PROFILE.name} 暂不支持账号文件备份`);
  ensureDirs(dataDir, log);
  const records = listAuthRecords();
  if (!records.length) throw new Error('未找到有效的登录信息文件');
  const current = resolveCurrentAuth();
  let result = null;
  for (const record of records) {
    const info = backupAuthFile(dataDir, record.file, log);
    if (!result || (current.file && samePath(record.file, current.file))) result = info;
  }
  return Object.assign(result, { backedUp: records.length, ambiguous: !!current.ambiguous });
}

function resolveAuthTarget(dataDir, uid, authJson) {
  if (!DYNAMIC_AUTH_DISCOVERY) return AUTH_FILE;
  const meta = readMeta(dataDir);
  const record = meta.accounts[String(uid)] || {};
  const backup = authRecordFromJson(null, authJson);
  if (!backup) throw new Error('备份文件认证数据无效，拒绝切换');
  const targetName = safeAuthFileName(record.authFileName) ? record.authFileName : '';
  if (targetName) {
    const target = path.join(authDir(), targetName);
    if (path.dirname(path.resolve(target)) !== path.resolve(authDir())) throw new Error('登录文件目标路径无效');
    const existing = fs.existsSync(target) ? parseAuthFile(target) : null;
    if (fs.existsSync(target) && !existing) throw new Error('登录文件目标不是当前客户端的有效认证文件，拒绝覆盖');
    if (existing && existing.uid !== String(uid)) throw new Error('登录文件名已属于其他账号，拒绝覆盖');
    return target;
  }
  const matching = listAuthRecords().filter((item) => item.uid === String(uid));
  if (matching.length === 1) return matching[0].file;
  throw new Error('账号缺少已确认的登录文件名，拒绝猜测写入目标');
}

/** 列出所有已备份账号（直接读备份文件提取展示字段，按最近刷新时间倒序） */
function listAccounts(dataDir) {
  if (!ACTIVE_PROFILE.capabilities.accounts) return [];
  migrateLegacyDataDir(dataDir);
  const dir = accountsDir(dataDir);
  let names = [];
  try {
    names = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.info') && !f.endsWith('.tmp'));
  } catch (_) {
    /* 目录不存在 */
  }
  const list = names.map((n) => {
    const uid = n.replace(/\.info$/, '');
    const item = {
      uid,
      nickname: '',
      phone: '',
      uin: '',
      tokenExpiresAt: null,
      refreshExpiresAt: null,
      lastRefreshTime: null,
      lastSeen: null,
    };
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      const acct = j.account || (Array.isArray(j.accounts) && j.accounts[0]);
      if (acct) {
        item.nickname = acct.nickname || '';
        item.phone = acct.phoneNumber || '';
        item.uin = acct.uin || '';
        item.type = typeof acct.type === 'string' ? acct.type : '';
        item.enterpriseName = typeof acct.enterpriseName === 'string' ? acct.enterpriseName.trim() : '';
      }
      if (j.auth) {
        item.tokenExpiresAt = j.auth.expiresAt || null;
        item.refreshExpiresAt = j.auth.refreshExpiresAt || null;
        item.lastRefreshTime = j.auth.lastRefreshTime || null;
      }
    } catch (_) {
      /* 文件损坏则显示空字段 */
    }
    return item;
  });
  return list.sort(
    (a, b) => (b.lastRefreshTime || 0) - (a.lastRefreshTime || 0)
  );
}

/** 永久删除某个账号的备份文件（不影响当前登录） */
function deleteAccount(dataDir, uid) {
  if (!ACTIVE_PROFILE.capabilities.accounts) throw new Error(`${ACTIVE_PROFILE.name} 暂不支持账号切换`);
  migrateLegacyDataDir(dataDir);
  const file = backupPath(dataDir, uid);
  let deletedFile = false;
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    deletedFile = true;
  }
  const mf = metaFile(dataDir);
  try {
    const meta = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (meta.accounts && meta.accounts[uid]) {
      delete meta.accounts[uid];
      fs.writeFileSync(mf, JSON.stringify(meta, null, 2), { mode: 0o600 });
    }
  } catch (_) {
    /* meta 不存在则忽略 */
  }
  return { deleted: deletedFile, uid };
}

/** 切换登录账号：把备份文件复制回登录信息文件（先校验 uid 匹配） */
function switchTo(dataDir, uid, log = () => {}) {
  if (!ACTIVE_PROFILE.capabilities.accounts) throw new Error(`${ACTIVE_PROFILE.name} 暂不支持账号切换`);
  migrateLegacyDataDir(dataDir, log);
  // 不再用「当前 auth 目录是否 ambiguous」一票否决：切换写入的目标文件由
  // resolveAuthTarget 精确决定（meta.json 记录 / 唯一 uid 匹配），目标无法唯一
  // 确定时它自己会拒绝，避免历史 lastLogin 残留导致已登录账号切不回去。
  const src = backupPath(dataDir, uid);
  if (!fs.existsSync(src)) {
    throw new Error(`未找到账号 ${uid} 的备份文件`);
  }
  const raw = fs.readFileSync(src, 'utf8');
  const json = JSON.parse(raw);
  const acct = json.account || (Array.isArray(json.accounts) && json.accounts[0]);
  if (!acct || acct.uid !== uid) {
    throw new Error('备份文件校验失败：uid 不匹配，已中止切换');
  }
  const target = resolveAuthTarget(dataDir, uid, json);
  if (!target) throw new Error('未找到该账号已记录的登录文件名，拒绝猜测写入目标');
  const tmp = target + '.wbswitch.tmp';
  try {
    fs.writeFileSync(tmp, raw, { mode: 0o600 });
    fs.renameSync(tmp, target);
    fs.chmodSync(target, 0o600);
  } catch (e) {
    // 沙箱环境（如从 WorkBuddy 托管后台运行）直接写系统目录会 EPERM。
    // macOS 回退：osascript 委托 GUI 会话复制（不涉及内容转义，只传路径）。
    // Windows：目录在 %LOCALAPPDATA% 用户可写区，直写失败即如实报错。
    if (IS_WIN) {
      throw new Error(
        `写入登录文件失败(${e.code || ''}): ${(e.message || e).toString().slice(0, 200)}`
      );
    }
    log(`[switch] 直写失败(${e.code})，改用 osascript 委托写入`);
    const bridge = path.join(dataDir, '.auth-switch-bridge.tmp');
    const authBridge = target + '.wbswitch.tmp';
    const bridgeQ = bridge.replace(/"/g, '\\"');
    const authQ = target.replace(/"/g, '\\"');
    const tmpQ = authBridge.replace(/"/g, '\\"');
    try {
      // 1) 本进程写 bridge（数据目录可写）
      fs.writeFileSync(bridge, raw, { mode: 0o600 });
      // 2) osascript 委托：bridge -> auth 目录
      const script = `do shell script "cp \\"${bridgeQ}\\" \\"${tmpQ}\\" && mv \\"${tmpQ}\\" \\"${authQ}\\" && chmod 600 \\"${authQ}\\" && rm -f \\"${bridgeQ}\\" && echo OK"`;
      const { execFileSync } = require('child_process');
      execFileSync('osascript', ['-e', script], { timeout: 15000, stdio: 'pipe' });
    } catch (e2) {
      try { fs.unlinkSync(bridge); } catch (_) {}
      throw new Error(`写入登录文件失败: ${(e2.message || e2).toString().slice(0, 200)}`);
    }
  }
  // Legacy call shape retained for source-compatible launchers: retireLogoutMarker(log);
  retireLogoutMarker(log, target);
  updateMeta(dataDir, {
    uid: acct.uid,
    nickname: acct.nickname || '',
    uin: acct.uin || '',
    phone: acct.phoneNumber || '',
    authFileName: path.basename(target),
    authDomain: normalizeAuthDomain(json.auth && json.auth.domain),
    authIssuer: tokenIssuerOrigin(json.auth && (json.auth.accessToken || json.auth.access_token)),
  });
  log(`[switch] 已切换登录账号为 ${acct.nickname || uid} (${uid})`);
  return { uid: acct.uid, nickname: acct.nickname || '', uin: acct.uin || '', authFile: target };
}

module.exports = {
  AUTH_FILE,
  authDir,
  safeAuthFileName,
  normalizeAuthDomain,
  tokenIssuerOrigin,
  parseAuthFile,
  listAuthRecords,
  resolveCurrentAuth,
  currentAuthFile,
  resolveAuthTarget,
  ACTIVE_PROFILE,
  defaultDataDir,
  migrateLegacyDataDir,
  accountsDir,
  metaFile,
  workbuddyModelsFile,
  modelBackupsDir,
  maskApiKey,
  sanitizeModel,
  checkinDisplayValue,
  listOfficialModels,
  readOfficialModel,
  readModelBackup,
  deleteOfficialModels,
  listModelBackups,
  backupOfficialModel,
  copyModelBackup,
  editModelBackup,
  deleteModelBackups,
  enableModelBackup,
  importModels,
  logFile,
  backupPath,
  retireLogoutMarker,
  ensureDirs,
  readAuthFile,
  updateMeta,
  canonicalWorkspace,
  getAutoCopyRules,
  dedupeAutoCopySessionRows,
  setAutoCopyRule,
  setAutoCopyAllSessions,
  isAutoCopySessionSelected,
  getAutoCopySession,
  getAutoCopySessionMembers,
  getAutoCopySessionMemberRecords,
  selectLatestAutoCopyMember,
  ensureAutoCopySessions,
  ensureAutoCopySession,
  normalizeAutoCopyLineages,
  addAutoCopySessionMember,
  removeAutoCopySessionMember,
  moveAutoCopySession,
  removeAutoCopySession,
  removeAutoCopyAccount,
  getAutoCopyMapping,
  setAutoCopyMapping,
  deleteAutoCopyMapping,
  backupCurrent,
  listAccounts,
  switchTo,
  deleteAccount,
};
