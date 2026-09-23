'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { readSnapshot, readSnapshotAsync, applySnapshot, applySnapshotAsync } = require('../scripts/session-sync');

test('copy byte count includes changed published payloads, excludes unchanged files, backups and deletions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-copy-rate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (id, name, bytes) => { const file = path.join(root, 'tasks', id, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  for (const id of ['a','b']) write(id, 'unchanged.bin', Buffer.alloc(1024 * 1024));
  write('a','changed.bin','new payload'); write('b','changed.bin','old'); write('b','removed.bin','removed');
  const snapshot = id => readSnapshot(root, id, ['a','b']);
  const progress = [];
  const options = { backupRoot: path.join(root, 'backups'), onProgress: event => progress.push(event) };
  const result = await applySnapshot(snapshot('a'), snapshot('b'), options);
  assert.equal(result.copiedBytes, Buffer.byteLength('new payload'));
  assert.deepEqual(progress.map(event => event.bytes), [Buffer.byteLength('new payload')]);
  assert.equal(result.totalBytes, 1024 * 1024 + result.copiedBytes);
  assert.equal((await applySnapshot(snapshot('a'), snapshot('b'), options)).copiedBytes, 0);
});

test('async copy byte count reports published payloads before returning', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-copy-rate-async-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (id, name, bytes) => { const file = path.join(root, 'tasks', id, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  write('a', 'changed.bin', Buffer.alloc(1024 * 1024, 'a'));
  write('b', 'changed.bin', Buffer.from('old'));
  const source = await readSnapshotAsync(root, 'a', ['a', 'b']);
  const target = await readSnapshotAsync(root, 'b', ['a', 'b']);
  const progress = [];
  const result = await applySnapshotAsync(source, target, {
    backupRoot: path.join(root, 'backups'),
    onProgress: event => progress.push(event.bytes),
  });
  assert.deepEqual(progress, [1024 * 1024]);
  assert.equal(result.copiedBytes, 1024 * 1024);
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

test('copy notice omits transfer byte details', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  assert.match(source, /node\.hidden = !groups\.copied\.length && !groups\.failed\.length/);
  assert.match(source, /actions\.hidden = active \|\| !\(noticeGroups && \(noticeGroups\.copied\.length \|\| noticeGroups\.failed\.length\)\)/);
  assert.match(source, /wbs-session-copy-summary-label\{[^}]*margin:3px 0 2px[^}]*border-radius:999px/);
  assert.match(source, /wbs-session-copy-notice\.is-done \.wbs-session-copy-fill\{background:var\(--wb-button-primary-bg,#1f1f1f\)\}/);
  assert.doesNotMatch(source, /active \? '已处理 ' \+ processed \+ ' 个候选会话'/);
  const ctx = {};
  vm.runInNewContext(source.slice(source.indexOf('    function sessionCopyItemFailed('), source.indexOf('    function showSessionCopyDetails(')), ctx);
  assert.equal(typeof ctx.sessionCopyTransferText, 'function');
  assert.equal(ctx.sessionCopyTransferText({}), '');
  assert.equal(ctx.sessionCopyTransferText({ processedBytes: 1024 ** 2 * 3, copiedBytes: 1024 ** 2 * 1.5, totalBytes: 1024 ** 2 * 8, averageBytesPerSecond: 1024 ** 2 * 1.5 }), '');
  assert.equal(ctx.sessionCopyTransferText({ processedBytes: 0, copiedBytes: 0, totalBytes: 0, averageBytesPerSecond: 0 }), '');
  assert.equal(ctx.sessionCopyTransferText({ processedBytes: 0, averageBytesPerSecond: null }), '');
});

test('copy notice groups copied and failed titles with counts and skips skipped rows', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  const fakeDocument = {
    createElement: () => ({
      className: '', textContent: '', title: '',
      appendChild(child) { this.children = this.children || []; this.children.push(child); },
    }),
  };
  const ctx = { document: fakeDocument };
  vm.runInNewContext(source.slice(source.indexOf('    function sessionCopyItemFailed('), source.indexOf('    function showSessionCopyDetails(')), ctx);
  const summary = { textContent: 'old summary', hidden: false, children: [], appendChild(child) { this.children.push(child); } };
  ctx.renderSessionCopyNoticeSummary(summary, { details: [
    { label: '跳过会话', status: 'skipped' },
    { label: '会话一', status: 'copied' },
    { label: '失败会话', status: 'failed' },
    { label: '会话三', status: 'skipped' },
    { label: '会话四', status: 'copied' },
    { label: '会话五', status: 'partial' },
  ] });
  assert.equal(summary.children.length, 2);
  assert.equal(summary.children[0].className, 'wbs-session-copy-summary-group is-copied');
  assert.equal(summary.children[0].children[0].textContent, '同步成功 2');
  assert.deepEqual(summary.children[0].children.slice(1).map(child => child.textContent), ['会话一', '会话四']);
  assert.equal(summary.children[1].className, 'wbs-session-copy-summary-group is-failed');
  assert.equal(summary.children[1].children[0].textContent, '同步失败 2');
  assert.deepEqual(summary.children[1].children.slice(1).map(child => child.textContent), ['失败会话', '会话五']);
  assert.equal(summary.hidden, false);
});

test('copy notice hides the summary when every session was skipped', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  const fakeDocument = { createElement: () => ({ className: '', textContent: '', title: '' }) };
  const ctx = { document: fakeDocument };
  vm.runInNewContext(source.slice(source.indexOf('    function sessionCopyItemFailed('), source.indexOf('    function showSessionCopyDetails(')), ctx);
  const summary = { textContent: 'old summary', hidden: false, children: [], appendChild(child) { this.children.push(child); } };
  ctx.renderSessionCopyNoticeSummary(summary, { details: [{ label: '跳过会话', status: 'skipped' }] });
  assert.equal(summary.children.length, 0);
  assert.equal(summary.hidden, true);
});
