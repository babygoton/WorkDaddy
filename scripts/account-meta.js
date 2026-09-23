'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { replaceFileWithRetry } = require('./atomic-file-write');

// 账号本地元数据：备注（note）+ 上次使用时间（lastSwitchAt）。
// 仅存 UI 展示用的用户数据，不存任何鉴权信息；文件损坏可安全丢弃重建。
const NOTE_MAX = 32;
function emptyMeta() { return { note: '', lastSwitchAt: 0 }; }
function sanitizeUid(uid) { return typeof uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(uid); }
function projection(value) {
  const meta = value && typeof value === 'object' ? value : {};
  return {
    note: typeof meta.note === 'string' ? meta.note.slice(0, NOTE_MAX) : '',
    lastSwitchAt: typeof meta.lastSwitchAt === 'number' && Number.isFinite(meta.lastSwitchAt) && meta.lastSwitchAt > 0 ? meta.lastSwitchAt : 0,
  };
}
function createAccountMetaStore(dataDir) {
  const file = path.join(dataDir, 'account-meta.json');
  const entries = new Map();
  try {
    for (const [uid, value] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
      if (!sanitizeUid(uid) || !value || typeof value !== 'object') continue;
      entries.set(uid, projection(value));
    }
  } catch (_) { /* 缺失或损坏的可选元数据可安全丢弃。 */ }
  function persist() {
    fs.mkdirSync(dataDir, { recursive: true });
    replaceFileWithRetry(file, JSON.stringify(Object.fromEntries(entries)), 0o600);
  }
  function get(uid) {
    if (!sanitizeUid(uid)) return emptyMeta();
    const value = entries.get(uid);
    return value ? structuredClone(value) : emptyMeta();
  }
  function setNote(uid, note) {
    if (!sanitizeUid(uid)) return get(uid);
    const meta = get(uid);
    meta.note = String(note == null ? '' : note).trim().slice(0, NOTE_MAX);
    if (meta.note || meta.lastSwitchAt) entries.set(uid, meta); else entries.delete(uid);
    persist();
    return meta;
  }
  function markSwitch(uid) {
    if (!sanitizeUid(uid)) return get(uid);
    const meta = get(uid);
    meta.lastSwitchAt = Date.now();
    entries.set(uid, meta);
    persist();
    return meta;
  }
  function all() {
    const out = {};
    for (const [uid, meta] of entries) out[uid] = structuredClone(meta);
    return out;
  }
  return { get, setNote, markSwitch, all };
}
module.exports = { createAccountMetaStore };
