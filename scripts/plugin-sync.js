/**
 * CodeBuddy 插件（tencent-cloud.coding-copilot）账号同步 - 纯逻辑层
 *
 * 目标：Cursor / VS Code 等类 VSCode 编辑器的插件凭据存在
 *   %APPDATA%\<Editor>\User\globalStorage\state.vscdb（SQLite ItemTable）
 *   key = secret://{"extensionId":"tencent-cloud.coding-copilot","key":"Tencent-Cloud.coding-copilot.new.accessToken"}
 * value 为 {"type":"Buffer","data":[...]} 的 JSON 包装，字节布局：
 *   "v10"(3) + nonce(12) + AES-256-GCM 密文 + tag(16)
 * AES key 由 <Editor>/Local State 的 os_crypt.encrypted_key（DPAPI 保护）解出（见 daemon 接入层）。
 *
 * 账户切换 = 以插件现有明文为模板，仅替换会话字段 + account 身份，重新加密写回。
 * 防串号：备份 account.uid 与请求 uid、写回读回后的 account.uid 三重比对（uid 是账号唯一 ID）。
 *
 * 参考：docs/VSCode插件凭据与账户切换技术总结.md（实测验证的字段映射与自我修复行为）。
 */
'use strict';

const path = require('path');
const crypto = require('crypto');

const PLUGIN_EXTENSION_ID = 'tencent-cloud.coding-copilot';
// 注意：真实 ItemTable 中 key 字段为大写前缀 Tencent-Cloud…（与 extensionId 大小写不一致，按实测原样匹配）
const PLUGIN_SECRET_KEY = `secret://{"extensionId":"${PLUGIN_EXTENSION_ID}","key":"Tencent-Cloud.coding-copilot.new.accessToken"}`;

// 仅支持已实测的编辑器；新增 fork 时先按 docs 文档验证数据布局后再加。
const PLUGIN_SYNC_EDITORS = [
  { id: 'cursor', label: 'Cursor', dirName: 'Cursor', processName: 'Cursor' },
  { id: 'vscode', label: 'VS Code', dirName: 'Code', processName: 'Code' },
];

function findPluginSyncEditor(id) {
  const key = String(id || '').trim().toLowerCase();
  return PLUGIN_SYNC_EDITORS.find((editor) => editor.id === key) || null;
}

function pluginSyncEditorPaths(editor, appDataDir) {
  const base = path.join(appDataDir, editor.dirName);
  return {
    localState: path.join(base, 'Local State'),
    stateDb: path.join(base, 'User', 'globalStorage', 'state.vscdb'),
  };
}

/* ---------- 凭据密文包装 ---------- */

/** ItemTable value（TEXT JSON 包装或 BLOB）→ v10+nonce+ct+tag 字节 */
function secretValueToBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  const text = String(value == null ? '' : value);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('插件凭据不是有效的 JSON Buffer 包装');
  }
  if (!parsed || parsed.type !== 'Buffer' || !Array.isArray(parsed.data)) {
    throw new Error('插件凭据缺少 Buffer 数据');
  }
  return Buffer.from(parsed.data);
}

/** 加密后的字节 → ItemTable value（JSON 包装，nonce 每次随机） */
function bufferToSecretValue(blob) {
  return JSON.stringify({ type: 'Buffer', data: Array.from(blob) });
}

function decryptSecretBuffer(key, blob) {
  const version = blob.subarray(0, 3).toString('latin1');
  if (version !== 'v10') {
    throw new Error(`不支持的插件凭据加密版本: ${JSON.stringify(version)}`);
  }
  if (blob.length < 3 + 12 + 16) {
    throw new Error('插件凭据密文长度异常');
  }
  const nonce = blob.subarray(3, 15);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(15, blob.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptSecretBuffer(key, plainBuffer) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, ciphertext, tag]);
}

/* ---------- 明文合并与 uid 校验 ---------- */

/**
 * 校验 WorkBuddy 账号备份并取出同步所需的 account/auth。
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
    throw new Error('账号备份 uid 与请求不一致，已中止同步');
  }
  const auth = backup.auth && typeof backup.auth === 'object' ? backup.auth : null;
  if (!auth || !auth.accessToken || !auth.refreshToken) {
    throw new Error('账号备份缺少 accessToken/refreshToken，无法同步插件');
  }
  return { account, auth };
}

/**
 * 以插件现有明文为模板构造新明文（深浅拷贝混合：顶层浅拷贝 + account/auth/accounts 重建）。
 *
 * 字段映射（实测验证，见 docs 技术总结）：
 *   token        ← backup.auth.accessToken（RS256 JWT）
 *   refreshToken ← backup.auth.refreshToken（HS512 JWT）
 *   accessToken  ← backup.auth.accessToken（原生为 uid 前缀会话串；塞 JWT 插件刷新一轮即自我修复）
 *   expiresAt    ← backup.auth.expiresAt（缺失时容忍，保留模板字段）
 *   account/accounts ← 备份账号对象（其他账户项保留、同 uid 旧项移除、新账号置顶）
 *   内层 auth    ← 备份 auth 覆盖同名键（插件明文的 auth 与顶层会话字段实测同值同源）
 *   id/domain/converted 等其余字段保留插件模板。
 */
function buildPluginSecretPlain(template, backup, targetUid) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new Error('插件当前凭据明文结构无效');
  }
  const { account, auth } = normalizeBackup(backup, targetUid);

  const next = Object.assign({}, template);
  next.token = String(auth.accessToken);
  next.refreshToken = String(auth.refreshToken);
  next.accessToken = String(auth.accessToken);
  if (auth.expiresAt != null) next.expiresAt = auth.expiresAt;

  next.account = Object.assign({}, account);
  const others = Array.isArray(template.accounts)
    ? template.accounts.filter((item) => !item || String(item.uid || '') !== String(account.uid))
    : [];
  next.accounts = [Object.assign({}, account)].concat(others);

  if (template.auth && typeof template.auth === 'object' && !Array.isArray(template.auth)) {
    next.auth = Object.assign({}, template.auth, auth);
  }
  return next;
}

/** 写回读回后的校验：插件凭据中的账号必须是目标账号（uid 为账号唯一标识）。 */
function verifySyncedPlain(plain, targetUid) {
  const uid = plain && plain.account && plain.account.uid;
  if (String(uid || '') !== String(targetUid)) {
    const shown = uid ? String(uid).slice(0, 8) : '空';
    throw new Error(`写回校验失败：插件凭据中的账号(${shown})与目标账号不一致`);
  }
  if (!plain.token || !plain.refreshToken) {
    throw new Error('写回校验失败：插件凭据缺少 token/refreshToken');
  }
  return true;
}

module.exports = {
  PLUGIN_SECRET_KEY,
  PLUGIN_SYNC_EDITORS,
  findPluginSyncEditor,
  pluginSyncEditorPaths,
  secretValueToBuffer,
  bufferToSecretValue,
  decryptSecretBuffer,
  encryptSecretBuffer,
  normalizeBackup,
  buildPluginSecretPlain,
  verifySyncedPlain,
};
