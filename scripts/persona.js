'use strict';

// Only an explicit repair or shared-mode source selection imports a legacy profile.
// Metadata returned to the renderer never includes identity or memory contents.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { replaceFileWithRetry } = require('./atomic-file-write');
const IDENTITY_FILES = ['IDENTITY.md', 'USER.md', 'SOUL.md', 'MEMORY.md'];
const PERSONA_FILES = [...IDENTITY_FILES, 'workspace-state.json', 'BOOTSTRAP.md'];
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const PERSONA_MODES = ['unset', 'shared', 'independent'];

function validUid(uid) { return typeof uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(uid); }
function personaDir(root, uid) {
  if (!validUid(uid)) throw new Error('账号格式无效');
  return path.join(path.resolve(root), `user-${uid}-personal`);
}
function assertSafePath(file) {
  let cursor = path.resolve(file);
  for (;;) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('个性化设置路径不能包含符号链接'); }
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
      if (!stat.isFile()) throw new Error('个性化设置必须为普通文件');
      if (stat.size > MAX_FILE_SIZE) throw new Error('个性化设置文件过大，未执行复制');
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
  throw new Error('个性化设置状态文件无效，请先手动检查');
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
  if (usableSource(legacyFiles)) sources.push({ uid: 'legacy', nickname: '升级前共用的设置', files: IDENTITY_FILES.filter(name => nonempty(legacyFiles, name)) });
  return { uid: targetUid, status, eligible: ['missing', 'empty', 'bootstrap'].includes(status) && sources.length > 0, sources, revision };
}

