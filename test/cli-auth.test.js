// CodeBuddy CLI 认证文件写入回归测试。
// 用临时目录隔离 CLI 认证文件，避免影响本机真实配置。
// 验证：首次创建、保留既有非敏感字段、uid 三重校验防串号、写回读回校验、status 脱敏。
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const cliAuth = require('../scripts/cli-auth.js');

const UID = '287fd808-990c-47d4-9c91-4be23e6e3e31';
const OTHER_UID = '24e91016-1111-2222-3333-444455556666';

function backupFixture(uid, nickname) {
  return {
    account: { uid: uid, nickname: nickname || '账号甲', uin: '10001', type: 'personal', phoneNumber: '19900000000' },
    auth: {
      accessToken: 'eyJhbGciOi.access-token-' + uid,
      refreshToken: 'eyJhbGciOi.refresh-token-' + uid,
      tokenType: 'Bearer',
      domain: 'www.workbuddy.cn',
      expiresAt: 1792742478313,
      refreshExpiresAt: 1792742478314,
    },
    accounts: [{ uid: uid, nickname: nickname || '账号甲' }],
    allAccounts: [{ uid: uid, nickname: nickname || '账号甲' }],
  };
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-cli-auth-'));
  const accountsDir = path.join(root, 'accounts');
  const cliAuthDir = path.join(root, 'auth');
  const cliAuthFile = path.join(cliAuthDir, 'Tencent-Cloud.coding-copilot.info');
  fs.mkdirSync(accountsDir, { recursive: true });
  fs.mkdirSync(cliAuthDir, { recursive: true });
  return { root, accountsDir, cliAuthDir, cliAuthFile };
}

function writeBackup(accountsDir, uid, backup) {
  fs.writeFileSync(path.join(accountsDir, uid + '.info'), JSON.stringify(backup), { mode: 0o600 });
}

test('status reports empty when CLI auth file does not exist', () => {
  const s = sandbox();
  const st = cliAuth.status({ cliAuthFile: s.cliAuthFile });
  assert.equal(st.configured, false);
  assert.equal(st.activeUid, '');
  assert.equal(st.activeNickname, '');
});

test('syncAccount creates CLI auth file from backup on first sync', () => {
  const s = sandbox();
  writeBackup(s.accountsDir, UID, backupFixture(UID, '账号甲'));
  const r = cliAuth.syncAccount(UID, {
    backupFile: path.join(s.accountsDir, UID + '.info'),
    cliAuthFile: s.cliAuthFile,
  });
  assert.equal(r.activeUid, UID);
  assert.equal(r.activeNickname, '账号甲');
  assert.ok(fs.existsSync(s.cliAuthFile));

  const written = JSON.parse(fs.readFileSync(s.cliAuthFile, 'utf8'));
  assert.equal(written.account.uid, UID);
  assert.equal(written.auth.accessToken, 'eyJhbGciOi.access-token-' + UID);
  assert.equal(written.auth.refreshToken, 'eyJhbGciOi.refresh-token-' + UID);
});

test('syncAccount preserves existing non-sensitive fields and replaces account/auth', () => {
  const s = sandbox();
  // CLI 已有认证文件（含一个自定义顶层字段 + 旧账号）
  const existing = {
    customField: 'keep-me',
    account: { uid: OTHER_UID, nickname: '旧账号' },
    auth: { accessToken: 'old-at', refreshToken: 'old-rt', tokenType: 'Bearer' },
    accounts: [{ uid: OTHER_UID, nickname: '旧账号' }],
    allAccounts: [{ uid: OTHER_UID, nickname: '旧账号' }],
  };
  fs.writeFileSync(s.cliAuthFile, JSON.stringify(existing), { mode: 0o600 });

  writeBackup(s.accountsDir, UID, backupFixture(UID, '账号甲'));
  cliAuth.syncAccount(UID, {
    backupFile: path.join(s.accountsDir, UID + '.info'),
    cliAuthFile: s.cliAuthFile,
  });

  const written = JSON.parse(fs.readFileSync(s.cliAuthFile, 'utf8'));
  assert.equal(written.customField, 'keep-me', '应保留既有非敏感顶层字段');
  assert.equal(written.account.uid, UID, 'account 应替换为目标账号');
  assert.equal(written.auth.accessToken, 'eyJhbGciOi.access-token-' + UID, 'auth.accessToken 应替换');
  // 目标账号在 accounts 列表置顶，旧账号保留
  assert.equal(written.accounts[0].uid, UID);
  assert.ok(written.accounts.some((a) => a.uid === OTHER_UID), '旧账号应保留在 accounts 列表');
});

