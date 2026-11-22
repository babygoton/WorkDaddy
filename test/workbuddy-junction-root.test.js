'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const plat = require('../scripts/platform.js');
const { createSessionDb } = require('../scripts/session-db.js');
const sessionSync = require('../scripts/session-sync.js');
const persona = require('../scripts/persona.js');

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

function makeTempDir(t, prefix = 'wd-junction-557-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createDirLink(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', linkPath, target], { windowsHide: true });
  } else {
    fs.symlinkSync(target, linkPath, 'dir');
  }
}

function mockUnknownRealpath(t, blockedPath) {
  const blocked = path.resolve(blockedPath);
  const makeUnknown = (p) => {
    const error = new Error(`UNKNOWN: unknown error, realpath '${p}'`);
    error.code = 'UNKNOWN';
    return error;
  };
  const origSync = fs.realpathSync;
  const origNative = fs.realpathSync.native;
  const origAsync = fs.promises.realpath;
  fs.realpathSync = (p, ...rest) => {
    if (path.resolve(String(p)) === blocked) throw makeUnknown(p);
    return origSync(p, ...rest);
  };
  fs.realpathSync.native = (p, ...rest) => {
    if (path.resolve(String(p)) === blocked) throw makeUnknown(p);
    return origNative(p, ...rest);
  };
  fs.promises.realpath = async (p, ...rest) => {
    if (path.resolve(String(p)) === blocked) throw makeUnknown(p);
    return origAsync(p, ...rest);
  };
  t.after(() => {
    fs.realpathSync = origSync;
    fs.realpathSync.native = origNative;
    fs.promises.realpath = origAsync;
  });
}

test('resolveLinkedPath resolves single/multi-hop junctions and preserves missing suffixes without calling realpath', async t => {
  const base = makeTempDir(t);
  const realRoot = path.join(base, 'target', '.workbuddy');
  const hop1 = path.join(base, 'hop1', '.workbuddy');
  const hop2 = path.join(base, 'home', '.workbuddy');
  fs.mkdirSync(realRoot, { recursive: true });
  createDirLink(realRoot, hop1);
  createDirLink(hop1, hop2);
  mockUnknownRealpath(t, hop2);

  const expectedReal = plat.resolveLinkedPath(realRoot);
  assert.equal(plat.resolveLinkedPath(hop2), expectedReal);
  assert.equal(await plat.resolveLinkedPathAsync(hop2), expectedReal);
  assert.equal(
    plat.resolveLinkedPath(path.join(hop2, 'workbuddy.db')),
    path.join(expectedReal, 'workbuddy.db')
  );
  assert.equal(
    await plat.resolveLinkedPathAsync(path.join(hop2, 'nested', 'missing.json')),
    path.join(expectedReal, 'nested', 'missing.json')
  );

  const nonExistent = path.join(base, 'does-not-exist', '.workbuddy');
  assert.equal(plat.resolveLinkedPath(nonExistent), nonExistent);
  assert.equal(await plat.resolveLinkedPathAsync(nonExistent), nonExistent);
});

test('resolveLinkedPath rejects cyclic links with ELOOP', t => {
  const base = makeTempDir(t);
  const a = path.join(base, 'a');
  const b = path.join(base, 'b');
  fs.mkdirSync(a, { recursive: true });
  createDirLink(a, b);
  fs.rmSync(a, { recursive: true, force: true });
  createDirLink(b, a);

  assert.throws(() => plat.resolveLinkedPath(a), { code: 'ELOOP' });
});

