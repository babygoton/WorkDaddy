'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const daemonPath = path.join(__dirname, '..', 'scripts', 'daemon.js');

function loadSessionDeleteHelpers(fsImpl = fs) {
  const source = fs.readFileSync(daemonPath, 'utf8');
  const start = source.indexOf('const MAX_SESSION_ID_LENGTH');
  const end = source.indexOf('\nfunction json(', start);
  assert.notEqual(start, -1, 'daemon must define the session ID validation boundary');
  assert.notEqual(end, -1, 'session deletion helpers must remain before json()');
  const context = { fs: fsImpl, path, log() {} };
  vm.runInNewContext(
    source.slice(start, end) +
      '\nthis.helpers = { isValidSessionId, matchedSessionIds, resolveManagedSessionTarget, deleteSessionFiles };',
    context
  );
  return context.helpers;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-session-delete-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('session IDs reject traversal, absolute paths, separators, controls, and excessive length', () => {
  const { isValidSessionId } = loadSessionDeleteHelpers();
  assert.equal(isValidSessionId('550e8400-e29b-41d4-a716-446655440000'), true);
  for (const id of [
    '', '.', '..', '/tmp/session', 'C:\\temp\\session', 'child/session', 'child\\session',
    'nul\0byte', 'line\nbreak', 'trailing.', 'trailing ', 'CON', 'file:stream', 'x'.repeat(201),
  ]) {
    assert.equal(isValidSessionId(id), false, JSON.stringify(id));
  }
});

test('only IDs returned by the pre-delete SELECT are eligible for DB and file deletion', () => {
  const { matchedSessionIds } = loadSessionDeleteHelpers();
  const matched = matchedSessionIds(
    ['existing-a', 'missing', 'existing-a', 'existing-b'],
    [{ id: 'existing-b' }, { id: 'existing-a' }, { id: 'not-requested' }]
  );
  assert.deepEqual(Array.from(matched), ['existing-a', 'existing-b']);
});

test('managed targets must remain strictly below their expected parent', () => {
  const { resolveManagedSessionTarget } = loadSessionDeleteHelpers();
  const parent = path.resolve('managed-parent');
  assert.equal(resolveManagedSessionTarget(parent, 'valid-id'), path.join(parent, 'valid-id'));
  for (const leaf of ['..', '../escape', '..\\escape', path.parse(parent).root]) {
    assert.throws(() => resolveManagedSessionTarget(parent, leaf), /managed parent|会话/);
  }
});

test('invalid traversal IDs cannot remove the WorkBuddy data root', (t) => {
  const { deleteSessionFiles } = loadSessionDeleteHelpers();
  const wbHome = tempDir(t);
  fs.mkdirSync(path.join(wbHome, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(wbHome, 'keep.txt'), 'keep');

  assert.equal(path.resolve(path.join(wbHome, 'tasks', '..')), path.resolve(wbHome));
  assert.throws(() => deleteSessionFiles(wbHome, '..'), /会话 ID/);
  assert.equal(fs.readFileSync(path.join(wbHome, 'keep.txt'), 'utf8'), 'keep');
});

test('a valid existing session deletes only its managed files', (t) => {
  const { deleteSessionFiles } = loadSessionDeleteHelpers();
  const wbHome = tempDir(t);
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const project = path.join(wbHome, 'projects', 'project-a');
  const targets = [
    path.join(project, id + '.jsonl'),
    path.join(project, id),
    path.join(wbHome, 'workspace', 'sessions', id),
    path.join(wbHome, 'tasks', id),
    path.join(wbHome, 'file-history', id),
    path.join(wbHome, 'artifact-index', id + '.json'),
  ];
  for (const target of targets) {
    if (path.extname(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'session');
    } else {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'session.txt'), 'session');
    }
  }
  const unrelated = path.join(wbHome, 'tasks', 'other-session');
  fs.mkdirSync(unrelated, { recursive: true });

  assert.equal(deleteSessionFiles(wbHome, id), targets.length);
  for (const target of targets) assert.equal(fs.existsSync(target), false, target);
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(deleteSessionFiles(wbHome, 'missing-session'), 0);
});

