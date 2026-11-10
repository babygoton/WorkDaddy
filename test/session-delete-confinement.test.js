const assertSessionAccountIdentity = require('../scripts/account-identity').createSessionAccountResolver([]).assertUnambiguous;
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
  const context = { assertSessionAccountIdentity, codeBuddyFiles: null, fs: fsImpl, path, log() {} };
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

test('session deletion removes only matching app cache entries and preserves its format', (t) => {
  const { deleteSessionFiles } = loadSessionDeleteHelpers();
  for (const wrapped of [false, true]) {
    const root = tempDir(t);
    fs.mkdirSync(path.join(root, 'app'));
    const file = path.join(root, 'app', 'sessions.json');
    const keep = { conversationId: 'keep', windowId: 7 };
    const entries = [{ conversationId: 'remove', windowId: 1 }, keep, { unknown: true }];
    fs.writeFileSync(file, JSON.stringify(wrapped ? { version: 2, sessions: entries } : entries), { mode: 0o600 });
    assert.equal(deleteSessionFiles(root, 'remove'), 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), wrapped ? { version: 2, sessions: [keep, { unknown: true }] } : [keep, { unknown: true }]);
    assert.equal(deleteSessionFiles(root, 'remove'), 0, 'retries must be idempotent');
    assert.deepEqual(fs.readdirSync(path.join(root, 'app')), ['sessions.json']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('unreadable app cache fails before deleting session files', (t) => {
  const { deleteSessionFiles } = loadSessionDeleteHelpers();
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'app'));
  fs.mkdirSync(path.join(root, 'tasks', 'remove'), { recursive: true });
  for (const content of ['{broken', '{"sessions":{}}']) {
    fs.writeFileSync(path.join(root, 'app', 'sessions.json'), content);
    assert.throws(() => deleteSessionFiles(root, 'remove'), /会话缓存/);
    assert.ok(fs.existsSync(path.join(root, 'tasks', 'remove')));
    assert.equal(fs.readFileSync(path.join(root, 'app', 'sessions.json'), 'utf8'), content);
  }
});

test('a linked app cache cannot overwrite an outside file', (t) => {
  const { deleteSessionFiles } = loadSessionDeleteHelpers();
  const root = tempDir(t), outside = tempDir(t);
  const content = '[{"conversationId":"remove"}]';
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(outside, 'sessions.json'), content);
  try { fs.symlinkSync(path.join(outside, 'sessions.json'), path.join(root, 'app', 'sessions.json')); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('symlinks unavailable'); throw error; }
  assert.throws(() => deleteSessionFiles(root, 'remove'), /会话缓存/);
  assert.equal(fs.readFileSync(path.join(outside, 'sessions.json'), 'utf8'), content);
});

test('a locked cache replacement preserves the original file and removes temporary staging', (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'app'));
  const file = path.join(root, 'app', 'sessions.json');
  const content = '[{"conversationId":"remove"}]';
  fs.writeFileSync(file, content);
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); };
  assert.throws(() => loadSessionDeleteHelpers(fsImpl).deleteSessionFiles(root, 'remove'), /locked/);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  assert.deepEqual(fs.readdirSync(path.join(root, 'app')), ['sessions.json']);
});

