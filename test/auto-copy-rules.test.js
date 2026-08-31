'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  metaFile,
  canonicalWorkspace,
  getAutoCopyRules,
  setAutoCopyRule,
  getAutoCopySession,
  getAutoCopySessionMembers,
  addAutoCopySessionMember,
  removeAutoCopySessionMember,
  moveAutoCopySession,
  removeAutoCopySession,
  removeAutoCopyAccount,
  setAutoCopyMapping,
  getAutoCopyMapping,
  getAutoCopySessionMemberRecords,
  selectLatestAutoCopyMember,
  listOfficialModels,
  maskApiKey,
  sanitizeModel,
  deleteOfficialModels,
  listModelBackups,
  backupOfficialModel,
  copyModelBackup,
  editModelBackup,
  deleteModelBackups,
  enableModelBackup,
  importModels,
  checkinDisplayValue,
} = require('../scripts/lib.js');

test('lineage sync selects the newest live member instead of trusting the switching source', () => {
  const members = [
    { uid: 'account-a', id: 'copy-a', contentMtime: 100, updatedAt: 500 },
    { uid: 'account-b', id: 'copy-b', contentMtime: 300, updatedAt: 100 },
    { uid: 'account-c', id: 'copy-c', contentMtime: 200, updatedAt: 900 },
  ];
  assert.deepEqual(selectLatestAutoCopyMember(members), members[1]);
  assert.deepEqual(selectLatestAutoCopyMember([]), null);
});

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-auto-copy-'));
}

function writeMeta(dataDir, value) {
  fs.writeFileSync(metaFile(dataDir), JSON.stringify(value, null, 2), { mode: 0o600 });
}

test('Windows workspace keys retain the renderer-provided path spelling', () => {
  const result = childProcess.spawnSync(
    process.execPath,
    ['-e', "Object.defineProperty(process, 'platform', { value: 'win32' }); const { canonicalWorkspace } = require(process.argv[1]); process.stdout.write(canonicalWorkspace('/Users/example/Repo/'));", path.join(__dirname, '..', 'scripts', 'lib.js')],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '/Users/example/Repo');
});

test('legacy account-scoped rules migrate to global lineages and workspace paths', () => {
  const dataDir = tempDataDir();
  const oldKey = JSON.stringify(['h', 's', 'session-a']);
  writeMeta(dataDir, {
    accounts: {},
    autoCopy: {
      version: 1,
      sessions: { h: { 'session-a': true } },
      workspaces: { h: { '/Users/example/Repo/': '/Users/example/Repo/' }, s: { '/Users/example/Repo': '/Users/example/Repo' } },
      copies: { [oldKey]: { targetId: 'session-copy' } },
    },
  });

  const rules = getAutoCopyRules(dataDir, 'h');
  assert.deepEqual(rules.sessionIds, ['session-a']);
  assert.equal(rules.workspaces.length, 1);
  const expectedWorkspace = '/Users/example/Repo';
  assert.equal(canonicalWorkspace('/Users/example/Repo/'), expectedWorkspace);
  const lineage = getAutoCopySession(dataDir, 'h', 'session-a');
  assert.ok(lineage.lineageId);
  assert.equal(lineage.enabled, true);
  assert.equal(getAutoCopyMapping(dataDir, lineage.lineageId, 's').targetId, 'session-copy');
  assert.equal(JSON.parse(fs.readFileSync(metaFile(dataDir), 'utf8')).autoCopy.version, 2);
});

test('marked session keeps one lineage through migration and repeated account switching', () => {
  const dataDir = tempDataDir();
  setAutoCopyRule(dataDir, { uid: 'h', kind: 'session', key: 'session-a', enabled: true });
  const original = getAutoCopySession(dataDir, 'h', 'session-a');
  addAutoCopySessionMember(dataDir, original.lineageId, 's', 'session-s');
  setAutoCopyMapping(dataDir, original.lineageId, 's', { targetId: 'session-s' });

  assert.equal(moveAutoCopySession(dataDir, 'h', 'x', 'session-a'), true);
  const moved = getAutoCopySession(dataDir, 'x', 'session-a');
  assert.equal(moved.lineageId, original.lineageId);
  assert.equal(moved.enabled, true);
  assert.equal(getAutoCopySession(dataDir, 'h', 'session-a').lineageId, null);
  assert.equal(getAutoCopySession(dataDir, 's', 'session-s').lineageId, original.lineageId);
  assert.equal(getAutoCopyMapping(dataDir, original.lineageId, 's').targetId, 'session-s');

  // One global unmark disables the shared session for every account member.
  setAutoCopyRule(dataDir, { uid: 'x', kind: 'session', key: 'session-a', enabled: false });
  assert.equal(getAutoCopySession(dataDir, 's', 'session-s').enabled, false);
  assert.equal(getAutoCopySession(dataDir, 'x', 'session-a').enabled, false);
});

