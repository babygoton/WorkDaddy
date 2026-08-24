/**
 * CodeBuddy CLI 认证文件写入（纯逻辑层）。
 *
 * CodeBuddy CLI（npm 包 @tencent-ai/codebuddy-code）的交互式登录凭证存在
 *   <sharedDataPath>/auth/<authId>.info
 * 其中 sharedDataPath = CodeBuddyExtension/Data/Public（与 WorkBuddy 的
 * workbuddy-desktop.info 同目录），authId 来自 product.json 的
 * authentication.id（实测为 "Tencent-Cloud.coding-copilot"）。
 *
 * 认证文件格式与 workbuddy-desktop.info 完全一致：
 *   { account, auth, accounts, allAccounts }
 * 敏感字段（auth.accessToken / auth.refreshToken / account.phoneNumber 等）
 * 在 WorkBuddy sidecar 不可用时以明文字符串存储，CLI 的 ProtectedJsonFields
 * 解码器遇到非加密 wrapper 的字符串值时直接当明文用（见 encode/decode 源码）。
 *
 * 切换 CLI 账号 = 把 WorkBuddy 账号备份的 JSON 原样写入 CLI 认证文件
 * （原子写 + uid 三重校验防串号，与 lib.js switchTo 同构）。不重启 WorkBuddy，
 * 不碰 WorkBuddy 自己的认证文件。CLI 下次读认证文件即生效（无需 helper）。
 *
 * macOS / Windows / Linux 均支持（路径按平台分支）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// CodeBuddy CLI product.json 的 authentication.id（实测）
const CLI_AUTH_ID = 'Tencent-Cloud.coding-copilot';

/**
 * CLI 认证文件所在目录（CodeBuddyExtension/Data/Public/auth）。
 * 与 WorkBuddy 的 workbuddy-desktop.info 同目录。
 */
function cliAuthDir() {
  const localSupport = IS_WIN
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : IS_MAC
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.local', 'share');
  return path.join(localSupport, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
}

/** CLI 认证文件完整路径。 */
function cliAuthFile() {
  return path.join(cliAuthDir(), `${CLI_AUTH_ID}.info`);
}

function readJsonFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (_) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function atomicWrite(file, content, mode) {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (_) {
    /* 目录已存在或不可创建，交给后续 writeSync 抛错 */
  }
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, { mode: mode || 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode || 0o600);
  } catch (_) {
    /* 某些平台 chmod 失败可忽略 */
  }
}

/**
 * 校验 WorkBuddy 账号备份并取出 account/auth（与 plugin-sync.js normalizeBackup 同构）。
 * 备份即 workbuddy-desktop.info 原文格式：{ account, auth, accounts, allAccounts }。
 */
function normalizeBackup(backup, targetUid) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    throw new Error('账号备份内容无效');
  }
  const account = backup.account && typeof backup.account === 'object'
    ? backup.account
    : (Array.isArray(backup.accounts) && backup.accounts[0]) || null;
  if (!account || !account.uid) throw new Error('账号备份中未找到 account.uid');
  if (String(account.uid) !== String(targetUid)) {
    throw new Error('账号备份 uid 与请求不一致，已中止 CLI 同步');
  }
  const auth = backup.auth && typeof backup.auth === 'object' ? backup.auth : null;
  if (!auth || !auth.accessToken) {
    throw new Error('账号备份缺少 accessToken，无法同步 CLI');
  }
  return { account, auth };
}

/**
 * 构造 CLI 认证文件内容（以 WorkBuddy 备份为模板，保留 CLI 既有非敏感字段）。
 *
 * 策略：以 CLI 现有认证文件为模板，仅替换 account / auth / accounts /
 * allAccounts 四段；其他顶层字段（如有）保留。若 CLI 认证文件不存在，
 * 则直接用 WorkBuddy 备份原文作为初始内容（与首次交互式登录产物同构）。
 */
function buildCliAuthContent(cliExisting, backup, targetUid) {
  const { account, auth } = normalizeBackup(backup, targetUid);
  if (cliExisting && typeof cliExisting === 'object' && !Array.isArray(cliExisting)) {
    const next = Object.assign({}, cliExisting);
    next.account = Object.assign({}, account);
    next.auth = Object.assign({}, auth);
    // accounts/allAccounts：以备份为准（去重目标 uid 后置顶）
    const others = Array.isArray(cliExisting.accounts)
      ? cliExisting.accounts.filter((item) => !item || String(item.uid || '') !== String(account.uid))
      : [];
    next.accounts = [Object.assign({}, account)].concat(others);
    const othersAll = Array.isArray(cliExisting.allAccounts)
      ? cliExisting.allAccounts.filter((item) => !item || String(item.uid || '') !== String(account.uid))
      : [];
    next.allAccounts = [Object.assign({}, account)].concat(othersAll);
    return next;
  }
  // 首次写入：直接用备份原文（已含 account/auth/accounts/allAccounts）
  return Object.assign({}, backup);
}

/** 写回读回校验：CLI 认证文件中的账号必须是目标账号。 */
function verifySyncedAuth(cliAuth, targetUid) {
  const account = cliAuth && cliAuth.account;
  const uid = account && account.uid;
  if (String(uid || '') !== String(targetUid)) {
    const shown = uid ? String(uid).slice(0, 8) : '空';
    throw new Error(`CLI 认证文件写回校验失败：账号(${shown})与目标不一致`);
  }
  const auth = cliAuth && cliAuth.auth;
  if (!auth || !auth.accessToken) {
    throw new Error('CLI 认证文件写回校验失败：缺少 accessToken');
  }
  return true;
}

