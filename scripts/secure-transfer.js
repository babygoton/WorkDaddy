'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const zlib = require('node:zlib');

const MAX_PASSWORD_LENGTH = 1024;
const EXPORT_KDF = 'aes-256-gcm+scrypt';
const EXPORT_VERSION = 3;
const EXPORT_COMPRESSION = 'gzip';

function requiredPassword(value) {
  const password = typeof value === 'string' ? value : '';
  if (!password.trim()) throw new Error('密码不能为空');
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error('密码不能超过 1024 个字符');
  return password;
}

function exportSecretKey(password, salt) {
  return crypto.scryptSync(String(password), salt, 32);
}

function encryptBinary(plain, password) {
  const checkedPassword = requiredPassword(password);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', exportSecretKey(checkedPassword, salt), iv);
  const input = Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8');
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  return {
    data: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'),
    salt: salt.toString('base64'),
  };
}

function decryptBinary(data, password, saltBase64) {
  const checkedPassword = requiredPassword(password);
  const packed = Buffer.from(String(data || ''), 'base64');
  if (packed.length <= 28) throw new Error('导出数据不完整或已损坏');
  const salt = Buffer.from(String(saltBase64 || ''), 'base64');
  if (salt.length !== 16) throw new Error('导出文件缺少有效的加密 salt');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', exportSecretKey(checkedPassword, salt), packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
  } catch (_) {
    throw new Error('密码错误或导出文件已损坏');
  }
}

// v2 exports remain readable through the text helpers; new exports use the
// binary helper so compression happens before encryption and is authenticated.
function encryptExport(plain, password) {
  return encryptBinary(plain, password);
}

function decryptExport(data, password, saltBase64) {
  return decryptBinary(data, password, saltBase64).toString('utf8');
}

function normalizeExportKind(kind) {
  const value = String(kind || '').trim();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error('无效的导出类型');
  return value;
}

function createEncryptedExport(kind, payload, password, createdAt) {
  const normalizedKind = normalizeExportKind(kind);
  if (!payload || typeof payload !== 'object' || payload.exportType !== 'WorkDaddy-' + normalizedKind) {
    throw new Error('导出数据类型不匹配');
  }
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const encrypted = encryptBinary(compressed, password);
  return JSON.stringify({
    wbsExport: 'WorkDaddy',
    version: EXPORT_VERSION,
    exportType: normalizedKind,
    createdAt: createdAt || new Date().toISOString(),
    kdf: EXPORT_KDF,
    compression: EXPORT_COMPRESSION,
    salt: encrypted.salt,
    data: encrypted.data,
  });
}

function openEncryptedExport(content, expectedKind, password) {
  const normalizedKind = normalizeExportKind(expectedKind);
  let envelope;
  try { envelope = JSON.parse(String(content || '')); }
  catch (_) { throw new Error('文件不是有效的导出 JSON'); }
  if (!envelope || envelope.wbsExport !== 'WorkDaddy' || ![2, EXPORT_VERSION].includes(Number(envelope.version))) {
    throw new Error('不是有效的 WorkDaddy 加密导出文件');
  }
  if (envelope.exportType && envelope.exportType !== normalizedKind) throw new Error('导出文件类型不匹配');
  let payload;
  try {
    const plaintext = Number(envelope.version) === EXPORT_VERSION
      ? zlib.gunzipSync(decryptBinary(envelope.data, password, envelope.salt)).toString('utf8')
      : decryptExport(envelope.data, password, envelope.salt);
    payload = JSON.parse(plaintext);
  }
  catch (error) {
    if (/密码|损坏|salt/.test(String(error && error.message))) throw error;
    throw new Error('导出数据无法解析或已损坏');
  }
  if (!payload || payload.exportType !== 'WorkDaddy-' + normalizedKind) throw new Error('导出文件类型不匹配');
  return payload;
}

function remapSessionArchivePath(relativePath, oldId, newId) {
  const relative = String(relativePath || '');
  const sourceId = String(oldId || '');
  const targetId = String(newId || '');
  if (!relative || !sourceId || !targetId || relative.includes('\\') || relative.startsWith('/') || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('无效的会话归档路径');
  }
  const escaped = sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mappings = [
    [new RegExp('^projects/([^/]+)/' + escaped + '\\.jsonl$'), (match) => `projects/${match[1]}/${targetId}.jsonl`],
    [new RegExp('^projects/([^/]+)/' + escaped + '/(.+)$'), (match) => `projects/${match[1]}/${targetId}/${match[2]}`],
    [new RegExp('^(workspace/sessions|tasks|file-history)/' + escaped + '/(.+)$'), (match) => `${match[1]}/${targetId}/${match[2]}`],
    [new RegExp('^artifact-index/' + escaped + '\\.json$'), () => `artifact-index/${targetId}.json`],
  ];
  for (const [pattern, build] of mappings) {
    const match = pattern.exec(relative);
    if (match) return build(match);
  }
  throw new Error('会话归档包含不受支持的文件路径');
}

function resolveArchiveTarget(root, relativePath) {
  const base = path.resolve(String(root || ''));
  const target = path.resolve(base, String(relativePath || ''));
  const relative = path.relative(base, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('会话归档文件超出 WorkBuddy 数据目录');
  }
  return target;
}

module.exports = {
  EXPORT_VERSION,
  EXPORT_COMPRESSION,
  MAX_PASSWORD_LENGTH,
  createEncryptedExport,
  decryptExport,
  encryptExport,
  openEncryptedExport,
  remapSessionArchivePath,
  requiredPassword,
  resolveArchiveTarget,
};
