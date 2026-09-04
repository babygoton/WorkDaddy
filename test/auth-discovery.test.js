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
  // lib.js 按平台定位 auth 目录：macOS 用 ~/Library/Application Support，
  // Windows 用 %LOCALAPPDATA%；必须按平台建隔离目录，否则会扫到本机真实账号文件。
  const authDir = os.platform() === 'win32'
    ? path.join(root, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth')
    : path.join(root, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth');
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
    env: {
      ...process.env,
      HOME: root,
      LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
      WBSWITCH_PROFILE: profile,
      WBSWITCH_DATA_DIR: dataDir,
    },
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

test('legacy account metadata migrates to the canonical auth file for the same channel', () => {
  const f = fixture();
  try {
    const canonical = path.join(f.authDir, 'workbuddy-desktop.info');
    fs.writeFileSync(canonical, JSON.stringify(auth('current', 'https://www.workbuddy.cn/auth/realms/copilot')));
    fs.mkdirSync(path.join(f.dataDir, 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(f.dataDir, 'accounts', 'legacy.info'), JSON.stringify(auth('legacy', 'https://www.workbuddy.cn/auth/realms/copilot')));
    fs.writeFileSync(path.join(f.dataDir, 'meta.json'), JSON.stringify({
      accounts: {
        legacy: { uid: 'legacy', nickname: 'legacy', firstSeen: 1, lastSeen: 2 },
      },
    }));

    const switched = run(f.root, f.dataDir, 'process.stdout.write(JSON.stringify(lib.switchTo(process.env.WBSWITCH_DATA_DIR,"legacy")))');
    assert.equal(switched.authFile, canonical);
    assert.equal(JSON.parse(fs.readFileSync(canonical, 'utf8')).account.uid, 'legacy');
    const meta = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'meta.json'), 'utf8'));
    assert.equal(meta.accounts.legacy.authFileName, 'workbuddy-desktop.info');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recorded canonical auth target may be reused by another account in the same channel', () => {
  const f = fixture();
  try {
    const canonical = path.join(f.authDir, 'workbuddy-desktop.info');
    fs.writeFileSync(canonical, JSON.stringify(auth('current', 'https://www.workbuddy.cn/auth/realms/copilot')));
    fs.mkdirSync(path.join(f.dataDir, 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(f.dataDir, 'accounts', 'target.info'), JSON.stringify(auth('target', 'https://www.workbuddy.cn/auth/realms/copilot')));
    fs.writeFileSync(path.join(f.dataDir, 'meta.json'), JSON.stringify({
      accounts: {
        target: { uid: 'target', authFileName: 'workbuddy-desktop.info' },
      },
    }));

    const switched = run(f.root, f.dataDir, 'process.stdout.write(JSON.stringify(lib.switchTo(process.env.WBSWITCH_DATA_DIR,"target")))');
    assert.equal(switched.authFile, canonical);
    assert.equal(JSON.parse(fs.readFileSync(canonical, 'utf8')).account.uid, 'target');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recorded individual auth target still refuses to overwrite a different auth channel', () => {
  const f = fixture();
  try {
    // 个性化文件名（非官方固定文件）是账号专属登录位，跨通道时保持拒绝。
    const individual = path.join(f.authDir, 'opaque-target.info');
    fs.writeFileSync(individual, JSON.stringify(auth('current', 'https://www.codebuddy.cn/auth/realms/copilot')));
    fs.mkdirSync(path.join(f.dataDir, 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(f.dataDir, 'accounts', 'target.info'), JSON.stringify(auth('target', 'https://www.workbuddy.cn/auth/realms/copilot')));
    fs.writeFileSync(path.join(f.dataDir, 'meta.json'), JSON.stringify({
      accounts: {
        target: { uid: 'target', authFileName: 'opaque-target.info' },
      },
    }));

    const result = run(f.root, f.dataDir, `try { lib.switchTo(process.env.WBSWITCH_DATA_DIR,'target'); process.stdout.write('unexpected') } catch (e) { process.stdout.write(JSON.stringify(e.message)) }`);
    assert.match(result, /其他认证通道/);
    assert.equal(JSON.parse(fs.readFileSync(individual, 'utf8')).account.uid, 'current');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('recorded canonical auth file may be reused across different auth channels', () => {
  const f = fixture();
  try {
    // 官方固定文件是跨账号轮流登录的共享登录位：当前被 codebuddy 通道占用时，
    // workbuddy 通道账号（meta 明确记录该文件）切换应允许覆盖，否则永远切不回来。
    const canonical = path.join(f.authDir, 'workbuddy-desktop.info');
    fs.writeFileSync(canonical, JSON.stringify(auth('current', 'https://www.codebuddy.cn/auth/realms/copilot')));
    fs.mkdirSync(path.join(f.dataDir, 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(f.dataDir, 'accounts', 'target.info'), JSON.stringify(auth('target', 'https://www.workbuddy.cn/auth/realms/copilot')));
    fs.writeFileSync(path.join(f.dataDir, 'meta.json'), JSON.stringify({
      accounts: {
        target: { uid: 'target', authFileName: 'workbuddy-desktop.info' },
      },
    }));

    const switched = run(f.root, f.dataDir, 'process.stdout.write(JSON.stringify(lib.switchTo(process.env.WBSWITCH_DATA_DIR,"target")))');
    assert.equal(switched.authFile, canonical);
    assert.equal(JSON.parse(fs.readFileSync(canonical, 'utf8')).account.uid, 'target');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('legacy account may overwrite the occupied canonical auth file from another channel', () => {
  const f = fixture();
  try {
    // 真实「切换失败」场景：legacy 账号（无任何文件记录，workbuddy.cn 通道）
    // 切到已被 codebuddy.cn 账号占用的官方固定文件，必须允许写回。
    const canonical = path.join(f.authDir, 'workbuddy-desktop.info');
    fs.writeFileSync(canonical, JSON.stringify(auth('current', 'https://www.codebuddy.cn/auth/realms/copilot')));
    fs.mkdirSync(path.join(f.dataDir, 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(f.dataDir, 'accounts', 'legacy.info'), JSON.stringify(auth('legacy', 'https://www.workbuddy.cn/auth/realms/copilot')));
    fs.writeFileSync(path.join(f.dataDir, 'meta.json'), JSON.stringify({
      accounts: {
        legacy: { uid: 'legacy', nickname: 'legacy', firstSeen: 1, lastSeen: 2 },
      },
    }));

    const switched = run(f.root, f.dataDir, 'process.stdout.write(JSON.stringify(lib.switchTo(process.env.WBSWITCH_DATA_DIR,"legacy")))');
    assert.equal(switched.authFile, canonical);
    assert.equal(JSON.parse(fs.readFileSync(canonical, 'utf8')).account.uid, 'legacy');
    const meta = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'meta.json'), 'utf8'));
    assert.equal(meta.accounts.legacy.authFileName, 'workbuddy-desktop.info');
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

test('switch writes the occupied canonical file despite multiple lastLogin markers', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.authDir, 'workbuddy-desktop.info'), JSON.stringify(auth('s', 'https://www.workbuddy.cn/auth/realms/copilot')));
    fs.writeFileSync(path.join(f.authDir, 's-history.info'), JSON.stringify(auth('s', 'https://www.workbuddy.cn/auth/realms/copilot', true)));
    fs.writeFileSync(path.join(f.authDir, 'h-history.info'), JSON.stringify(auth('h', 'https://www.workbuddy.cn/auth/realms/copilot', true)));
    run(f.root, f.dataDir, 'lib.backupCurrent(process.env.WBSWITCH_DATA_DIR); process.stdout.write("null")');
    // 官方固定登录位是官方实际读取点：即使 meta 记录过 h 的历史存档文件名，
    // 固定文件存在时一切显式切换也写固定文件，避免写在官方不读的历史存档上。
    const switched = run(f.root, f.dataDir, 'process.stdout.write(JSON.stringify(lib.switchTo(process.env.WBSWITCH_DATA_DIR,"h")))');
    assert.equal(switched.authFile.endsWith('workbuddy-desktop.info'), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.authDir, 'workbuddy-desktop.info'), 'utf8')).account.uid, 'h');
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('backup scan does not drift the account->file binding to historical archives', () => {
  const f = fixture();
  try {
    // 历史存档（带 lastLogin 标记）存在时，备份扫描不得覆盖切换建立的账号->登录文件绑定
    const canonical = path.join(f.authDir, 'workbuddy-desktop.info');
    fs.writeFileSync(canonical, JSON.stringify(auth('s', 'https://www.workbuddy.cn/auth/realms/copilot')));
    fs.writeFileSync(path.join(f.authDir, 'h-history.info'), JSON.stringify(auth('h', 'https://www.workbuddy.cn/auth/realms/copilot', true)));
    fs.mkdirSync(path.join(f.dataDir, 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(f.dataDir, 'accounts', 'h.info'), JSON.stringify(auth('h', 'https://www.workbuddy.cn/auth/realms/copilot')));
    fs.writeFileSync(path.join(f.dataDir, 'meta.json'), JSON.stringify({
      accounts: { h: { uid: 'h', nickname: 'h', authFileName: 'workbuddy-desktop.info' } },
    }));
    run(f.root, f.dataDir, 'lib.backupCurrent(process.env.WBSWITCH_DATA_DIR); process.stdout.write("null")');
    const meta = run(f.root, f.dataDir, 'process.stdout.write(require("fs").readFileSync(process.env.WBSWITCH_DATA_DIR+"/meta.json","utf8"))');
    assert.equal(meta.accounts.h.authFileName, 'workbuddy-desktop.info');
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
