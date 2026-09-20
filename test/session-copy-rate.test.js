'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { readSnapshot, applySnapshot } = require('../scripts/session-sync');

test('copy byte count includes changed published payloads, excludes unchanged files, backups and deletions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-copy-rate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (id, name, bytes) => { const file = path.join(root, 'tasks', id, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  for (const id of ['a','b']) write(id, 'unchanged.bin', Buffer.alloc(1024 * 1024));
  write('a','changed.bin','new payload'); write('b','changed.bin','old'); write('b','removed.bin','removed');
  const snapshot = id => readSnapshot(root, id, ['a','b']);
  const options = { backupRoot: path.join(root, 'backups') };
  const result = await applySnapshot(snapshot('a'), snapshot('b'), options);
  assert.equal(result.copiedBytes, Buffer.byteLength('new payload'));
  assert.equal(result.totalBytes, 1024 * 1024 + result.copiedBytes);
  assert.equal((await applySnapshot(snapshot('a'), snapshot('b'), options)).copiedBytes, 0);
});

test('public copy rate excludes queue time, updates during work and freezes after completion', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  let now = 4000;
  const ctx = { Date: { now: () => now } };
  vm.runInNewContext(source.slice(source.indexOf('function publicAutoCopyJob('), source.indexOf('function activeAutoCopyJob(')), ctx);
  const job = { status: 'running', startedAt: 1000, copyStartedAt: 3000, copiedBytes: 1024 * 1024, processedBytes: 2 * 1024 * 1024, totalBytes: 4 * 1024 * 1024, finishedAt: null };
  assert.equal(ctx.publicAutoCopyJob(job).averageBytesPerSecond, 1024 * 1024);
  now = 5000; assert.equal(ctx.publicAutoCopyJob(job).averageBytesPerSecond, 512 * 1024);
  job.status = 'done'; job.finishedAt = 5000; now = 9000;
  assert.equal(ctx.publicAutoCopyJob(job).averageBytesPerSecond, 512 * 1024);
  assert.equal(ctx.publicAutoCopyJob({ ...job, copiedBytes: 0 }).averageBytesPerSecond, 0);
  assert.equal(ctx.publicAutoCopyJob({ status: 'queued', copiedBytes: 0 }).averageBytesPerSecond, null);
});

test('copy notice formats rate units and tolerates older daemon responses', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  assert.match(source, /summary\.hidden = active/);
  assert.doesNotMatch(source, /active \? '已处理 ' \+ processed \+ ' 个候选会话'/);
  const ctx = {};
  vm.runInNewContext(source.slice(source.indexOf('    function sessionCopySizeText('), source.indexOf('    function showSessionCopyDetails(')), ctx);
  assert.equal(typeof ctx.sessionCopyTransferText, 'function');
  assert.equal(ctx.sessionCopyTransferText({}), '');
  assert.equal(ctx.sessionCopyTransferText({ processedBytes: 1024 ** 2 * 3, totalBytes: 1024 ** 2 * 8, averageBytesPerSecond: 1024 ** 2 * 1.5 }), '已同步 3.0 MB / 8.0 MB');
  assert.equal(ctx.sessionCopyTransferText({ processedBytes: 0, totalBytes: 0, averageBytesPerSecond: 0 }), '已同步 0 B / 0 B');
  assert.equal(ctx.sessionCopyTransferText({ processedBytes: 0, averageBytesPerSecond: null }), '已同步 0 B');
});