test('profiles.getProfile and listInstalledModelSources resolve junctioned ~/.workbuddy roots', t => {
  const base = makeTempDir(t);
  const fakeHome = path.join(base, 'home');
  const realCn = path.join(base, 'cache', 'workbuddy-cn-data');
  const realAi = path.join(base, 'cache', 'workbuddy-ai-data');
  fs.mkdirSync(realCn, { recursive: true });
  fs.mkdirSync(realAi, { recursive: true });
  fs.writeFileSync(path.join(realAi, 'models.json'), '{"models":[]}');

  createDirLink(realCn, path.join(fakeHome, '.workbuddy'));
  createDirLink(realAi, path.join(fakeHome, '.workbuddy-ai'));

  const script = `
    const path = require('node:path');
    const { getProfile, listInstalledModelSources } = require(${JSON.stringify(path.resolve(__dirname, '../scripts/profiles.js'))});
    const cn = getProfile('workbuddy-cn', { dataDir: ${JSON.stringify(path.join(base, 'wd-data'))}, env: {} });
    const ai = getProfile('workbuddy-ai', { dataDir: ${JSON.stringify(path.join(base, 'wd-data-ai'))}, env: {} });
    const sources = listInstalledModelSources('workbuddy-cn');
    console.log(JSON.stringify({ cn, ai, sources }));
  `;
  const stdout = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    encoding: 'utf8',
    windowsHide: true,
  });
  const parsed = JSON.parse(stdout);
  const expectedCn = plat.resolveLinkedPath(realCn);
  const expectedAi = plat.resolveLinkedPath(realAi);

  assert.equal(parsed.cn.dataRoot, expectedCn);
  assert.equal(parsed.cn.sessionDb, path.join(expectedCn, 'workbuddy.db'));
  assert.equal(parsed.cn.modelsFile, path.join(expectedCn, 'models.json'));
  assert.equal(parsed.ai.dataRoot, expectedAi);
  assert.equal(parsed.ai.sessionDb, path.join(expectedAi, 'workbuddy.db'));
  assert.equal(parsed.ai.modelsFile, path.join(expectedAi, 'models.json'));

  const aiSource = parsed.sources.find((s) => s.profileId === 'workbuddy-ai');
  assert.ok(aiSource);
  assert.equal(aiSource.modelsFile, path.join(expectedAi, 'models.json'));
  assert.equal(aiSource.available, true);
  assert.equal(aiSource.shared, false);
});