test('deleting the last lineage member removes mappings, while other members retain them', () => {
  const dataDir = tempDataDir();
  setAutoCopyRule(dataDir, { uid: 'h', kind: 'session', key: 'session-a', enabled: true });
  const lineageId = getAutoCopySession(dataDir, 'h', 'session-a').lineageId;
  addAutoCopySessionMember(dataDir, lineageId, 's', 'session-s');
  setAutoCopyMapping(dataDir, lineageId, 's', { targetId: 'session-s' });

  assert.equal(removeAutoCopySession(dataDir, 'h', 'session-a'), true);
  assert.equal(getAutoCopyMapping(dataDir, lineageId, 's').targetId, 'session-s');
  assert.equal(removeAutoCopyAccount(dataDir, 's'), 1);
  assert.equal(getAutoCopyMapping(dataDir, lineageId, 's'), null);
});

test('lineage member lookup is deduplicated and one member can be removed without deleting the lineage', () => {
  const dataDir = tempDataDir();
  setAutoCopyRule(dataDir, { uid: 'source', kind: 'session', key: 'source-session', enabled: true });
  const lineageId = getAutoCopySession(dataDir, 'source', 'source-session').lineageId;
  addAutoCopySessionMember(dataDir, lineageId, 'target', 'target-old');
  addAutoCopySessionMember(dataDir, lineageId, 'target', 'target-old');
  addAutoCopySessionMember(dataDir, lineageId, 'target', 'target-new');
  assert.deepEqual(getAutoCopySessionMembers(dataDir, lineageId, 'target'), ['target-old', 'target-new']);
  assert.equal(removeAutoCopySessionMember(dataDir, lineageId, 'target', 'target-old'), true);
  assert.deepEqual(getAutoCopySessionMembers(dataDir, lineageId, 'target'), ['target-new']);
  assert.equal(getAutoCopySession(dataDir, 'source', 'source-session').lineageId, lineageId);
  assert.deepEqual(getAutoCopySessionMemberRecords(dataDir, lineageId), [
    { uid: 'source', id: 'source-session' },
    { uid: 'target', id: 'target-new' },
  ]);
});

test('workspace rules are global across source accounts', () => {
  const dataDir = tempDataDir();
  const expectedWorkspace = '/Users/h/Repo';
  setAutoCopyRule(dataDir, { uid: 'h', kind: 'workspace', key: '/Users/h/Repo/', enabled: true });
  assert.deepEqual(getAutoCopyRules(dataDir, 'h').workspaces, [expectedWorkspace]);
  assert.deepEqual(getAutoCopyRules(dataDir, 's').workspaces, [expectedWorkspace]);
  setAutoCopyRule(dataDir, { uid: 's', kind: 'workspace', key: '/Users/h/Repo', enabled: false });
  assert.deepEqual(getAutoCopyRules(dataDir, 'h').workspaces, []);
});

