'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const daemon = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const inject = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
test('a planning failure has a distinct task error, safe cause and visible details with zero item failures', async () => {
  const ctx = { crypto, Date, autoCopyJobs: new Map(), autoCopyQueue: [], autoCopyWorkerRunning: false,
    yieldAutoCopyToRenderer: async () => {}, buildAutoCopyPlan: async () => { throw Error('SQLITE_BUSY'); },
    log() {}, recordAccountSyncResult() {}, pruneAutoCopyJobs() {},
    sanitizeSessionCopyError: require('../scripts/session-copy-error').sanitizeSessionCopyError,
    setTimeout: () => ({ unref() {} }),
  };
  vm.runInNewContext(daemon.slice(daemon.indexOf('function runAutoCopyQueue('), daemon.indexOf('function activeAutoCopyJob(')), ctx);
  const job = ctx.startAutoCopyJob('a', 'b', []);
  await job.completion;
  const publicJob = ctx.publicAutoCopyJob(job);
  assert.equal(publicJob.status, 'error');
  assert.equal(publicJob.failed, 0);
  assert.equal(publicJob.taskFailed, true);
  assert.match(publicJob.error, /占用/);
  const ui = {};
  vm.runInNewContext(inject.slice(inject.indexOf('    function sessionCopyFailedItems('), inject.indexOf('    function renderSessionCopyNoticeSummary(')), ui);
  assert.match(ui.sessionCopySummaryText(publicJob), /任务失败/);
  assert.equal(ui.sessionCopyNoticeGroups(publicJob).failed[0].label, '同步任务');
  assert.match(ui.sessionCopyNoticeGroups(publicJob).failed[0].error, /占用/);
  assert.match(inject, /\.wbs-sess-copy-progress\.is-error \.wbs-sess-copy-detail\{[^}]*white-space:normal/,
    'a task-level cause must wrap instead of being ellipsized in the panel');
});

test('sync task errors never expose SQL, credentials, composer contents or local paths', () => {
  const { sanitizeSessionCopyError } = require('../scripts/session-copy-error');
  for (const sensitive of [
    'SQLITE_ERROR: SELECT private_conversation FROM sessions token=secret',
    'unexpected composer text or database row payload',
    'EACCES: permission denied, open /Users/private/secret-file',
    'Authorization: Bearer synthetic-secret',
  ]) {
    const safe = sanitizeSessionCopyError(Error(sensitive));
    assert.doesNotMatch(safe, /secret|private|SELECT|composer|Bearer/);
    assert.ok(safe.length > 0);
  }
});
