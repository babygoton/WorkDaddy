'use strict';

const assert = require('node:assert/strict');
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
  addAutoCopySessionMember,
  moveAutoCopySession,
  removeAutoCopySession,
  removeAutoCopyAccount,
  setAutoCopyMapping,
  getAutoCopyMapping,
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
} = require('../scripts/lib.js');

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-auto-copy-'));
}

function writeMeta(dataDir, value) {
  fs.writeFileSync(metaFile(dataDir), JSON.stringify(value, null, 2), { mode: 0o600 });
}

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
  // canonicalWorkspace 在 Windows 上会转小写，断言用同一函数求期望值，保持跨平台一致
  assert.equal(canonicalWorkspace('/Users/example/Repo/'), canonicalWorkspace('/Users/example/Repo'));
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

test('workspace rules are global across source accounts', () => {
  const dataDir = tempDataDir();
  setAutoCopyRule(dataDir, { uid: 'h', kind: 'workspace', key: '/Users/h/Repo/', enabled: true });
  // canonicalWorkspace 在 Windows 上会转小写，期望值用同一函数求得，避免平台差异
  const repoKey = canonicalWorkspace('/Users/h/Repo');
  assert.deepEqual(getAutoCopyRules(dataDir, 'h').workspaces, [repoKey]);
  assert.deepEqual(getAutoCopyRules(dataDir, 's').workspaces, [repoKey]);
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
  const edited = editModelBackup(dataDir, copied.backupId, { name: 'Edited label', url: 'https://edited.invalid', apiKey: 'secret-edited' });
  assert.equal(edited.name, 'Edited label');
  assert.equal(edited.url, 'https://edited.invalid');
  assert.equal(edited.apiKey, 'sec••••••ited');
  assert.equal(listModelBackups(dataDir).find((group) => group.id === 'same-id').items.length, 2);

  assert.equal(deleteModelBackups(dataDir, [backup.backupId, copied.backupId]), 2);
  assert.equal(listModelBackups(dataDir).length, 0);
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

test('api keys keep their full masked length without exposing the middle', () => {
  const raw = 'sk-abcdefghijklmnopqrstuvwxyz0123456789-dlzj';
  const masked = maskApiKey(raw);
  assert.equal(masked.length, raw.length);
  assert.equal(masked.slice(0, 3), 'sk-');
  assert.equal(masked.slice(-4), 'dlzj');
  assert.equal(masked.includes('abcdef'), false);
});
