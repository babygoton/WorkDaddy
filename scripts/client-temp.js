'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { replaceFileWithRetry } = require('./atomic-file-write');
const RETENTION_DAYS = 7;
const MAX_ENTRIES = 30000;
const SCAN_TIMEOUT_MS = 10000;

function supported(profile, platform) {
  return platform === 'win32' && !profile.customTarget && ['workbuddy-cn', 'workbuddy-ai'].includes(profile.id);
}

function paths(dataDir, profile) {
  if (!path.isAbsolute(dataDir)) throw new Error('临时文件数据目录必须是绝对路径');
  return {
    parent: path.join(dataDir, 'client-tmp'),
    root: path.join(dataDir, 'client-tmp', profile.id),
    state: path.join(dataDir, `client-temp-cleanup-${profile.id}.json`),
    lock: path.join(dataDir, `.client-temp-cleanup-${profile.id}.lock`),
  };
}

function readState(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw Error();
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || typeof state.pending !== 'boolean' || (state.pending &&
        (!Number.isFinite(state.requestedAt) || state.requestedAt <= 0 || typeof state.id !== 'string'))) throw Error();
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { pending: false };
    throw new Error('临时文件清理设置无法读取，请检查数据目录');
  }
}

function saveState(file, state) {
  readState(file); // Reject links and malformed settings instead of replacing them.
  replaceFileWithRetry(file, JSON.stringify(state) + '\n', 0o600);
}

function checkCleanupLock(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 40) throw Error('invalid');
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('invalid');
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') { fs.unlinkSync(file); return; }
    }
  } catch (error) {
    if (error.code === 'ENOENT') return;
  }
  throw new Error('临时文件清理已在进行或锁状态无法验证，请稍后启动');
}

async function assertRoot(locations) {
  for (const file of [locations.parent, locations.root]) {
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('临时文件目录不是普通目录，已停止清理');
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

// No file contents or names leave this module. Never follow links or remove
// updater caches: cached Setup.exe may be a pending official client update.
async function scanEntry(file, cutoff, budget, depth = 0) {
  if (++budget.count > MAX_ENTRIES || Date.now() > budget.deadline || depth > 64) throw new Error('临时文件统计未完成，请稍后重试');
  const stat = await fs.promises.lstat(file);
  let safe = !stat.isSymbolicLink() && !/^workbuddy-update(?:-|$)/i.test(path.basename(file));
  let bytes = stat.isFile() ? stat.size : 0;
  let old = stat.mtimeMs < cutoff;
  const digest = crypto.createHash('sha256').update([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'));
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of (await fs.promises.readdir(file)).sort()) {
      const child = await scanEntry(path.join(file, name), cutoff, budget, depth + 1);
      bytes += child.bytes;
      old = old && child.old;
      safe = safe && child.safe;
      digest.update(JSON.stringify([name, child.signature]));
    }
  } else if (!stat.isFile() || stat.nlink !== 1) safe = false;
  return { bytes, old, safe, signature: digest.digest('hex') };
}

async function scan(locations, cutoff) {
  const result = { bytes: 0, cleanableBytes: 0, incomplete: false, entries: [] };
  if (!await assertRoot(locations)) return result;
  const budget = { count: 0, deadline: Date.now() + SCAN_TIMEOUT_MS };
  for (const name of await fs.promises.readdir(locations.root)) {
    try {
      const entry = await scanEntry(path.join(locations.root, name), cutoff, budget);
      result.bytes += entry.bytes;
      if (entry.safe && entry.old) {
        result.cleanableBytes += entry.bytes;
        result.entries.push({ name, ...entry });
      }
    } catch (_) { result.incomplete = true; }
    if (budget.count > MAX_ENTRIES || Date.now() > budget.deadline) break;
  }
  return result;
}

async function inspectClientTemp(dataDir, profile, platform = process.platform) {
  if (!supported(profile, platform)) return { supported: false };
  const locations = paths(dataDir, profile);
  const state = readState(locations.state);
  const { entries, ...sizes } = await scan(locations, (state.pending ? state.requestedAt : Date.now()) - RETENTION_DAYS * 86400000);
  return { supported: true, retentionDays: RETENTION_DAYS, pending: state.pending, lastResult: state.lastResult || null, ...sizes };
}

function requestClientTempCleanup(dataDir, profile, pending, platform = process.platform) {
  if (!supported(profile, platform) || typeof pending !== 'boolean') throw new Error('仅 Windows WorkBuddy 支持布尔值清理请求');
  const locations = paths(dataDir, profile);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const old = readState(locations.state);
  saveState(locations.state, { pending, id: crypto.randomUUID(), requestedAt: Date.now(), lastResult: old.lastResult || null });
  return { supported: true, pending };
}

async function runPendingClientTempCleanup(dataDir, profile, { platform = process.platform, isStopped } = {}) {
  if (!supported(profile, platform)) return { skipped: 'unsupported' };
  const locations = paths(dataDir, profile);
  // Even a cancelled request must not allow another launcher past an active cleanup.
  checkCleanupLock(locations.lock);
  let state;
  try { state = readState(locations.state); } catch (_) { return { skipped: 'invalid-settings' }; }
  if (!state.pending) return { skipped: 'not-requested' };
  const stopped = async () => { try { return typeof isStopped === 'function' && await isStopped() === true; } catch (_) { return false; } };
  if (!await stopped()) return { skipped: 'client-running-or-unknown' };
  // Another launcher must not start the client while this cleanup owns the lock.
  try { fs.writeFileSync(locations.lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('临时文件清理已在进行，请稍后启动');
    throw error;
  }
  const result = { removedBytes: 0, removedEntries: 0, skippedEntries: 0, incomplete: false };
  try {
    const cutoff = state.requestedAt - RETENTION_DAYS * 86400000;
    const planned = await scan(locations, cutoff);
    result.incomplete = planned.incomplete;
    let lastProcessCheck = 0;
    const deadline = Date.now() + 30000;
    for (const entry of planned.entries) {
      if (Date.now() > deadline) { result.incomplete = true; break; }
      const current = readState(locations.state);
      if (!current.pending || current.id !== state.id) return { ...result, skipped: 'cancelled' };
      if (Date.now() - lastProcessCheck > 2000) {
        if (!await stopped()) return { ...result, skipped: 'client-running' };
        lastProcessCheck = Date.now();
      }
      try {
        if (!await assertRoot(locations)) break;
        const target = path.join(locations.root, entry.name);
        const fresh = await scanEntry(target, cutoff, { count: 0, deadline: Date.now() + SCAN_TIMEOUT_MS });
        if (!fresh.safe || !fresh.old || fresh.signature !== entry.signature) { result.skippedEntries++; continue; }
        if (!await assertRoot(locations)) break;
        await fs.promises.rm(target, { recursive: true, force: false, maxRetries: 0 });
        result.removedBytes += entry.bytes;
        result.removedEntries++;
      } catch (_) { result.skippedEntries++; }
    }
    const current = readState(locations.state);
    if (current.id === state.id) saveState(locations.state, { pending: false, lastResult: { ...result, finishedAt: Date.now() } });
    return result;
  } catch (_) {
    return { ...result, skipped: 'scan-failed' };
  } finally { fs.unlinkSync(locations.lock); }
}

module.exports = { inspectClientTemp, requestClientTempCleanup, runPendingClientTempCleanup };