test('project directory symlinks are not followed', (t) => {
  const { deleteSessionFiles } = loadSessionDeleteHelpers();
  const wbHome = tempDir(t);
  const outside = tempDir(t);
  const id = 'valid-session-id';
  fs.mkdirSync(path.join(wbHome, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(outside, id + '.jsonl'), 'outside');
  fs.mkdirSync(path.join(outside, id), { recursive: true });
  fs.writeFileSync(path.join(outside, id, 'keep.txt'), 'outside');
  const link = path.join(wbHome, 'projects', 'linked-project');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('directory symlink creation is not permitted on this host');
      return;
    }
    throw error;
  }

  assert.equal(deleteSessionFiles(wbHome, id), 0);
  assert.equal(fs.readFileSync(path.join(outside, id + '.jsonl'), 'utf8'), 'outside');
  assert.equal(fs.readFileSync(path.join(outside, id, 'keep.txt'), 'utf8'), 'outside');
});

test('a managed parent symlink aborts deletion so the database record can remain retryable', (t) => {
  const { deleteSessionFiles } = loadSessionDeleteHelpers();
  const wbHome = tempDir(t);
  const outside = tempDir(t);
  const id = 'valid-session-id';
  fs.mkdirSync(path.join(outside, id), { recursive: true });
  fs.writeFileSync(path.join(outside, id, 'keep.txt'), 'outside');
  try {
    fs.symlinkSync(outside, path.join(wbHome, 'tasks'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('directory symlink creation is not permitted on this host');
      return;
    }
    throw error;
  }

  assert.throws(() => deleteSessionFiles(wbHome, id), /managed|目录|符号|链接|junction/i);
  assert.equal(fs.readFileSync(path.join(outside, id, 'keep.txt'), 'utf8'), 'outside');
});

test('unexpected filesystem removal errors are surfaced instead of reported as success', (t) => {
  const wbHome = tempDir(t);
  const id = 'valid-session-id';
  const target = path.join(wbHome, 'tasks', id);
  fs.mkdirSync(target, { recursive: true });
  const fsImpl = Object.create(fs);
  fsImpl.rmSync = function rmSync() {
    const error = new Error('access denied');
    error.code = 'EACCES';
    throw error;
  };
  const { deleteSessionFiles } = loadSessionDeleteHelpers(fsImpl);

  assert.throws(() => deleteSessionFiles(wbHome, id), /access denied/);
  assert.equal(fs.existsSync(target), true);
});

test('delete route validates before SQL and deletes the matched set only', () => {
  const source = fs.readFileSync(daemonPath, 'utf8');
  const routeStart = source.indexOf("p === '/api/sessions/delete'");
  const routeEnd = source.indexOf("p === '/api/sessions/restore'", routeStart);
  const route = source.slice(routeStart, routeEnd);
  const normalizeAt = route.indexOf('normalizeSessionIdBatch');
  const validateAt = route.indexOf('isValidSessionId');
  const selectAt = route.indexOf("SELECT id, user_id FROM sessions");
  assert.ok(normalizeAt >= 0 && normalizeAt < validateAt, 'the raw batch must be bounded before path validation');
  assert.ok(validateAt < selectAt, 'all IDs must be validated before SELECT or DELETE');
  assert.match(route, /SELECT id, user_id FROM sessions WHERE id IN \(' \+ placeholders \+ '\);', memberIds/);
  assert.match(route, /collectLineageMembersForDelete\(DATA_DIR, ids\)/);
  assert.match(route, /\.filter\(\(id\) => isValidSessionId\(id\)\)/);
  assert.match(route, /DELETE FROM sessions WHERE id IN \(" \+ sqlPlaceholders\(matchedIds\) \+ "\);",\s+matchedIds/s);
  assert.match(route, /for \(const id of matchedIds\) filesRemoved \+= deleteSessionFiles\(wbHome, id\)/);
  assert.doesNotMatch(route, /for \(const id of ids\) filesRemoved/);
  const filesAt = route.indexOf('for (const id of matchedIds) filesRemoved += deleteSessionFiles');
  const rulesAt = route.indexOf('for (const row of matchedRows)');
  const deleteAt = route.indexOf('DELETE FROM sessions WHERE id IN');
  assert.ok(filesAt >= 0 && filesAt < rulesAt && rulesAt < deleteAt,
    'filesystem and rule cleanup must succeed before the retry anchor is removed from the database');
});
