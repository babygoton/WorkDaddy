'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-multichannel-auth-'));
const local = path.join(root, 'Local');
const roaming = path.join(root, 'Roaming');
process.env.WBSWITCH_PROFILE = 'workbuddy-ai';
process.env.LOCALAPPDATA = local;
process.env.APPDATA = roaming;
delete process.env.WBSWITCH_AUTH_FILE;

const lib = require('../scripts/lib.js');

function authPayload(uid, domain, lastRefreshTime) {
  return {
    account: { uid, nickname: uid, type: 'personal', lastLogin: true },
    auth: { domain, lastRefreshTime },
  };
}

function writeAuth(name, payload) {
  const file = path.join(lib.authDir(), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

test('WorkBuddy AI discovers and restores channel-specific auth files without mixing domestic WorkBuddy', (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const aiFile = writeAuth('workbuddy-desktop-ai.info', authPayload('uid-ai', 'www.workbuddy.ai', 100));
  const tencentFile = writeAuth('Tencent-Cloud.coding-copilot.info', authPayload('uid-tencent', 'www.codebuddy.cn', 200));
  writeAuth('workbuddy-desktop.info', authPayload('uid-domestic', 'www.codebuddy.cn', 300));
  writeAuth('workbuddy-desktop-ai.2026-09-02T01-02-03-004Z.1234.snapshot.info', authPayload('uid-snapshot', 'www.workbuddy.ai', 400));

  assert.deepEqual(lib.listAuthFiles().map((file) => path.basename(file)), [
    'workbuddy-desktop-ai.info',
    'Tencent-Cloud.coding-copilot.info',
  ]);
  assert.equal(lib.currentAuthFile(), tencentFile);

  const dataDir = path.join(roaming, 'WorkDaddy', 'profiles', 'workbuddy-ai');
  const current = lib.backupCurrent(dataDir);
  assert.equal(current.uid, 'uid-tencent');
  assert.equal(fs.existsSync(lib.backupPath(dataDir, 'uid-ai')), true);
  assert.equal(fs.existsSync(lib.backupPath(dataDir, 'uid-tencent')), true);

  const meta = JSON.parse(fs.readFileSync(lib.metaFile(dataDir), 'utf8'));
  assert.equal(meta.accounts['uid-ai'].authFileName, 'workbuddy-desktop-ai.info');
  assert.equal(meta.accounts['uid-tencent'].authFileName, 'Tencent-Cloud.coding-copilot.info');
  assert.equal(meta.accounts['uid-tencent'].authDomain, 'www.codebuddy.cn');

  fs.writeFileSync(aiFile, JSON.stringify(authPayload('temporary-ai', 'www.workbuddy.ai', 500)));
  lib.switchTo(dataDir, 'uid-ai');
  assert.equal(JSON.parse(fs.readFileSync(aiFile, 'utf8')).account.uid, 'uid-ai');
  assert.equal(JSON.parse(fs.readFileSync(tencentFile, 'utf8')).account.uid, 'uid-tencent');

  fs.writeFileSync(tencentFile, JSON.stringify(authPayload('temporary-tencent', 'www.codebuddy.cn', 600)));
  lib.switchTo(dataDir, 'uid-tencent');
  assert.equal(JSON.parse(fs.readFileSync(tencentFile, 'utf8')).account.uid, 'uid-tencent');
  assert.equal(JSON.parse(fs.readFileSync(aiFile, 'utf8')).account.uid, 'uid-ai');
});