test('a concurrently updated app cache is not overwritten', (t) => {
  const root = tempDir(t);
  fs.mkdirSync(path.join(root, 'app'));
  const file = path.join(root, 'app', 'sessions.json');
  fs.writeFileSync(file, '[{"conversationId":"remove"}]');
  const updated = '[{"conversationId":"remove"},{"conversationId":"new"}]';
  const fsImpl = Object.create(fs);
  fsImpl.writeFileSync = (...args) => { fs.writeFileSync(...args); fs.writeFileSync(file, updated); };
  assert.throws(() => loadSessionDeleteHelpers(fsImpl).deleteSessionFiles(root, 'remove'), /已变化/);
  assert.equal(fs.readFileSync(file, 'utf8'), updated);
  assert.deepEqual(fs.readdirSync(path.join(root, 'app')), ['sessions.json']);
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
  assert.match(route, /SELECT id, user_id FROM sessions WHERE id IN \(' \+ placeholders \+ '\).*memberIds/);
  assert.match(route, /collectLineageMembersForDelete\(DATA_DIR, ids\)/);
  assert.match(route, /\.filter\(\(id\) => isValidSessionId\(id\)\)/);
  assert.match(route, /DELETE FROM sessions WHERE id IN \(" \+ sqlPlaceholders\(matchedIds\) \+ "\);",\s+matchedIds/s);
  assert.match(route, /for \(const id of matchedIds\) filesRemoved \+= deleteSessionFiles\(wbHome, id\)/);
  assert.doesNotMatch(route, /for \(const id of ids\) filesRemoved/);
  const filesAt = route.indexOf('for (const id of matchedIds) filesRemoved += deleteSessionFiles');
  const rulesAt = route.indexOf('recordSessionDeletion(DATA_DIR, matchedRows, { preserveMembers: true })');
  const deleteAt = route.indexOf('DELETE FROM sessions WHERE id IN');
  assert.ok(filesAt >= 0 && filesAt < rulesAt && rulesAt < deleteAt,
    'filesystem and rule cleanup must succeed before the retry anchor is removed from the database');
  assert.match(route, /assertAccountSwitchIdle\(\)/,
    'deletion must exclude concurrent account-switch session copy writes');
});

test('delete route refuses while account switching or session copy holds the operation gate', async () => {
  const source = fs.readFileSync(daemonPath, 'utf8');
  const start = source.indexOf("  if (req.method === 'POST' && p === '/api/sessions/delete')");
  const end = source.indexOf('  // 恢复会话：', start);
  const ctx = vm.createContext({ assertSessionAccountIdentity,
    codeBuddyFiles: null,
    req: { method: 'POST' },
    p: '/api/sessions/delete',
    res: {},
    normalizeSessionIdBatch: require('../scripts/session-db.js').normalizeSessionIdBatch,
    readBody: async () => ({ ids: ['session'] }),
    isValidSessionId: id => id === 'session',
    assertAccountSwitchIdle: async () => { throw new Error('会话同步尚未完成，请稍后切换账号'); },
    json: (_, status, body) => ({ status, body }),
  });
  const result = await vm.runInContext('(async function () {' + source.slice(start, end) + '\n})()', ctx);
  assert.equal(result.status, 409);
  assert.match(result.body.error, /会话同步尚未完成/);
});

test('delete route accepts more than 100 session IDs in one request', async (t) => {
  const { createSessionDb, normalizeSessionIdBatch } = require('../scripts/session-db.js');
  const root = tempDir(t);
  const db = createSessionDb({ dbPath: path.join(root, 'sessions.db') });
  await db.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, is_background_automation INTEGER)');
  const ids = Array.from({ length: 101 }, (_, index) => `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`);
  for (const id of ids) await db.run('INSERT INTO sessions (id, user_id) VALUES (?, ?)', [id, 'owner']);

  const source = fs.readFileSync(daemonPath, 'utf8');
  const start = source.indexOf("  if (req.method === 'POST' && p === '/api/sessions/delete')");
  const end = source.indexOf('  // 恢复会话：', start);
  const ctx = vm.createContext({ assertSessionAccountIdentity,codeBuddyFiles:null,
    ...loadSessionDeleteHelpers(),
    normalizeSessionIdBatch,
    collectLineageMembersForDelete: (_dataDir, requested) => requested.map((id) => ({ id })),
    recordSessionDeletion: () => 0, crypto: require('node:crypto'),
    DATA_DIR: root,
    PROFILE: { dataRoot: root },
    req: { method: 'POST' },
    res: {},
    p: '/api/sessions/delete',
    readBody: async () => ({ ids }),
    sqliteQuery: (sql, params) => db.all(sql, Array.from(params)),
    sqliteRun: (sql, params) => db.run(sql, Array.from(params)),
    sqlPlaceholders: (values) => values.map(() => '?').join(','),
    json: (_, status, body) => ({ status, body }),
    log() {},
  });

  const result = await vm.runInContext('(async function () {\n' + source.slice(start, end) + '\n})()', ctx);
  assert.equal(result.status, 200);
  assert.equal(result.body.deleted, ids.length);
  assert.deepEqual(await db.all('SELECT id FROM sessions'), []);
});

