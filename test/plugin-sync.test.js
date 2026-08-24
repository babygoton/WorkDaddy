const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  PLUGIN_SECRET_KEY,
  PLUGIN_SYNC_EDITORS,
  findPluginSyncEditor,
  pluginSyncEditorPaths,
  secretValueToBuffer,
  bufferToSecretValue,
  decryptSecretBuffer,
  encryptSecretBuffer,
  normalizeBackup,
  buildPluginSecretPlain,
  verifySyncedPlain,
} = require('../scripts/plugin-sync.js');

const UID = '287fd808-990c-47d4-9c91-4be23e6e3e31';
const OTHER_UID = '24e91016-1111-2222-3333-444455556666';

function backupFixture(uid = UID) {
  return {
    account: { uid, nickname: '账号甲', uin: '10001', type: 'personal' },
    auth: {
      accessToken: 'eyJhbGciOi.access-token',
      refreshToken: 'eyJhbGciOi.refresh-token',
      tokenType: 'Bearer',
      domain: 'www.workbuddy.cn',
      expiresAt: 1792742478313,
      refreshExpiresAt: 1792742478314,
    },
    accounts: [{ uid, nickname: '账号甲' }],
  };
}

function templateFixture(uid = OTHER_UID) {
  return {
    id: 'Tencent-Cloud.coding-copilot',
    domain: 'copilot.tencent.com',
    converted: true,
    account: { uid, nickname: '账号乙' },
    accounts: [{ uid, nickname: '账号乙' }, { uid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000', nickname: '账号丙' }],
    auth: { accessToken: 'old-access', domain: 'copilot.tencent.com', customField: 'keep-me' },
    token: 'old-token',
    refreshToken: 'old-refresh',
    accessToken: 'old-session',
    expiresAt: 1111111111111,
  };
}

test('editor registry only exposes cursor and vscode', () => {
  assert.deepEqual(PLUGIN_SYNC_EDITORS.map((e) => e.id), ['cursor', 'vscode']);
  assert.ok(!PLUGIN_SYNC_EDITORS.some((e) => /windsurf|trae/i.test(e.id + e.label)));
  assert.equal(findPluginSyncEditor('Cursor').id, 'cursor');
  assert.equal(findPluginSyncEditor('VSCODE').id, 'vscode');
  assert.equal(findPluginSyncEditor('windsurf'), null);
});

test('editor paths point at per-editor globalStorage state.vscdb', () => {
  const cursor = pluginSyncEditorPaths(findPluginSyncEditor('cursor'), 'C:/roaming');
  assert.equal(cursor.localState, path.join('C:/roaming', 'Cursor', 'Local State'));
  assert.equal(cursor.stateDb, path.join('C:/roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  const code = pluginSyncEditorPaths(findPluginSyncEditor('vscode'), 'C:/roaming');
  assert.ok(code.stateDb.includes(path.join('Code', 'User', 'globalStorage', 'state.vscdb')));
});

test('plugin secret key targets the coding-copilot accessToken entry', () => {
  assert.equal(
    PLUGIN_SECRET_KEY,
    'secret://{"extensionId":"tencent-cloud.coding-copilot","key":"Tencent-Cloud.coding-copilot.new.accessToken"}'
  );
});

test('secret value JSON wrapper converts to v10 blob and back', () => {
  const blob = encryptSecretBuffer(Buffer.alloc(32, 7), Buffer.from('{"a":1}', 'utf8'));
  const value = bufferToSecretValue(blob);
  assert.ok(value.startsWith('{"type":"Buffer","data":[118,49,48,'));
  assert.deepEqual(secretValueToBuffer(value), blob);
  assert.deepEqual(secretValueToBuffer(Buffer.from(blob)), blob);
  assert.throws(() => secretValueToBuffer('not json'), /有效的 JSON Buffer 包装/);
  assert.throws(() => secretValueToBuffer('{"type":"Buffer"}'), /缺少 Buffer 数据/);
});

test('aes-gcm roundtrip and tamper detection', () => {
  const key = Buffer.alloc(32, 9);
  const plain = Buffer.from(JSON.stringify(backupFixture()), 'utf8');
  const blob = encryptSecretBuffer(key, plain);
  assert.equal(blob.subarray(0, 3).toString('latin1'), 'v10');
  const out = decryptSecretBuffer(key, blob);
  assert.deepEqual(JSON.parse(out.toString('utf8')).account.uid, UID);
  // 每次加密随机 nonce：两次密文不同但明文一致
  assert.notDeepEqual(encryptSecretBuffer(key, plain), blob);
  // 篡改密文应解密失败
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 20] ^= 0xff;
  assert.throws(() => decryptSecretBuffer(key, tampered));
  // 非 v10 前缀
  assert.throws(() => decryptSecretBuffer(key, Buffer.concat([Buffer.from('v11'), blob.subarray(3)])), /加密版本/);
  // 长度异常
  assert.throws(() => decryptSecretBuffer(key, Buffer.from('v101234')), /长度异常/);
});

test('normalizeBackup rejects uid mismatch and missing session fields', () => {
  assert.equal(normalizeBackup(backupFixture(), UID).account.uid, UID);
  assert.throws(() => normalizeBackup(backupFixture(), OTHER_UID), /uid 与请求不一致/);
  assert.throws(() => normalizeBackup({ account: { uid: UID } }, UID), /缺少 accessToken\/refreshToken/);
  assert.throws(() => normalizeBackup(null, UID), /备份内容无效/);
});

test('buildPluginSecretPlain merges backup session fields into plugin template', () => {
  const template = templateFixture();
  const backup = backupFixture();
  const next = buildPluginSecretPlain(template, backup, UID);

  // 会话字段全部来自备份 auth（accessToken 塞 JWT 由插件刷新自我修复，见技术总结）
  assert.equal(next.token, backup.auth.accessToken);
  assert.equal(next.refreshToken, backup.auth.refreshToken);
  assert.equal(next.accessToken, backup.auth.accessToken);
  assert.equal(next.expiresAt, backup.auth.expiresAt);
  // 账号身份切换为新账号并置顶；插件端其他账户原样保留
  assert.equal(next.account.uid, UID);
  assert.deepEqual(next.accounts.map((a) => a.uid), [UID, OTHER_UID, 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000']);
  // 内层 auth 被备份覆盖但保留模板独有字段
  assert.equal(next.auth.accessToken, backup.auth.accessToken);
  assert.equal(next.auth.domain, backup.auth.domain);
  assert.equal(next.auth.customField, 'keep-me');
  // 插件自有字段保留
  assert.equal(next.id, 'Tencent-Cloud.coding-copilot');
  assert.equal(next.domain, 'copilot.tencent.com');
  assert.equal(next.converted, true);
  // 模板对象不被修改
  assert.equal(template.token, 'old-token');
  assert.equal(template.account.uid, OTHER_UID);
});

test('buildPluginSecretPlain tolerates template without inner auth and missing expiresAt', () => {
  const template = { account: { uid: OTHER_UID }, token: 't', refreshToken: 'r', accessToken: 'a', expiresAt: 42 };
  const backup = backupFixture();
  delete backup.auth.expiresAt;
  const next = buildPluginSecretPlain(template, backup, UID);
  assert.equal(next.auth, undefined);
  assert.equal(next.expiresAt, 42); // 备份无 expiresAt 时保留模板字段
  assert.deepEqual(next.accounts.map((a) => a.uid), [UID]);
});

test('buildPluginSecretPlain replaces an existing same-uid entry instead of duplicating', () => {
  const template = templateFixture();
  template.accounts = [{ uid: UID, nickname: '旧的同号项' }, { uid: OTHER_UID, nickname: '账号乙' }];
  const next = buildPluginSecretPlain(template, backupFixture(), UID);
  assert.deepEqual(next.accounts.map((a) => a.uid), [UID, OTHER_UID]);
  assert.equal(next.accounts[0].nickname, '账号甲'); // 用备份身份替换插件端旧项
});

test('verifySyncedPlain enforces target uid and session fields', () => {
  assert.equal(verifySyncedPlain(buildPluginSecretPlain(templateFixture(), backupFixture(), UID), UID), true);
  const wrong = buildPluginSecretPlain(templateFixture(), backupFixture(), UID);
  wrong.account.uid = OTHER_UID;
  assert.throws(() => verifySyncedPlain(wrong, UID), /与目标账号不一致/);
  const noToken = buildPluginSecretPlain(templateFixture(), backupFixture(), UID);
  delete noToken.token;
  assert.throws(() => verifySyncedPlain(noToken, UID), /缺少 token\/refreshToken/);
});

test('end-to-end pure-logic flow mimics the daemon write path', () => {
  const key = Buffer.alloc(32, 3);
  // 编辑器现状：模板明文加密成 ItemTable value
  const currentPlain = templateFixture();
  const storedValue = bufferToSecretValue(encryptSecretBuffer(key, Buffer.from(JSON.stringify(currentPlain), 'utf8')));
  // 同步：读 → 解密 → 合并备份 → 加密写回（新 nonce）→ 读回校验
  const readBlob = secretValueToBuffer(storedValue);
  const template = JSON.parse(decryptSecretBuffer(key, readBlob).toString('utf8'));
  const next = buildPluginSecretPlain(template, backupFixture(), UID);
  const writeValue = bufferToSecretValue(encryptSecretBuffer(key, Buffer.from(JSON.stringify(next), 'utf8')));
  assert.notEqual(writeValue, storedValue);
  const verifyPlain = JSON.parse(decryptSecretBuffer(key, secretValueToBuffer(writeValue)).toString('utf8'));
  assert.equal(verifySyncedPlain(verifyPlain, UID), true);
  assert.equal(verifyPlain.account.nickname, '账号甲');
});
