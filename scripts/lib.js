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

// WorkBuddyAI uses a distinct authentication id on Windows. Prefer an existing
// file so upgrades keep the active product line; only infer from installation
// paths when neither file has been created yet.
function defaultAuthFile() {
  if (!IS_WIN) {
    return path.join(
      os.homedir(),
      'Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info'
    );
  }
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const authDir = path.join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  const ai = path.join(authDir, 'workbuddy-desktop-ai.info');
  const legacy = path.join(authDir, 'workbuddy-desktop.info');
  if (fs.existsSync(ai)) return ai;
  if (fs.existsSync(legacy)) return legacy;
  return fs.existsSync(path.join(localAppData, 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'))
    ? ai
    : legacy;
}

const AUTH_FILE = process.env.WBSWITCH_AUTH_FILE || defaultAuthFile();

function defaultDataDir() {
  // 旧版 launchd 可能把 WBSWITCH_DATA_DIR 设成 HelloBuddy；新版本始终落到 WorkDaddy，
  // 避免旧服务被新 daemon 拉起后继续写入旧目录。
  const configured = process.env.WBSWITCH_DATA_DIR;
  return configured && !isLegacyDataDir(configured) ? configured : PLATFORM_DATA_DIR;
}

function accountsDir(dataDir) {
  return path.join(dataDir, 'accounts');
}
function metaFile(dataDir) {
  return path.join(dataDir, 'meta.json');
}
function logFile(dataDir) {
  return path.join(dataDir, 'daemon.log');
}
function validateUid(uid) {
  const value = String(uid || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('账号 uid 格式无效');
  }
  return value;
}
function backupPath(dataDir, uid) {
  return path.join(accountsDir(dataDir), `${validateUid(uid)}.info`);
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
function readAuthFile() {
  const raw = fs.readFileSync(AUTH_FILE, 'utf8');
  const json = JSON.parse(raw);
  if (!json || typeof json !== 'object') {
    throw new Error('auth 文件不是有效的 JSON 对象');
  }
  const acct = json.account || (Array.isArray(json.accounts) && json.accounts[0]) || null;
  if (!acct || !acct.uid) {
    throw new Error('auth 文件中未找到 account.uid');
  }
  return {
    uid: acct.uid,
    nickname: acct.nickname || '',
    uin: acct.uin || '',
    phone: acct.phoneNumber || '',
    type: acct.type || '',
    raw: json,
  };
}

/** 更新 meta.json（uid -> nickname/uin/phone/时间） */
function updateMeta(dataDir, info) {
  const mf = metaFile(dataDir);
  let meta = { accounts: {} };
  try {
    meta = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (!meta.accounts) meta.accounts = {};
  } catch (_) {
    /* 首次运行 */
  }
  const now = Date.now();
  const prev = meta.accounts[info.uid] || {};
  meta.accounts[info.uid] = {
    uid: info.uid,
    nickname: info.nickname || prev.nickname || '',
    uin: info.uin || prev.uin || '',
    phone: info.phone || prev.phone || '',
    firstSeen: prev.firstSeen || now,
    lastSeen: now,
  };
  fs.writeFileSync(mf, JSON.stringify(meta, null, 2), { mode: 0o600 });
  return meta;
}

/** 把当前登录信息备份到 accounts/<uid>.info（原子写入，0600） */
function backupCurrent(dataDir, log = () => {}) {
  ensureDirs(dataDir, log);
  const info = readAuthFile();
  const dest = backupPath(dataDir, info.uid);
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, fs.readFileSync(AUTH_FILE), { mode: 0o600 });
  fs.renameSync(tmp, dest);
  fs.chmodSync(dest, 0o600);
  updateMeta(dataDir, info);
  log(
    `[sync] 已备份账号 ${info.nickname || info.uid} (${info.uid}) -> ${dest}`
  );
  return info;
}

/** 列出所有已备份账号（直接读备份文件提取展示字段，按最近刷新时间倒序） */
function listAccounts(dataDir) {
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
  migrateLegacyDataDir(dataDir, log);
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
  const tmp = AUTH_FILE + '.wbswitch.tmp';
  try {
    fs.writeFileSync(tmp, raw, { mode: 0o600 });
    fs.renameSync(tmp, AUTH_FILE);
    fs.chmodSync(AUTH_FILE, 0o600);
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
    const authBridge = AUTH_FILE + '.wbswitch.tmp';
    const bridgeQ = bridge.replace(/"/g, '\\"');
    const authQ = AUTH_FILE.replace(/"/g, '\\"');
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
  log(`[switch] 已切换登录账号为 ${acct.nickname || uid} (${uid})`);
  return { uid: acct.uid, nickname: acct.nickname || '', uin: acct.uin || '' };
}

module.exports = {
  AUTH_FILE,
  defaultDataDir,
  migrateLegacyDataDir,
  accountsDir,
  metaFile,
  logFile,
  backupPath,
  validateUid,
  ensureDirs,
  readAuthFile,
  updateMeta,
  backupCurrent,
  listAccounts,
  switchTo,
  deleteAccount,
};
