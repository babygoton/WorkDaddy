'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectPersona, copyPersona } = require('../scripts/persona');
function fixture(t, scoped = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-persona-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, '.workbuddy');
  const backupRoot = path.join(root, 'WorkDaddy');
  function write(dir, name, text) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); }
  const target = path.join(dataRoot, 'user-b-personal');
  const source = path.join(dataRoot, 'user-a-personal');
  for (const name of ['IDENTITY.md', 'USER.md', 'SOUL.md', 'MEMORY.md']) write(dataRoot, name, 'legacy ' + name);
  if (scoped) write(dataRoot, 'storage/device/global/user-data-migration.json', JSON.stringify({ migrationItems: { persona: true }, migrationStatus: 'done' }));
  const opts = { dataRoot, backupRoot, targetUid: 'b', accounts: [{ uid: 'a', nickname: 'A' }, { uid: 'b', nickname: 'B' }] };
  function preview() { return inspectPersona(opts); }
  function copy(extra = {}) { return copyPersona({ ...opts, sourceUid: 'legacy', confirmed: true, revision: preview().revision, ...extra }); }
  return { root, dataRoot, target, source, opts, write, preview, copy };
}
test('old global layout is untouched and never creates scoped directories', t => {
  const f = fixture(t, false);
  assert.equal(f.preview().status, 'legacy');
  assert.throws(() => f.copy(), /无需修复/);
  assert.equal(fs.existsSync(f.target), false);
});
test('new layout with missing target copies complete legacy identity after consent', t => {
  const f = fixture(t);
  assert.equal(f.preview().status, 'missing');
  assert.throws(() => f.copy({ confirmed: false }), /确认/);
  const r = f.copy();
  assert.equal(r.files, 4);
  assert.equal(fs.readFileSync(path.join(f.target, 'MEMORY.md'), 'utf8'), 'legacy MEMORY.md');
  assert.ok(JSON.parse(fs.readFileSync(path.join(f.target, 'workspace-state.json'))).onboardingCompletedAt);
  assert.equal(f.preview().status, 'initialized');
});
test('existing scoped directories signal new layout without migration marker', t => {
  const f = fixture(t, false);
  f.write(f.source, 'USER.md', 'independent');
  assert.equal(f.preview().status, 'missing');
});
test('bootstrap repair backs up exact target, preserves unrelated state/files and global source', t => {
  const f = fixture(t);
  f.write(f.target, 'BOOTSTRAP.md', 'onboarding');
  f.write(f.target, 'IDENTITY.md', 'template');
  f.write(f.target, 'workspace-state.json', JSON.stringify({ version: 1, bootstrapSeededAt: 'before', custom: 7 }));
  f.write(f.target, 'unrelated.txt', 'keep');
  const r = f.copy();
  assert.equal(fs.readFileSync(path.join(r.backupDir, 'IDENTITY.md'), 'utf8'), 'template');
  assert.equal(fs.readFileSync(path.join(r.backupDir, 'BOOTSTRAP.md'), 'utf8'), 'onboarding');
  assert.equal(fs.existsSync(path.join(f.target, 'BOOTSTRAP.md')), false);
  assert.equal(fs.readFileSync(path.join(f.target, 'unrelated.txt'), 'utf8'), 'keep');
  const state = JSON.parse(fs.readFileSync(path.join(f.target, 'workspace-state.json')));
  assert.equal(state.custom, 7);
  assert.equal(state.bootstrapSeededAt, 'before');
  assert.equal(fs.readFileSync(path.join(f.dataRoot, 'MEMORY.md'), 'utf8'), 'legacy MEMORY.md');
});
test('explicit scoped source wins over stale legacy files', t => {
  const f = fixture(t);
  for (const name of ['IDENTITY.md', 'USER.md', 'SOUL.md', 'MEMORY.md']) f.write(f.source, name, 'scoped ' + name);
  assert.deepEqual(f.preview().sources.map(s => s.uid), ['a', 'legacy']);
  f.copy({ sourceUid: 'a' });
  assert.equal(fs.readFileSync(path.join(f.target, 'MEMORY.md'), 'utf8'), 'scoped MEMORY.md');
});
for (const variant of ['memory', 'completed', 'partial']) test('protect independent target: ' + variant, t => {
  const f = fixture(t);
  if (variant === 'memory') { f.write(f.target, 'MEMORY.md', 'independent'); f.write(f.target, 'BOOTSTRAP.md', 'stale'); }
  if (variant === 'completed') f.write(f.target, 'workspace-state.json', '{"onboardingCompletedAt":"before"}');
  if (variant === 'partial') f.write(f.target, 'USER.md', 'custom persona');
  assert.equal(f.preview().eligible, false);
  assert.throws(() => f.copy(), /无需修复/);
});
test('changed target requires another preview and confirmation', t => {
  const f = fixture(t);
  const revision = f.preview().revision;
  f.write(f.target, 'BOOTSTRAP.md', 'new');
  assert.throws(() => f.copy({ revision }), /已变化/);
  assert.equal(fs.existsSync(path.join(f.target, 'MEMORY.md')), false);
});
test('reject traversal, unknown account, symlink directory/file and oversized source', t => {
  const f = fixture(t);
  assert.throws(() => inspectPersona({ ...f.opts, targetUid: '../outside' }), /账号/);
  assert.throws(() => f.copy({ sourceUid: 'unknown' }), /来源/);
  fs.symlinkSync(f.dataRoot, f.target, 'dir');
  assert.throws(() => f.copy(), /链接/);
  fs.unlinkSync(f.target);
  fs.mkdirSync(f.target);
  fs.symlinkSync(path.join(f.dataRoot, 'USER.md'), path.join(f.target, 'USER.md'));
  assert.throws(() => f.copy(), /链接/);
  fs.unlinkSync(path.join(f.target, 'USER.md'));
  fs.truncateSync(path.join(f.dataRoot, 'MEMORY.md'), 20 * 1024 * 1024 + 1);
  assert.throws(() => f.copy(), /过大/);
});
test('write failure rolls back all target files and retains backup', t => {
  const f = fixture(t);
  f.write(f.target, 'BOOTSTRAP.md', 'keep bootstrap');
  f.write(f.target, 'IDENTITY.md', 'keep identity');
  let calls = 0;
  const { replaceFileWithRetry } = require('../scripts/atomic-file-write');
  assert.throws(() => f.copy({ replaceFile(file, text, mode) { if (++calls === 2) throw new Error('simulated lock'); replaceFileWithRetry(file, text, mode); } }), /simulated lock/);
  assert.equal(fs.readFileSync(path.join(f.target, 'IDENTITY.md'), 'utf8'), 'keep identity');
  assert.equal(fs.readFileSync(path.join(f.target, 'BOOTSTRAP.md'), 'utf8'), 'keep bootstrap');
  assert.equal(fs.existsSync(path.join(f.target, 'MEMORY.md')), false);
});
test('empty or incomplete source never marks onboarding completed', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.dataRoot, 'USER.md'));
  assert.equal(f.preview().eligible, false);
  assert.throws(() => f.copy(), /无需修复/);
  assert.equal(fs.existsSync(f.target), false);
});

test('a null migration marker does not move an old client out of global layout', t => {
  const f = fixture(t, false);
  f.write(f.dataRoot, 'storage/device/global/user-data-migration.json', 'null');
  assert.equal(f.preview().status, 'legacy');
  assert.equal(fs.existsSync(f.target), false);
});
test('official onboarding completed during backup is protected before any replacement', t => {
  const f = fixture(t);
  f.write(f.target, 'BOOTSTRAP.md', 'before');
  const writeFile = fs.writeFileSync;
  fs.writeFileSync = function (file, ...args) {
    const result = writeFile.call(fs, file, ...args);
    if (String(file).includes(path.join('WorkDaddy', 'persona'))) writeFile(path.join(f.target, 'MEMORY.md'), 'new independent memory');
    return result;
  };
  try { assert.throws(() => f.copy(), /已变化/); }
  finally { fs.writeFileSync = writeFile; }
  assert.equal(fs.readFileSync(path.join(f.target, 'MEMORY.md'), 'utf8'), 'new independent memory');
  assert.equal(fs.readFileSync(path.join(f.target, 'BOOTSTRAP.md'), 'utf8'), 'before');
  assert.equal(fs.existsSync(path.join(f.target, 'IDENTITY.md')), false);
});
