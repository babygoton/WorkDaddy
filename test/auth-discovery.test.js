'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function jwt(issuer) {
  const payload = Buffer.from(JSON.stringify({ iss: issuer }), 'utf8').toString('base64url');
  return `header.${payload}.signature`;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-auth-'));
  const authDir = path.join(root, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
  const dataDir = path.join(root, 'WorkDaddy');
  fs.mkdirSync(authDir, { recursive: true });
  return { root, authDir, dataDir };
}

function auth(uid, issuer, lastLogin = false) {
  return {
    account: { uid, nickname: uid, lastLogin },
    auth: { accessToken: jwt(issuer), domain: new URL(issuer).origin, lastRefreshTime: Date.now() },
  };
}

function run(root, dataDir, code, profile = 'workbuddy-cn') {
  const script = `const lib=require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'lib.js'))}); ${code}`;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: root, WBSWITCH_PROFILE: profile, WBSWITCH_DATA_DIR: dataDir },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout || 'null');
}

test('default WorkBuddy profiles scan valid info files regardless of filename', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.authDir, 'Tencent-Cloud.coding-copilot.info'), JSON.stringify(auth('cn-user', 'https://www.codebuddy.cn/auth/realms/copilot')));
    fs.writeFileSync(path.join(f.authDir, 'opaque-login.info'), JSON.stringify(auth('cn-user-2', 'https://www.workbuddy.cn/auth/realms/copilot', true)));
    fs.writeFileSync(path.join(f.authDir, 'snapshot.info.tmp'), '{}');
    fs.writeFileSync(path.join(f.authDir, 'other-product.info'), JSON.stringify(auth('other', 'https://untrusted.example/auth')));
    const records = run(f.root, f.dataDir, 'process.stdout.write(JSON.stringify(lib.listAuthRecords().map(x=>({uid:x.uid,name:x.authFileName}))))');
    assert.deepEqual(records.map((x) => x.uid).sort(), ['cn-user', 'cn-user-2']);
    const current = run(f.root, f.dataDir, 'process.stdout.write(JSON.stringify(lib.resolveCurrentAuth()))');
    assert.equal(path.basename(current.file), 'opaque-login.info');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('multiple valid files without one lastLogin marker are ambiguous and backup all', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.authDir, 'a.info'), JSON.stringify(auth('a', 'https://www.codebuddy.cn/auth/realms/copilot')));
    fs.writeFileSync(path.join(f.authDir, 'b.info'), JSON.stringify(auth('b', 'https://www.workbuddy.cn/auth/realms/copilot')));
    const current = run(f.root, f.dataDir, 'process.stdout.write(JSON.stringify(lib.resolveCurrentAuth()))');
    assert.equal(current.file, null);
    assert.equal(current.ambiguous, true);
    const backup = run(f.root, f.dataDir, 'process.stdout.write(JSON.stringify(lib.backupCurrent(process.env.WBSWITCH_DATA_DIR)))');
    assert.equal(backup.backedUp, 2);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'accounts', 'a.info')), true);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'accounts', 'b.info')), true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('switch writes only the metadata-recorded opaque filename', () => {
  const f = fixture();
  try {
    const source = path.join(f.authDir, 'channel-a.info');
    fs.writeFileSync(source, JSON.stringify(auth('a', 'https://www.codebuddy.cn/auth/realms/copilot', true)));
    fs.writeFileSync(path.join(f.authDir, 'channel-b.info'), JSON.stringify(auth('b', 'https://www.workbuddy.cn/auth/realms/copilot')));
    run(f.root, f.dataDir, 'lib.backupCurrent(process.env.WBSWITCH_DATA_DIR); process.stdout.write("null")');
    fs.unlinkSync(source);
    fs.unlinkSync(path.join(f.authDir, 'channel-b.info'));
    const switched = run(f.root, f.dataDir, 'process.stdout.write(JSON.stringify(lib.switchTo(process.env.WBSWITCH_DATA_DIR,"a")))');
    assert.equal(switched.authFile.endsWith('channel-a.info'), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.authDir, 'channel-a.info'), 'utf8')).account.uid, 'a');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('explicit WBSWITCH_AUTH_FILE keeps the legacy single-file behavior', () => {
  const f = fixture();
  const file = path.join(f.authDir, 'legacy-name.info');
  fs.writeFileSync(file, JSON.stringify({ account: { uid: 'legacy' }, auth: {} }));
  const script = `const lib=require(${JSON.stringify(path.join(__dirname, '..', 'scripts', 'lib.js'))}); process.stdout.write(JSON.stringify(lib.readAuthFile().uid))`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, WBSWITCH_AUTH_FILE: file, WBSWITCH_DATA_DIR: f.dataDir } });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), 'legacy');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('missing filename metadata refuses a switch instead of falling back to a guessed file', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.dataDir, 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(f.dataDir, 'accounts', 'target.info'), JSON.stringify(auth('target', 'https://www.codebuddy.cn/auth/realms/copilot')));
    const result = run(f.root, f.dataDir, `try { lib.switchTo(process.env.WBSWITCH_DATA_DIR,'target'); process.stdout.write('unexpected') } catch (e) { process.stdout.write(JSON.stringify(e.message)) }`);
    assert.match(result, /拒绝/);
    assert.equal(fs.readdirSync(f.authDir).length, 0);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('canonical fixed info file wins over historical lastLogin markers', () => {
  const f = fixture();
  try {
    // 真实回归：固定文件 + 多条历史文件都残留 lastLogin:true（旧代码判成 ambiguous，拒绝切换）
    fs.writeFileSync(path.join(f.authDir, 'workbuddy-desktop.info'), JSON.stringify(auth('s', 'https://www.workbuddy.cn/auth/realms/copilot')));
    fs.writeFileSync(path.join(f.authDir, 's-history.info'), JSON.stringify(auth('s', 'https://www.workbuddy.cn/auth/realms/copilot', true)));
    fs.writeFileSync(path.join(f.authDir, 'h-history.info'), JSON.stringify(auth('h', 'https://www.workbuddy.cn/auth/realms/copilot', true)));
    const current = run(f.root, f.dataDir, 'process.stdout.write(JSON.stringify(lib.resolveCurrentAuth()))');
    assert.equal(path.basename(current.file), 'workbuddy-desktop.info');
    assert.equal(current.record.uid, 's');
    assert.equal(current.ambiguous, false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('switch must succeed via the recorded target name despite multiple lastLogin markers', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.authDir, 'workbuddy-desktop.info'), JSON.stringify(auth('s', 'https://www.workbuddy.cn/auth/realms/copilot')));
    fs.writeFileSync(path.join(f.authDir, 's-history.info'), JSON.stringify(auth('s', 'https://www.workbuddy.cn/auth/realms/copilot', true)));
    fs.writeFileSync(path.join(f.authDir, 'h-history.info'), JSON.stringify(auth('h', 'https://www.workbuddy.cn/auth/realms/copilot', true)));
    run(f.root, f.dataDir, 'lib.backupCurrent(process.env.WBSWITCH_DATA_DIR); process.stdout.write("null")');
    // meta.json 已记录 h 的目标文件名（h-history.info），切换不再被当前歧义一票否决
    const switched = run(f.root, f.dataDir, 'process.stdout.write(JSON.stringify(lib.switchTo(process.env.WBSWITCH_DATA_DIR,"h")))');
    assert.equal(switched.authFile.endsWith('h-history.info'), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.authDir, 'h-history.info'), 'utf8')).account.uid, 'h');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('AI profile does not claim a domestic Tencent/CodeBuddy auth file', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.authDir, 'opaque.info'), JSON.stringify(auth('cn', 'https://www.codebuddy.cn/auth/realms/copilot')));
    const records = run(f.root, f.dataDir, 'process.stdout.write(JSON.stringify(lib.listAuthRecords()))', 'workbuddy-ai');
    assert.deepEqual(records, []);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