test('createSessionDb resolves junctioned dbPath before opening node:sqlite in WAL mode', async t => {
  const { DatabaseSync } = require('node:sqlite');
  const base = makeTempDir(t);
  const realRoot = path.join(base, 'target', '.workbuddy');
  const linkedRoot = path.join(base, 'home', '.workbuddy');
  fs.mkdirSync(realRoot, { recursive: true });
  createDirLink(realRoot, linkedRoot);

  const realDb = path.join(plat.resolveLinkedPath(realRoot), 'workbuddy.db');
  const seed = new DatabaseSync(realDb);
  seed.exec("PRAGMA journal_mode=WAL; CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT); INSERT INTO sessions VALUES ('s1', 'u1');");
  seed.close();

  const linkedDb = path.join(linkedRoot, 'workbuddy.db');
  const openedPaths = [];
  class RecordingDatabaseSync extends DatabaseSync {
    constructor(filePath, ...rest) {
      openedPaths.push(filePath);
      super(filePath, ...rest);
    }
  }

  const adapter = createSessionDb({
    dbPath: linkedDb,
    nodeSqlite: { DatabaseSync: RecordingDatabaseSync },
  });
  const rows = await adapter.all('SELECT id, user_id FROM sessions WHERE user_id = ?', ['u1']);
  assert.deepEqual(rows, [{ id: 's1', user_id: 'u1' }]);
  await adapter.run('INSERT INTO sessions (id, user_id) VALUES (?, ?)', ['s2', 'u1']);
  await adapter.transaction([
    { sql: 'INSERT INTO sessions (id, user_id) VALUES (?, ?)', params: ['s3', 'u1'] },
  ]);
  assert.equal(openedPaths.length, 3);
  for (const opened of openedPaths) {
    assert.equal(opened, realDb);
  }
  const allRows = await adapter.all('SELECT id FROM sessions ORDER BY id');
  assert.deepEqual(allRows, [{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
});

test('session-sync works through a junctioned dataRoot even when realpath throws UNKNOWN, while still rejecting child links', async t => {
  const base = makeTempDir(t);
  const realRoot = path.join(base, 'target', '.workbuddy');
  const linkedRoot = path.join(base, 'home', '.workbuddy');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(realRoot, 'projects', 'p1'), { recursive: true });
  fs.mkdirSync(path.join(realRoot, 'tasks'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  fs.writeFileSync(
    path.join(realRoot, 'projects', 'p1', 's1.jsonl'),
    JSON.stringify({ type: 'message', role: 'user', content: 'hello' }) + '\n'
  );
  createDirLink(realRoot, linkedRoot);
  fs.symlinkSync(outside, path.join(realRoot, 'tasks', 's1'), LINK_TYPE);
  mockUnknownRealpath(t, linkedRoot);

  const expectedRoot = plat.resolveLinkedPath(realRoot);
  const sizes = await sessionSync.readSessionSizes(linkedRoot, ['s1']);
  assert.ok(sizes.get('s1') > 0);

  const snapSync = sessionSync.readSnapshot(linkedRoot, 's1', ['s1']);
  assert.equal(snapSync.root, expectedRoot);
  assert.equal(snapSync.records.length, 1);
  assert.equal([...snapSync.files.keys()].some((k) => k.startsWith('tasks/')), false);

  const snapAsync = await sessionSync.readSnapshotAsync(linkedRoot, 's1', ['s1']);
  assert.equal(snapAsync.root, expectedRoot);
  assert.equal(snapAsync.records.length, 1);
  assert.equal([...snapAsync.files.keys()].some((k) => k.startsWith('tasks/')), false);

  await sessionSync.readSessionFingerprintAsync(linkedRoot, 's1');
  await sessionSync.readSessionQuickFingerprintAsync(linkedRoot, 's1');

  const targetSnap = await sessionSync.readSnapshotAsync(linkedRoot, 's2', ['s1', 's2']);
  await sessionSync.applySnapshotAsync(snapAsync, targetSnap, {
    backupRoot: path.join(base, 'sync-backups'),
  });
  assert.equal(fs.existsSync(path.join(realRoot, 'projects', 'p1', 's2.jsonl')), true);
});

test('persona and daemon archive/delete boundary helpers tolerate a junctioned dataRoot when realpath throws UNKNOWN', t => {
  const base = makeTempDir(t);
  const realDataRoot = path.join(base, 'target', '.workbuddy');
  const linkedDataRoot = path.join(base, 'home', '.workbuddy');
  const realBackupRoot = path.join(base, 'target', 'WorkDaddy');
  const linkedBackupRoot = path.join(base, 'home', 'WorkDaddy');
  fs.mkdirSync(path.join(realDataRoot, 'user-a-personal'), { recursive: true });
  fs.mkdirSync(path.join(realDataRoot, 'tasks', 'sess-del'), { recursive: true });
  fs.writeFileSync(path.join(realDataRoot, 'tasks', 'sess-del', 'note.txt'), 'bye');
  fs.mkdirSync(realBackupRoot, { recursive: true });
  for (const name of ['IDENTITY.md', 'USER.md', 'SOUL.md', 'MEMORY.md']) {
    fs.writeFileSync(path.join(realDataRoot, 'user-a-personal', name), name);
  }
  createDirLink(realDataRoot, linkedDataRoot);
  createDirLink(realBackupRoot, linkedBackupRoot);
  mockUnknownRealpath(t, linkedDataRoot);
  mockUnknownRealpath(t, linkedBackupRoot);

  const writtenSettings = persona.writePersonaSettings(linkedBackupRoot, {
    mode: 'independent',
    noticeDismissed: true,
    activeUid: null,
  });
  assert.equal(writtenSettings.mode, 'independent');
  assert.deepEqual(persona.readPersonaSettings(linkedBackupRoot), writtenSettings);
  const inspected = persona.inspectPersona({
    dataRoot: linkedDataRoot,
    targetUid: 'b',
    accounts: [{ uid: 'a', nickname: 'A' }, { uid: 'b', nickname: 'B' }],
  });
  assert.equal(inspected.eligible, true);

  const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');
  const ctx = {
    plat,
    fs,
    path,
    codeBuddyFiles: null,
    log() {},
    assertSessionAccountIdentity: () => 'u1',
    remapSessionArchivePath: require('../scripts/secure-transfer.js').remapSessionArchivePath,
    resolveArchiveTarget: require('../scripts/secure-transfer.js').resolveArchiveTarget,
  };
  vm.createContext(ctx);
  const validStart = daemonSource.indexOf('function isValidSessionId(');
  const validEnd = daemonSource.indexOf('function matchedSessionIds(', validStart);
  vm.runInContext(daemonSource.slice(validStart, validEnd), ctx);

  const archiveStart = daemonSource.indexOf('function archiveRelativePath(');
  const archiveEnd = daemonSource.indexOf('async function copySessionRecord(', archiveStart);
  vm.runInContext(daemonSource.slice(archiveStart, archiveEnd), ctx);

  const delStart = daemonSource.indexOf('const MAX_SESSION_ID_LENGTH');
  const delEnd = daemonSource.indexOf('\nfunction json(', delStart);
  vm.runInContext(daemonSource.slice(delStart, delEnd), ctx);

  const restoredTarget = path.join(linkedDataRoot, 'tasks', 'sess-new', 'file.txt');
  ctx.ensureArchiveParentNoFollow(linkedDataRoot, restoredTarget);
  assert.equal(fs.existsSync(path.join(realDataRoot, 'tasks', 'sess-new')), true);
  assert.equal(ctx.deleteSessionFiles(linkedDataRoot, 'sess-del'), 1);
  assert.equal(fs.existsSync(path.join(realDataRoot, 'tasks', 'sess-del')), false);
});
