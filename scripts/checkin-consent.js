'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readAutomations, writeAutomations } = require('./automation');
const { replaceFileWithRetry } = require('./atomic-file-write');
const TASK_ID = 'daily-account-checkin';
const stateFile = dir => path.join(dir, 'checkin-consent.json');

function readState(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));
    return value && value.version === 1 ? value : {};
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}
function saveState(dir, value) {
  fs.mkdirSync(dir, { recursive: true });
  replaceFileWithRetry(stateFile(dir), JSON.stringify({ version: 1, ...value }) + '\n', 0o600);
}

// Migrate before any startup events or schedules. Only this built-in is affected;
// later manual task edits remain authoritative, including after cancellation.
function initializeCheckinConsent(dir) {
  const state = readState(dir);
  if (state.initialized === true) return;
  const tasks = readAutomations(dir);
  const task = tasks.find(item => item.id === TASK_ID);
  if (task && task.enabled !== false) {
    task.enabled = false;
    writeAutomations(dir, tasks);
  }
  saveState(dir, { initialized: true, decision: null });
}

function readCheckinConsent(dir) {
  const state = readState(dir);
  const task = readAutomations(dir).find(item => item.id === TASK_ID);
  const decided = state.decision === 'enabled' || state.decision === 'cancelled';
  return { ok: true, shouldPrompt: !!task && !decided, enabled: !!task && task.enabled !== false };
}

function decideCheckinConsent(dir, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Invalid check-in choice');
  initializeCheckinConsent(dir);
  const state = readState(dir);
  // First persisted decision wins, including requests from another renderer.
  if (state.decision === 'enabled' || state.decision === 'cancelled') return readCheckinConsent(dir);
  const tasks = readAutomations(dir);
  const index = tasks.findIndex(item => item.id === TASK_ID);
  if (enabled && index < 0) throw new Error('Check-in task no longer exists');
  const next = tasks.map((task, i) => i === index ? { ...task, enabled } : task);
  if (index >= 0) writeAutomations(dir, next);
  try {
    saveState(dir, { initialized: true, decision: enabled ? 'enabled' : 'cancelled', decidedAt: Date.now() });
  } catch (error) {
    if (index >= 0) writeAutomations(dir, tasks);
    throw error;
  }
  return readCheckinConsent(dir);
}

module.exports = { initializeCheckinConsent, readCheckinConsent, decideCheckinConsent };