/**
 * 清理 CLI 认证文件的登出标记（<authFile>.logged-out）。
 * CLI 的 FileAuthenticationStorage.store 在写入时若发现登出标记存在，
 * 整个写入会被短路跳过（首条件 !existsSync(marker) 为 false）；
 * 即便我们直接写文件，CLI 启动后看到标记仍认为处于登出状态而无视认证文件。
 * 所以切换账号时必须清理该标记（与 WorkBuddy lib.js retireLogoutMarker 同构）。
 */
function logoutMarkerPath(cliAuthFile) {
  return cliAuthFile + '.logged-out';
}

function retireLogoutMarker(cliAuthFile) {
  const marker = logoutMarkerPath(cliAuthFile);
  if (!fs.existsSync(marker)) return false;
  // rename 后删除，避免直接 unlink 在 Windows 上被锁
  const retired = `${marker}.retired.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(marker, retired);
    try { fs.unlinkSync(retired); } catch (_) {
      // 残留 retired 标记无害，且保持操作可恢复
    }
    return true;
  } catch (e) {
    if (IS_WIN) {
      throw new Error(`清理 CLI 登出标记失败(${e.code || ''}): ${(e.message || e).toString().slice(0, 200)}`);
    }
    // macOS 沙箱环境可能无权直接 unlink 认证目录文件，委托 osascript
    try {
      const { execFileSync } = require('child_process');
      const markerQ = marker.replace(/"/g, '\\"');
      execFileSync('osascript', ['-e', `do shell script "rm -f \\\"${markerQ}\\\""`], {
        timeout: 15000,
        stdio: 'pipe',
      });
      if (fs.existsSync(marker)) throw new Error('标记仍然存在');
      return true;
    } catch (e2) {
      throw new Error(`清理 CLI 登出标记失败: ${(e2.message || e2).toString().slice(0, 200)}`);
    }
  }
}

/**
 * 把指定 uid 的 WorkBuddy 账号备份写入 CLI 认证文件。
 * opts: { backupFile, cliAuthFile }
 *   backupFile  WorkBuddy 账号备份路径（accounts/<uid>.info）
 *   cliAuthFile CLI 认证文件路径（默认用 cliAuthFile() 推导）
 */
function syncAccount(uid, opts) {
  const o = opts || {};
  const id = String(uid || '').trim();
  if (!id) throw new Error('缺少 uid');
  const backupFile = o.backupFile;
  if (!backupFile) throw new Error('缺少 backupFile');
  if (!fs.existsSync(backupFile)) {
    const err = new Error('账号备份不存在：' + id);
    err.statusCode = 404;
    throw err;
  }
  const backup = readJsonFile(backupFile);
  if (!backup) {
    const err = new Error('账号备份损坏或不是有效 JSON：' + id);
    err.statusCode = 500;
    throw err;
  }
  // 提前校验 uid 匹配（防串号）
  normalizeBackup(backup, id);

  const target = o.cliAuthFile || cliAuthFile();
  const existing = readJsonFile(target);
  const content = buildCliAuthContent(existing, backup, id);
  atomicWrite(target, JSON.stringify(content, null, 2) + '\n', 0o600);

  // 读回校验
  const written = readJsonFile(target);
  verifySyncedAuth(written, id);

  // 清理登出标记：CLI 的 store 看到该标记会无视认证文件，导致「无账户模式」。
  // 必须在写文件后清理，确保 CLI 下次启动读到认证文件而非登出状态。
  let markerRetired = false;
  try {
    markerRetired = retireLogoutMarker(target);
  } catch (e) {
    // 清理失败是致命的：CLI 仍会处于登出状态，让上层报错
    const err = new Error(e.message + '（CLI 认证文件已写入但登出标记未清理，请手动删除 ' + logoutMarkerPath(target) + ' 后重试）');
    err.statusCode = 500;
    throw err;
  }

  return {
    ok: true,
    synced: true,
    activeUid: id,
    activeNickname: (content.account && content.account.nickname) || '',
    cliAuthFile: target,
    markerRetired: markerRetired,
  };
}

/**
 * 查询 CLI 认证状态（脱敏，不返回 token）。
 * opts: { cliAuthFile }
 */
function status(opts) {
  const o = opts || {};
  const target = o.cliAuthFile || cliAuthFile();
  const auth = readJsonFile(target);
  const logoutMarker = logoutMarkerPath(target);
  const loggedOut = fs.existsSync(logoutMarker);
  if (!auth) {
    return {
      configured: false,
      cliAuthFile: target,
      activeUid: '',
      activeNickname: '',
      loggedOut: loggedOut,
      logoutMarkerPath: logoutMarker,
    };
  }
  const account = auth.account || (Array.isArray(auth.accounts) && auth.accounts[0]);
  return {
    configured: true,
    cliAuthFile: target,
    activeUid: String((account && account.uid) || ''),
    activeNickname: String((account && account.nickname) || ''),
    loggedOut: loggedOut,
    logoutMarkerPath: logoutMarker,
  };
}

module.exports = {
  CLI_AUTH_ID,
  cliAuthDir,
  cliAuthFile,
  normalizeBackup,
  buildCliAuthContent,
  verifySyncedAuth,
  logoutMarkerPath,
  retireLogoutMarker,
  syncAccount,
  status,
};