// The configured backup root may be redirected (for example an AppData
// Junction). Canonicalize that trusted root, including a not-yet-created suffix;
// paths inside persona still pass through assertSafePath without following links.
function resolveBackupRoot(backupRoot) {
  let cursor = path.resolve(backupRoot);
  const missing = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cursor), ...missing); }
    catch (error) {
      const parent = path.dirname(cursor);
      if (error.code !== 'ENOENT' || parent === cursor) throw error;
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}
function personaSettingsFile(backupRoot) {
  const file = path.join(resolveBackupRoot(backupRoot), 'persona', 'settings.json');
  assertSafePath(file);
  return file;
}
function normalizePersonaSettings(value) {
  if (!value || !PERSONA_MODES.includes(value.mode) || typeof value.noticeDismissed !== 'boolean' ||
      (value.mode === 'shared' && !validUid(value.activeUid))) throw new Error('个性化设置无效');
  return { mode: value.mode, noticeDismissed: value.noticeDismissed, activeUid: value.mode === 'shared' ? value.activeUid : null };
}
function readPersonaSettings(backupRoot) {
  try {
    const file = personaSettingsFile(backupRoot), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) throw new Error('invalid');
    return normalizePersonaSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return { mode: 'unset', noticeDismissed: false, activeUid: null };
    throw new Error('个性化设置无法读取，请检查 WorkDaddy 的 persona 目录');
  }
}
function writePersonaSettings(backupRoot, value) {
  const settings = normalizePersonaSettings(value);
  const file = personaSettingsFile(backupRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  replaceFileWithRetry(file, JSON.stringify(settings, null, 2) + '\n', 0o600);
  return settings;
}
function dismissPersonaNotice(backupRoot) {
  return writePersonaSettings(backupRoot, { ...readPersonaSettings(backupRoot), noticeDismissed: true });
}
function sharedPersonaDir(backupRoot) {
  const dir = path.join(resolveBackupRoot(backupRoot), 'persona', 'shared');
  assertSafePath(dir);
  return dir;
}
function listPersonaSources({ dataRoot, accounts = [] }) {
  const sources = [];
  for (const account of [...accounts.filter(a => a.uid !== 'legacy'), { uid: 'legacy', nickname: '升级前共用的设置' }]) {
    const uid = String(account.uid || '');
    if (!validUid(uid)) continue;
    const files = snapshot(uid === 'legacy' ? path.resolve(dataRoot) : personaDir(dataRoot, uid));
    const available = usableSource(files);
    if (uid === 'legacy' && !available) continue;
    sources.push({ uid, nickname: String(account.nickname || uid), available,
      ...(available ? { files: IDENTITY_FILES.filter(name => nonempty(files, name)), revision: fingerprint(files) }
        : { unavailableReason: '未设置' }) });
  }
  return sources;
}
function backupPersonaDirectory(backupRoot, label, original) {
  const dir = path.join(resolveBackupRoot(backupRoot), 'persona', 'backups', label,
    `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
  assertSafePath(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of Object.keys(original)) fs.writeFileSync(path.join(dir, name), original[name].text, { mode: 0o600, flag: 'wx' });
}
// A single canonical copy is projected into WorkBuddy's required per-account files.
// WorkBuddy can edit the active projection; the switch seam captures it before auth changes.
function applySharedPersona(options, sourceFiles, settings) {
  const { dataRoot, backupRoot, targetUid } = options;
  if (!usableSource(sourceFiles)) throw new Error('来源个性化设置尚未完成，请先完成个性化设置');
  const targetDir = personaDir(dataRoot, targetUid);
  const sharedDir = sharedPersonaDir(backupRoot);
  const originalTarget = snapshot(targetDir), originalShared = snapshot(sharedDir);
  const targetState = stateOf(originalTarget);
  const completedState = { ...targetState, version: targetState.version || 1,
    onboardingCompletedAt: targetState.onboardingCompletedAt || new Date().toISOString() };
  const identity = Object.fromEntries(IDENTITY_FILES.filter(name => sourceFiles[name]).map(name => [name, sourceFiles[name]]));
  const nextTarget = { ...identity, 'workspace-state.json': { text: JSON.stringify(completedState, null, 2) + '\n', mode: 0o600 } };
  const settingsFile = personaSettingsFile(backupRoot);
  const oldSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
  const plans = [
    { dir: sharedDir, before: originalShared, after: identity, label: 'shared' },
    { dir: targetDir, before: originalTarget, after: nextTarget, label: targetUid },
  ].map(plan => ({ ...plan, existed: fs.existsSync(plan.dir), names: PERSONA_FILES.filter(name =>
    (plan.before[name] && plan.before[name].text) !== (plan.after[name] && plan.after[name].text)) }));
  for (const plan of plans) if (plan.names.length) backupPersonaDirectory(backupRoot, plan.label, plan.before);
  // Do not overwrite files WorkBuddy changed during backup creation.
  if (fingerprint(snapshot(options.sourceDir)) !== fingerprint(sourceFiles)) throw new Error('来源个性化设置已变化，请重试');
  for (const plan of plans) if (fingerprint(snapshot(plan.dir)) !== fingerprint(plan.before)) throw new Error('个性化设置已变化，请重试');
  const touched = [];
  let settingsTouched = false;
  function rollback() {
    try {
      for (const plan of touched.slice().reverse()) {
        for (const name of plan.names) {
          const file = path.join(plan.dir, name);
          if (plan.before[name]) replaceFileWithRetry(file, plan.before[name].text, plan.before[name].mode);
          else fs.rmSync(file, { force: true });
        }
        if (!plan.existed && !fs.readdirSync(plan.dir).length) fs.rmdirSync(plan.dir);
      }
      if (settingsTouched) {
        if (oldSettings === null) fs.rmSync(settingsFile, { force: true });
        else replaceFileWithRetry(settingsFile, oldSettings, 0o600);
      }
    } catch (_) { throw new Error('共享失败且回滚未完成，请从 WorkDaddy 的 persona/backups 目录恢复'); }
  }
  try {
    for (const plan of plans) {
      if (!plan.names.length) continue;
      fs.mkdirSync(plan.dir, { recursive: true, mode: 0o700 });
      touched.push(plan);
      for (const name of plan.names) {
        const file = path.join(plan.dir, name);
        assertSafePath(file);
        if (plan.after[name]) (options.replaceFile || replaceFileWithRetry)(file, plan.after[name].text, 0o600);
        else fs.rmSync(file, { force: true });
      }
    }
    settingsTouched = true;
    writePersonaSettings(backupRoot, settings);
  } catch (error) { rollback(); throw error; }
  return { changed: plans.some(plan => plan.names.length), rollback };
}
function configurePersona(options) {
  const settings = readPersonaSettings(options.backupRoot);
  if (!['shared', 'independent'].includes(options.mode)) throw new Error('个性化模式无效');
  if (options.mode === 'independent' || (settings.mode === 'shared' && options.mode === 'shared' && !options.sourceUid)) {
    return { settings: writePersonaSettings(options.backupRoot, { ...settings, mode: options.mode, noticeDismissed: true,
      activeUid: options.mode === 'shared' ? settings.activeUid : null }), changed: false };
  }
  if (!options.accounts.some(a => String(a.uid) === options.currentUid)) throw new Error('当前账号不存在');
  if (!scopedLayout(options.dataRoot)) throw new Error('当前版本尚未启用独立个性化目录，无需开启共享');
  const source = listPersonaSources(options).find(a => a.uid === options.sourceUid && a.available);
  if (!source) throw new Error('请选择可用的个性化设置来源');
  if (!options.revision || source.revision !== options.revision) throw new Error('来源个性化设置已变化，请重新选择');
  const sourceDir = source.uid === 'legacy' ? path.resolve(options.dataRoot) : personaDir(options.dataRoot, source.uid);
  const files = snapshot(sourceDir);
  if (fingerprint(files) !== options.revision) throw new Error('来源个性化设置已变化，请重新选择');
  const next = { mode: 'shared', noticeDismissed: true, activeUid: options.currentUid };
  const result = applySharedPersona({ ...options, sourceDir, targetUid: options.currentUid }, files, next);
  return { settings: next, changed: result.changed };
}
function syncSharedPersonaForSwitch(options) {
  const settings = readPersonaSettings(options.backupRoot);
  if (settings.mode !== 'shared' || options.sourceUid === options.targetUid) return { skipped: true };
  if (settings.activeUid !== options.sourceUid) throw new Error('当前账号已变化，请在账号设置中重新选择共享来源');
  if (!options.accounts.some(a => String(a.uid) === options.targetUid)) throw new Error('目标账号不存在');
  const sourceDir = personaDir(options.dataRoot, options.sourceUid);
  const files = snapshot(sourceDir);
  return applySharedPersona({ ...options, sourceDir }, files, { ...settings, activeUid: options.targetUid });
}
function copyPersona(options) {
  if (options.confirmed !== true) throw new Error('请先确认复制个性化设置');
  const preview = inspectPersona(options);
  if (!preview.eligible) throw new Error('该账号无需修复或没有可用来源');
  if (!options.revision || preview.revision !== options.revision) throw new Error('目标个性化设置已变化，请重新查看并确认');
  if (!preview.sources.some(source => source.uid === options.sourceUid)) throw new Error('个性化设置来源无效');
  const target = personaDir(options.dataRoot, options.targetUid);
  const source = options.sourceUid === 'legacy' ? path.resolve(options.dataRoot) : personaDir(options.dataRoot, options.sourceUid);
  const original = snapshot(target);
  const sourceFiles = snapshot(source);
  const state = { ...stateOf(original), version: stateOf(original).version || 1, onboardingCompletedAt: new Date().toISOString() };
  // Preserve target workspace metadata. Only the completed marker is repaired.
  const writes = {};
  for (const name of IDENTITY_FILES) if (nonempty(sourceFiles, name)) writes[name] = sourceFiles[name].text;
  writes['workspace-state.json'] = JSON.stringify(state, null, 2) + '\n';
  const backupDir = path.join(resolveBackupRoot(options.backupRoot), 'persona', options.targetUid, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
  assertSafePath(backupDir);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  for (const name of Object.keys(original)) fs.writeFileSync(path.join(backupDir, name), original[name].text, { mode: 0o600, flag: 'wx' });
  // WorkBuddy is another process: it may finish onboarding while we back up.
  if (fingerprint(snapshot(target)) !== preview.revision) throw new Error('目标个性化设置已变化，请重新查看并确认');
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
module.exports = {
  PERSONA_FILES, PERSONA_MODES, personaDir, inspectPersona, copyPersona,
  personaSettingsFile, readPersonaSettings, writePersonaSettings,
  sharedPersonaDir, listPersonaSources, configurePersona, dismissPersonaNotice, syncSharedPersonaForSwitch,
};
