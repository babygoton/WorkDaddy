'use strict';

// Only explicit, confirmed repairs cross the global -> personal layout boundary.
// Metadata returned to the renderer never includes identity or memory contents.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { replaceFileWithRetry } = require('./atomic-file-write');
const IDENTITY_FILES = ['IDENTITY.md', 'USER.md', 'SOUL.md', 'MEMORY.md'];
const PERSONA_FILES = [...IDENTITY_FILES, 'workspace-state.json', 'BOOTSTRAP.md'];
const MAX_FILE_SIZE = 20 * 1024 * 1024;

function validUid(uid) { return typeof uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(uid); }
function personaDir(root, uid) {
  if (!validUid(uid)) throw new Error('账号格式无效');
  return path.join(path.resolve(root), `user-${uid}-personal`);
}
function assertSafePath(file) {
  let cursor = path.resolve(file);
  for (;;) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('身份档案路径不能包含符号链接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
function snapshot(dir) {
  assertSafePath(dir);
  const result = {};
  for (const name of PERSONA_FILES) {
    const file = path.join(dir, name);
    assertSafePath(file);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) throw new Error('身份档案必须为普通文件');
      if (stat.size > MAX_FILE_SIZE) throw new Error('身份档案文件过大，未执行复制');
      result[name] = { text: fs.readFileSync(file, 'utf8'), mode: stat.mode & 0o777 };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}
function stateOf(files) {
  if (!files['workspace-state.json']) return {};
  try {
    const value = JSON.parse(files['workspace-state.json'].text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch (_) {}
  throw new Error('身份档案状态文件无效，请先手动检查');
}
function fingerprint(files) { return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'); }
function nonempty(files, name) { return !!(files[name] && files[name].text.trim()); }
function usableSource(files) {
  // A partial/template source must never suppress the official onboarding.
  return ['IDENTITY.md', 'USER.md', 'SOUL.md'].every(name => nonempty(files, name)) &&
    (!files['BOOTSTRAP.md'] || !!stateOf(files).onboardingCompletedAt);
}
function scopedLayout(root) {
  assertSafePath(root);
  const marker = path.join(root, 'storage/device/global/user-data-migration.json');
  assertSafePath(marker);
  try {
    const stat = fs.statSync(marker);
    if (stat.size > MAX_FILE_SIZE) throw new Error('迁移状态文件过大');
    const data = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (data && data.migrationItems && data.migrationItems.persona) return true;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  try {
    return fs.readdirSync(root).some(name => /^user-[A-Za-z0-9_-]{1,128}-personal$/.test(name) && fs.lstatSync(path.join(root, name)).isDirectory());
  } catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}
function inspectPersona(options) {
  const { dataRoot, targetUid, accounts = [] } = options;
  const dir = personaDir(dataRoot, targetUid);
  if (!accounts.some(a => String(a.uid) === targetUid)) throw new Error('账号不存在');
  if (!scopedLayout(dataRoot)) return { uid: targetUid, status: 'legacy', eligible: false, sources: [] };
  const files = snapshot(dir);
  const state = stateOf(files);
  let status;
  if (state.onboardingCompletedAt || nonempty(files, 'MEMORY.md')) status = 'initialized';
  else if (files['BOOTSTRAP.md']) status = 'bootstrap';
  else if (IDENTITY_FILES.some(name => nonempty(files, name))) status = 'partial';
  else status = fs.existsSync(dir) ? 'empty' : 'missing';
  const revision = fingerprint(files);
  if (status === 'initialized' || status === 'partial') return { uid: targetUid, status, eligible: false, sources: [], revision };
  const sources = [];
  for (const account of accounts) {
    const uid = String(account.uid);
    if (!validUid(uid) || uid === targetUid || uid === 'legacy') continue;
    const sourceFiles = snapshot(personaDir(dataRoot, uid));
    if (usableSource(sourceFiles)) sources.push({ uid, nickname: String(account.nickname || uid), files: IDENTITY_FILES.filter(name => nonempty(sourceFiles, name)) });
  }
  const legacyFiles = snapshot(path.resolve(dataRoot));
  if (usableSource(legacyFiles)) sources.push({ uid: 'legacy', nickname: '旧版全局档案', files: IDENTITY_FILES.filter(name => nonempty(legacyFiles, name)) });
  return { uid: targetUid, status, eligible: ['missing', 'empty', 'bootstrap'].includes(status) && sources.length > 0, sources, revision };
}
function copyPersona(options) {
  if (options.confirmed !== true) throw new Error('请先确认复制身份档案');
  const preview = inspectPersona(options);
  if (!preview.eligible) throw new Error('该账号无需修复或没有可用来源');
  if (!options.revision || preview.revision !== options.revision) throw new Error('目标身份档案已变化，请重新查看并确认');
  if (!preview.sources.some(source => source.uid === options.sourceUid)) throw new Error('身份档案来源无效');
  const target = personaDir(options.dataRoot, options.targetUid);
  const source = options.sourceUid === 'legacy' ? path.resolve(options.dataRoot) : personaDir(options.dataRoot, options.sourceUid);
  const original = snapshot(target);
  const sourceFiles = snapshot(source);
  const state = { ...stateOf(original), version: stateOf(original).version || 1, onboardingCompletedAt: new Date().toISOString() };
  // Preserve target workspace metadata. Only the completed marker is repaired.
  const writes = {};
  for (const name of IDENTITY_FILES) if (nonempty(sourceFiles, name)) writes[name] = sourceFiles[name].text;
  writes['workspace-state.json'] = JSON.stringify(state, null, 2) + '\n';
  const backupDir = path.join(path.resolve(options.backupRoot), 'persona', options.targetUid, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
  assertSafePath(backupDir);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  for (const name of Object.keys(original)) fs.writeFileSync(path.join(backupDir, name), original[name].text, { mode: 0o600, flag: 'wx' });
  // WorkBuddy is another process: it may finish onboarding while we back up.
  if (fingerprint(snapshot(target)) !== preview.revision) throw new Error('目标身份档案已变化，请重新查看并确认');
  const existed = fs.existsSync(target);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const replace = options.replaceFile || replaceFileWithRetry;
  try {
    for (const name of Object.keys(writes)) replace(path.join(target, name), writes[name], 0o600);
    fs.rmSync(path.join(target, 'BOOTSTRAP.md'), { force: true });
  } catch (error) {
    try {
      for (const name of PERSONA_FILES) {
        if (original[name]) replaceFileWithRetry(path.join(target, name), original[name].text, original[name].mode);
        else fs.rmSync(path.join(target, name), { force: true });
      }
      if (!existed) fs.rmdirSync(target);
    } catch (_) { throw new Error('复制失败且回滚未完成，请从 WorkDaddy 的 persona 备份目录恢复'); }
    throw error;
  }
  return { status: 'copied', files: Object.keys(writes).length - 1, backupDir };
}
module.exports = { PERSONA_FILES, personaDir, inspectPersona, copyPersona };