test('syncAccount aborts when backup uid does not match request', () => {
  const s = sandbox();
  // 写一个文件名 uid 与内容 account.uid 不一致的损坏备份
  fs.writeFileSync(path.join(s.accountsDir, OTHER_UID + '.info'),
    JSON.stringify(backupFixture(UID, '错位账号')), { mode: 0o600 });
  assert.throws(() => cliAuth.syncAccount(OTHER_UID, {
    backupFile: path.join(s.accountsDir, OTHER_UID + '.info'),
    cliAuthFile: s.cliAuthFile,
  }), /不一致|不匹配/);
});

test('syncAccount aborts when backup is missing', () => {
  const s = sandbox();
  assert.throws(() => cliAuth.syncAccount(UID, {
    backupFile: path.join(s.accountsDir, UID + '.info'),
    cliAuthFile: s.cliAuthFile,
  }), (e) => {
    assert.equal(e.statusCode, 404);
    return /不存在/.test(e.message);
  });
});

test('syncAccount aborts when backup lacks accessToken', () => {
  const s = sandbox();
  const broken = backupFixture(UID, '账号甲');
  delete broken.auth.accessToken;
  writeBackup(s.accountsDir, UID, broken);
  assert.throws(() => cliAuth.syncAccount(UID, {
    backupFile: path.join(s.accountsDir, UID + '.info'),
    cliAuthFile: s.cliAuthFile,
  }), /accessToken/);
});

test('status reflects active account after sync (no token in output)', () => {
  const s = sandbox();
  writeBackup(s.accountsDir, UID, backupFixture(UID, '账号甲'));
  cliAuth.syncAccount(UID, {
    backupFile: path.join(s.accountsDir, UID + '.info'),
    cliAuthFile: s.cliAuthFile,
  });
  const st = cliAuth.status({ cliAuthFile: s.cliAuthFile });
  assert.equal(st.configured, true);
  assert.equal(st.activeUid, UID);
  assert.equal(st.activeNickname, '账号甲');
  // 状态查询不应返回 token
  const raw = JSON.stringify(st);
  assert.ok(!/access[_-]?token/i.test(raw.replace(/cliAuthFile/i, '')), 'status 不应包含 token 字段');
});

test('repeated sync to different account swaps active uid', () => {
  const s = sandbox();
  writeBackup(s.accountsDir, UID, backupFixture(UID, '账号甲'));
  writeBackup(s.accountsDir, OTHER_UID, backupFixture(OTHER_UID, '账号乙'));

  cliAuth.syncAccount(UID, {
    backupFile: path.join(s.accountsDir, UID + '.info'),
    cliAuthFile: s.cliAuthFile,
  });
  let st = cliAuth.status({ cliAuthFile: s.cliAuthFile });
  assert.equal(st.activeUid, UID);

  cliAuth.syncAccount(OTHER_UID, {
    backupFile: path.join(s.accountsDir, OTHER_UID + '.info'),
    cliAuthFile: s.cliAuthFile,
  });
  st = cliAuth.status({ cliAuthFile: s.cliAuthFile });
  assert.equal(st.activeUid, OTHER_UID);
  assert.equal(st.activeNickname, '账号乙');

  // 两个账号都应在 accounts 列表
  const written = JSON.parse(fs.readFileSync(s.cliAuthFile, 'utf8'));
  assert.ok(written.accounts.some((a) => a.uid === UID));
  assert.ok(written.accounts.some((a) => a.uid === OTHER_UID));
});