for (const scope of ['selected', 'lineage']) test('#511 delete scope is explicit: ' + scope, async (t) => {
  const lib = require('../scripts/lib.js');
  const { createSessionDb, normalizeSessionIdBatch } = require('../scripts/session-db.js');
  const root = tempDir(t);
  const db = createSessionDb({ dbPath: path.join(root, 'sessions.db') });
  await db.run('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, is_background_automation INTEGER)');
  const rows = [['session-a', 'source'], ['copy-a', 'target'], ['copy-third', 'third'], ['unrelated', 'target']];
  for (const [id, uid] of rows) {
    await db.run('INSERT INTO sessions (id, user_id) VALUES (?, ?)', [id, uid]);
    fs.mkdirSync(path.join(root, 'tasks', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', id, 'messages.json'), '[]');
  }
  const original = lib.ensureAutoCopySession(root, 'source', 'session-a');
  lib.setAutoCopyMapping(root, original, 'target', { targetId: 'copy-a' });
  const split = lib.ensureAutoCopySession(root, 'target', 'copy-a');
  lib.addAutoCopySessionMember(root, split, 'third', 'copy-third');
  lib.ensureAutoCopySession(root, 'target', 'unrelated');

  const source = fs.readFileSync(daemonPath, 'utf8');
  const start = source.indexOf("  if (req.method === 'POST' && p === '/api/sessions/delete')");
  const end = source.indexOf('  // 恢复会话：', start);
  const ctx = vm.createContext({ assertSessionAccountIdentity,codeBuddyFiles:null,
    ...loadSessionDeleteHelpers(),
    normalizeSessionIdBatch,
    collectLineageMembersForDelete: lib.collectLineageMembersForDelete,
    ...lib, crypto: require('node:crypto'),
    DATA_DIR: root, PROFILE: { dataRoot: root },
    req: { method: 'POST' }, res: {}, p: '/api/sessions/delete',
    readBody: async () => ({ ids: ['copy-a'], scope, preview: true }),
    sqliteQuery: (sql, params) => db.all(sql, Array.from(params)),
    sqliteRun: (sql, params) => db.run(sql, Array.from(params)),
    sqlPlaceholders: ids => ids.map(() => '?').join(','),
    json: (_, status, body) => ({ status, body }), log() {},
  });
  const run = () => vm.runInContext('(async function () {\n' + source.slice(start, end) + '\n})()', ctx);
  const preview = await run();
  assert.equal(preview.status, 200);
  assert.equal(preview.body.total, scope === 'selected' ? 1 : 3);
  assert.equal((await db.all('SELECT id FROM sessions')).length, 4, 'preview must not delete');
  ctx.readBody = async () => ({ ids: ['copy-a'], scope });
  if (scope === 'lineage') {
    assert.equal((await run()).status, 409, 'cross-account delete requires preview confirmation');
    await db.run('INSERT INTO sessions (id, user_id) VALUES (?, ?)', ['late-copy', 'fourth']);
    lib.addAutoCopySessionMember(root, original, 'fourth', 'late-copy');
    ctx.readBody = async () => ({ ids: ['copy-a'], scope, previewToken: preview.body.previewToken });
    assert.equal((await run()).status, 409, 'a changed family requires another preview');
    ctx.readBody = async () => ({ ids: ['copy-a'], scope, preview: true });
    const updated = await run();
    ctx.readBody = async () => ({ ids: ['copy-a'], scope, previewToken: updated.body.previewToken });
  }
  const retryBody = await ctx.readBody();
  const write = ctx.sqliteRun;
  ctx.sqliteRun = async () => { throw new Error('database locked'); };
  assert.equal((await run()).status, 500);
  ctx.sqliteRun = write;
  ctx.readBody = async () => ({ ids: ['copy-a'], scope, preview: true });
  const retryPreview = await run();
  assert.equal(retryPreview.body.total, scope === 'selected' ? 1 : 4, 'DB failure preserves the family for retry');
  ctx.readBody = async () => retryBody;
  const result = await run();
  assert.equal(result.status, 200);
  assert.equal(result.body.deleted, scope === 'selected' ? 1 : 4);
  assert.equal(result.body.cascaded, scope === 'selected' ? 0 : 3);
  const expected = scope === 'selected' ? ['copy-third', 'session-a', 'unrelated'] : ['unrelated'];
  assert.deepEqual((await db.all('SELECT id FROM sessions ORDER BY id')).map(row => row.id), expected);
  assert.deepEqual(fs.readdirSync(path.join(root, 'tasks')).sort(), expected);
  assert.equal(lib.getAutoCopySession(root, 'target', 'unrelated').enabled, true);
  assert.equal(lib.isAutoCopyTargetExcluded(root, original, 'target'), true);
  assert.equal(lib.isAutoCopyTargetExcluded(root, split, 'target'), true);
});

test('configured data root may be a directory junction while child links still fail closed', (t) => {
  const parent = tempDir(t), real = tempDir(t), outside = tempDir(t);
  const root = path.join(parent, 'workbuddy');
  try { fs.symlinkSync(real, root, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('symlinks unavailable'); throw error; }
  fs.mkdirSync(path.join(real, 'tasks', 'remove'), { recursive: true });
  fs.mkdirSync(path.join(real, 'tasks', 'keep'));
  assert.equal(loadSessionDeleteHelpers().deleteSessionFiles(root, 'remove'), 1);
  assert.ok(fs.lstatSync(root).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(real, 'tasks', 'keep')));
  fs.mkdirSync(path.join(outside, 'remove'));
  fs.symlinkSync(outside, path.join(real, 'workspace'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => loadSessionDeleteHelpers().deleteSessionFiles(root, 'remove'), /managed/);
  assert.ok(fs.existsSync(path.join(outside, 'remove')));
});