test('long account chains reuse one lineage and clean up without duplicate members', () => {
  const dataDir = tempDataDir();
  setAutoCopyRule(dataDir, { uid: 'h', kind: 'session', key: 'session-chain', enabled: true });
  const lineageId = getAutoCopySession(dataDir, 'h', 'session-chain').lineageId;
  for (let i = 0; i < 100; i++) {
    addAutoCopySessionMember(dataDir, lineageId, 'account-' + i, 'copy-' + i);
    addAutoCopySessionMember(dataDir, lineageId, 'account-' + i, 'copy-' + i);
    setAutoCopyMapping(dataDir, lineageId, 'account-' + i, { targetId: 'copy-' + i });
  }
  const meta = JSON.parse(fs.readFileSync(metaFile(dataDir), 'utf8'));
  assert.equal(meta.autoCopy.sessions[lineageId].members.length, 101);
  for (let i = 0; i < 100; i++) assert.equal(getAutoCopySession(dataDir, 'account-' + i, 'copy-' + i).lineageId, lineageId);
  assert.equal(removeAutoCopyAccount(dataDir, 'h'), 1);
  assert.equal(getAutoCopyMapping(dataDir, lineageId, 'account-99').targetId, 'copy-99');
  for (let i = 0; i < 100; i++) assert.equal(removeAutoCopyAccount(dataDir, 'account-' + i), 1);
  assert.equal(getAutoCopyMapping(dataDir, lineageId, 'account-99'), null);
});

test('model backups preserve full local config while enabling one id removes official duplicates', () => {
  const dataDir = tempDataDir();
  const modelsFile = path.join(dataDir, 'models.json');
  const official = [
    { id: 'same-id', name: 'Old label', apiKey: 'secret-a', url: 'https://one.invalid' },
    { id: 'same-id', name: 'New label', apiKey: 'secret-b', url: 'https://two.invalid' },
    { id: 'other-id', name: 'Other', apiKey: 'secret-c' },
  ];
  fs.writeFileSync(modelsFile, JSON.stringify(official));
  assert.equal(listOfficialModels(modelsFile).length, 3);
  // 模型页 UI 需要明文展示 apiKey（cell / 编辑弹窗），列表接口按 { revealKey: true } 返回明文；
  // sanitizeModel 默认仍脱敏，供非展示场景使用。
  assert.equal(listOfficialModels(modelsFile)[0].apiKey, 'secret-a');
  assert.equal(sanitizeModel(official[0]).apiKey, '••••••');
  assert.notEqual(sanitizeModel(official[0]).apiKey, 'secret-a');

  const backup = backupOfficialModel(dataDir, 1, modelsFile);
  assert.equal(backup.id, 'same-id');
  assert.equal(listModelBackups(dataDir)[0].items.length, 1);
  const enabled = enableModelBackup(dataDir, backup.backupId, modelsFile);
  assert.equal(enabled.id, 'same-id');
  const after = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
  assert.equal(after.filter((model) => model.id === 'same-id').length, 1);
  assert.equal(after.find((model) => model.id === 'same-id').apiKey, 'secret-b');

  const copied = copyModelBackup(dataDir, backup.backupId);
  assert.notEqual(copied.backupId, backup.backupId);
  assert.equal(copied.apiKey, '••••••');
  const edited = editModelBackup(dataDir, copied.backupId, { id: 'deepseek-v4-flash', name: '我的 DeepSeek', url: 'https://edited.invalid', apiKey: 'secret-edited' });
  assert.equal(edited.id, 'deepseek-v4-flash');
  assert.equal(edited.name, '我的 DeepSeek');
  const editedRecord = JSON.parse(fs.readFileSync(path.join(dataDir, 'models', copied.backupId + '.json'), 'utf8'));
  assert.equal(editedRecord.model.id, 'deepseek-v4-flash');
  assert.equal(editedRecord.model.name, '我的 DeepSeek');
  assert.equal(edited.url, 'https://edited.invalid');
  const nameOnlyGroup = listModelBackups(dataDir).find((group) => group.id === 'deepseek-v4-flash');
  assert.equal(nameOnlyGroup.id, 'deepseek-v4-flash');
  assert.equal(nameOnlyGroup.items[0].name, '我的 DeepSeek');
  assert.equal(Object.prototype.hasOwnProperty.call(nameOnlyGroup.items[0], '_groupId'), false);
  assert.equal(edited.apiKey, 'sec••••••ited');
  const otherBackup = backupOfficialModel(dataDir, 1, modelsFile);
  editModelBackup(dataDir, otherBackup.backupId, { id: 'deepseek-v4-flash' });
  const editedGroup = listModelBackups(dataDir).find((group) => group.id === 'deepseek-v4-flash');
  assert.equal(editedGroup.items.length, 2);
  assert.equal(listModelBackups(dataDir).find((group) => group.id === 'same-id').items.length, 1);
  assert.equal(editedGroup.name, undefined);

  assert.equal(deleteModelBackups(dataDir, [backup.backupId, copied.backupId, otherBackup.backupId]), 3);
  assert.equal(listModelBackups(dataDir).length, 0);
});

