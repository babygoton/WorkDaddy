'use strict';

const fs = require('fs');
const path = require('path');
const { readAutomations, writeAutomations } = require('./automation.js');

const SETTINGS_FILE = 'automation-sync.json';
const ACCOUNT_SCOPE_KEY = 'x-workdaddy-account-uids';

function cleanUid(value) {
  const uid = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(uid) ? uid : '';
}

function taskAccountUids(task) {
  const raw = task && task[ACCOUNT_SCOPE_KEY];
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.map(cleanUid).filter(Boolean))];
}

function taskVisibleToAccount(task, uid) {
  const scope = taskAccountUids(task);
  // Tasks written before account-aware syncing are intentionally global.
  return !scope || !scope.length || scope.includes(cleanUid(uid));
}

function scopeTaskToAccount(task, uid) {
  const accountUid = cleanUid(uid);
  if (!accountUid) return task;
  const scope = taskAccountUids(task) || [];
  if (scope.includes(accountUid)) return task;
  return { ...task, [ACCOUNT_SCOPE_KEY]: [...scope, accountUid] };
}

function isScheduledTask(task) {
  const schedule = task && task.schedule;
  return !!schedule && typeof schedule === 'object' && !Array.isArray(schedule) &&
    typeof schedule.type === 'string' && schedule.type !== 'manual';
}

function readAutomationSyncSettings(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, SETTINGS_FILE), 'utf8'));
    return { enabled: value && value.enabled === true };
  } catch (_) {
    return { enabled: false };
  }
}

function readBuiltinTaskIds(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, 'automation-builtins.json'), 'utf8'));
    return new Set(Object.keys(value || {}).filter((id) => value[id] === true || value[id] && value[id].managed === true));
  } catch (_) {
    return new Set();
  }
}

function writeAutomationSyncSettings(dataDir, enabled) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, SETTINGS_FILE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ enabled: enabled === true }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { enabled: enabled === true };
}

function readAccountAutomations(dataDir, uid) {
  return readAutomations(dataDir).filter((task) => taskVisibleToAccount(task, uid));
}

function syncAutomationsToAccount(dataDir, sourceUid, targetUid) {
  const source = cleanUid(sourceUid);
  const target = cleanUid(targetUid);
  if (!source || !target || source === target) return { copied: 0, skipped: 0, total: 0 };
  const tasks = readAutomations(dataDir);
  const builtinIds = readBuiltinTaskIds(dataDir);
  const sourceTasks = tasks.filter((task) => taskVisibleToAccount(task, source) && isScheduledTask(task));
  let copied = 0;
  let skipped = 0;
  const next = tasks.map((task) => {
    const scope = taskAccountUids(task);
    // Legacy/global tasks already run for the target and need no mutation.
    if (!isScheduledTask(task) || builtinIds.has(String(task.id || ''))) return task;
    // Tasks created before account-aware syncing had no scope. Treat the first
    // explicit sync as the user's request to bind that legacy task to the
    // source and destination accounts; built-ins remain global.
    if (!scope || !scope.length) {
      copied++;
      return scopeTaskToAccount(scopeTaskToAccount(task, source), target);
    }
    if (!scope.includes(source)) return task;
    if (scope.includes(target)) { skipped++; return task; }
    copied++;
    return scopeTaskToAccount(task, target);
  });
  if (copied) writeAutomations(dataDir, next);
  return { copied, skipped, total: sourceTasks.length };
}

module.exports = {
  ACCOUNT_SCOPE_KEY,
  cleanUid,
  taskAccountUids,
  taskVisibleToAccount,
  isScheduledTask,
  scopeTaskToAccount,
  readAutomationSyncSettings,
  writeAutomationSyncSettings,
  readAccountAutomations,
  syncAutomationsToAccount,
};