test('same model id with different custom names stays in one id-named group', () => {
  const dataDir = tempDataDir();
  const modelsFile = path.join(dataDir, 'models.json');
  fs.writeFileSync(modelsFile, JSON.stringify([
    { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash2 aaa' },
    { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash2 bbb' },
  ]));
  backupOfficialModel(dataDir, 0, modelsFile);
  backupOfficialModel(dataDir, 1, modelsFile);
  const groups = listModelBackups(dataDir);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'deepseek-v4-flash');
  assert.equal(groups[0].items.length, 2);
  assert.deepEqual(groups[0].items.map((item) => item.name).sort(), ['deepseek-v4-flash2 aaa', 'deepseek-v4-flash2 bbb']);
});

test('official model batch deletion only changes official config and leaves backups intact', () => {
  const dataDir = tempDataDir();
  const modelsFile = path.join(dataDir, 'models.json');
  fs.writeFileSync(modelsFile, JSON.stringify([
    { id: 'one', name: 'One', apiKey: 'secret-one' },
    { id: 'two', name: 'Two', apiKey: 'secret-two' },
    { id: 'three', name: 'Three', apiKey: 'secret-three' },
  ]));
  const backup = backupOfficialModel(dataDir, 1, modelsFile);
  const result = deleteOfficialModels(modelsFile, [0, 2]);
  assert.equal(result.deleted, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(modelsFile, 'utf8')).map((model) => model.id), ['two']);
  assert.equal(listModelBackups(dataDir)[0].items[0].id, 'two');
  assert.equal(fs.existsSync(path.join(dataDir, 'models', backup.backupId + '.json')), true);
});

test('model import appends new names and preserves current same-name configuration', () => {
  const dataDir = tempDataDir();
  const targetFile = path.join(dataDir, 'current.json');
  const sourceFile = path.join(dataDir, 'source.json');
  fs.writeFileSync(targetFile, JSON.stringify({ models: [
    { id: 'shared-id', name: 'Shared', apiKey: 'current-key', url: 'https://current.invalid' },
  ], metadata: { keep: true }}));
  fs.writeFileSync(sourceFile, JSON.stringify({ models: [
    { id: 'shared-id', name: 'Shared', apiKey: 'source-key', url: 'https://source.invalid' },
    { id: 'new-id', name: 'New model', apiKey: 'new-key' },
  ], metadata: { source: true }}));

  const result = importModels(targetFile, sourceFile);
  assert.deepEqual(result.imported, ['New model']);
  assert.deepEqual(result.skipped, ['Shared']);
  const saved = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  assert.equal(saved.metadata.keep, true);
  assert.equal(saved.models.length, 2);
  assert.equal(saved.models[0].apiKey, 'current-key');
  assert.equal(saved.models[1].id, 'new-id');
});

test('api keys keep their full masked length without exposing the middle', () => {
  const raw = 'sk-abcdefghijklmnopqrstuvwxyz0123456789-dlzj';
  const masked = maskApiKey(raw);
  assert.equal(masked.length, raw.length);
  assert.equal(masked.slice(0, 3), 'sk-');
  assert.equal(masked.slice(-4), 'dlzj');
  assert.equal(masked.includes('abcdef'), false);
});

test('checkin display keeps a confirmed result while the current claim is still running', () => {
  const record = { date: '2026-08-23', ok: true, already: false, code: 0, message: 'ok' };
  assert.deepEqual(checkinDisplayValue(record, '2026-08-23', true), {
    ok: true, already: false, code: 0, message: 'ok',
  });
  assert.equal(checkinDisplayValue({ date: '2026-08-23', ok: false }, '2026-08-23', true), null);
  assert.deepEqual(checkinDisplayValue(record, '2026-08-23', false), {
    ok: true, already: false, code: 0, message: 'ok',
  });
  assert.equal(checkinDisplayValue(record, '2026-08-22', false), null);
});
