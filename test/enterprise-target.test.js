'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildOfficialTargetFromBinary,
  buildTargetFromBinary,
  inferredProcessNames,
  readWorkBuddyTarget,
  removeWorkBuddyTarget,
  writeWorkBuddyTarget,
} = require('../scripts/workbuddy-target.js');
const { PROFILES, getProfile } = require('../scripts/profiles.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-enterprise-'));
}

test('official profiles remain byte-for-byte equivalent when no custom target exists', () => {
  const dataDir = tempDir();
  try {
    for (const id of Object.keys(PROFILES)) {
      assert.deepEqual(getProfile(id, { dataDir, env: {} }), PROFILES[id]);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('selecting an enterprise executable derives its local data and CDP settings', () => {
  const root = tempDir();
  try {
    const home = path.join(root, 'Users', 'tester');
    const local = path.join(home, 'AppData', 'Local');
    const binary = path.join(local, 'Programs', 'workbuddy-ent', 'workbuddy-ent.exe');
    const dataRoot = path.join(home, '.workbuddy-ent');
    const authDir = path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
    const authFile = path.join(authDir, 'workbuddy-desktop-workbuddy-ent.info');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(binary, 'fixture');
    fs.writeFileSync(authFile, JSON.stringify({
      account: { uid: 'redacted', type: 'exclusive' },
      realm: { iss: 'https://api.ent.example.com/oauth' },
    }));

    const target = buildTargetFromBinary({
      binary,
      profileId: 'workbuddy-cn',
      version: '5.4.4.0',
      home,
      localAppData: local,
      platform: process.platform,
    });

    assert.equal(target.binary, binary);
    assert.equal(target.clientType, 'enterprise');
    assert.equal(target.version, '5.4.4.0');
    assert.deepEqual(target.processNames, ['workbuddy-ent.exe', 'WorkBuddyEnt.exe']);
    assert.equal(target.dataRoot, dataRoot);
    assert.equal(target.authFile, authFile);
    assert.equal(target.sessionDb, path.join(dataRoot, 'workbuddy.db'));
    assert.equal(target.modelsFile, path.join(dataRoot, 'models.json'));
    assert.equal(target.apiHost, 'https://api.ent.example.com');
    assert.deepEqual(target.cdp, { mode: 'environment', port: 9226 });
    assert.equal(target.capabilities.checkin, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('custom target persists outside the install and overlays only its base profile', () => {
  const dataDir = tempDir();
  try {
    const target = {
      schemaVersion: 1,
      profileId: 'workbuddy-cn',
      binary: 'C:\\Company\\workbuddy-ent.exe',
      version: '5.4.4.0',
      lockVersion: true,
      processName: 'workbuddy-ent.exe',
      dataRoot: 'C:\\Users\\tester\\.workbuddy-ent',
      authFile: 'C:\\Auth\\workbuddy-desktop-workbuddy-ent.info',
      sessionDb: 'C:\\Users\\tester\\.workbuddy-ent\\workbuddy.db',
      modelsFile: 'C:\\Users\\tester\\.workbuddy-ent\\models.json',
      apiHost: 'https://api.ent.example.com',
      targetHints: ['workbuddy-ent', 'api.ent.example.com'],
      cdp: { mode: 'environment', port: 9226 },
      capabilities: { checkin: false },
    };
    writeWorkBuddyTarget({ dataDir, profileId: 'workbuddy-cn', target, platform: 'win32' });
    const persisted = readWorkBuddyTarget({ dataDir, profileId: 'workbuddy-cn', env: {}, platform: 'win32' });
    const { processName, ...targetWithoutLegacyName } = target;
    assert.deepEqual(persisted, {
      ...targetWithoutLegacyName,
      clientType: 'enterprise',
      processNames: ['workbuddy-ent.exe'],
      configured: true,
      source: 'file',
    });

    const profile = getProfile('workbuddy-cn', { dataDir, env: {}, platform: 'win32' });
    assert.equal(profile.id, 'workbuddy-cn');
    assert.equal(profile.appPath, target.binary);
    assert.equal(profile.dataRoot, target.dataRoot);
    assert.equal(profile.authFile, target.authFile);
    assert.equal(profile.apiHost, target.apiHost);
    assert.deepEqual(profile.binaryNames, ['workbuddy-ent.exe']);
    assert.equal(profile.cdp.mode, 'environment');
    assert.equal(profile.capabilities.accounts, true);
    assert.equal(profile.capabilities.checkin, false);
    assert.equal(profile.customTarget, true);

    assert.deepEqual(getProfile('workbuddy-ai', { dataDir, env: {}, platform: 'win32' }), PROFILES['workbuddy-ai']);
    removeWorkBuddyTarget({ dataDir });
    assert.deepEqual(getProfile('workbuddy-cn', { dataDir, env: {}, platform: 'win32' }), PROFILES['workbuddy-cn']);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('enterprise profile overrides remain Windows-only and macOS keeps the official profile', () => {
  const dataDir = tempDir();
  try {
    writeWorkBuddyTarget({
      dataDir,
      profileId: 'workbuddy-cn',
      platform: 'win32',
      target: {
        schemaVersion: 1,
        profileId: 'workbuddy-cn',
        binary: 'C:\\Company\\workbuddy-ent.exe',
        processNames: ['workbuddy-ent.exe'],
        dataRoot: 'C:\\Users\\tester\\.workbuddy-ent',
        authFile: 'C:\\Auth\\workbuddy-desktop-workbuddy-ent.info',
        sessionDb: 'C:\\Users\\tester\\.workbuddy-ent\\workbuddy.db',
        modelsFile: 'C:\\Users\\tester\\.workbuddy-ent\\models.json',
        apiHost: 'https://api.ent.example.com',
        targetHints: ['workbuddy-ent', 'api.ent.example.com'],
        cdp: { mode: 'environment', port: 9226 },
      },
    });

    assert.deepEqual(
      getProfile('workbuddy-cn', { dataDir, env: {}, platform: 'darwin' }),
      PROFILES['workbuddy-cn']
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('selecting the official executable pins its path without changing official behavior', () => {
  const dataDir = tempDir();
  try {
    const target = buildOfficialTargetFromBinary({
      binary: 'D:\\Portable\\WorkBuddy.exe',
      profileId: 'workbuddy-cn',
      version: '5.4.4.0',
      platform: 'win32',
    });
    writeWorkBuddyTarget({ dataDir, profileId: 'workbuddy-cn', target, platform: 'win32' });
    const profile = getProfile('workbuddy-cn', { dataDir, env: {}, platform: 'win32' });

    assert.equal(target.clientType, 'official');
    assert.equal(profile.appPath, 'D:\\Portable\\WorkBuddy.exe');
    assert.equal(profile.configuredTarget, true);
    assert.equal(profile.customTarget, false);
    assert.equal(profile.cdp.mode, 'argument');
    assert.equal(profile.apiHost, PROFILES['workbuddy-cn'].apiHost);
    assert.equal(profile.authFile, PROFILES['workbuddy-cn'].authFile);
    assert.deepEqual(profile.capabilities, PROFILES['workbuddy-cn'].capabilities);
    assert.deepEqual(profile.targetHints, PROFILES['workbuddy-cn'].targetHints);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('installer configuration command persists exactly one selected client', () => {
  const dataDir = tempDir();
  const script = path.join(__dirname, '..', 'scripts', 'workbuddy-target.js');
  try {
    const official = spawnSync(process.execPath, [
      script, '--configure', '--profile', 'workbuddy-cn',
      '--binary', 'C:\\Apps\\WorkBuddy.exe', '--version', '5.4.4.0', '--data-dir', dataDir,
    ], { encoding: 'utf8' });
    assert.equal(official.status, 0, official.stderr);
    assert.equal(readWorkBuddyTarget({ dataDir, profileId: 'workbuddy-cn', env: {}, platform: 'win32' }).clientType, 'official');

    const enterprise = spawnSync(process.execPath, [
      script, '--configure', '--profile', 'workbuddy-cn',
      '--binary', 'C:\\Apps\\workbuddy-ent.exe', '--version', '5.4.5.0', '--data-dir', dataDir,
    ], { encoding: 'utf8' });
    assert.equal(enterprise.status, 0, enterprise.stderr);
    const selected = readWorkBuddyTarget({ dataDir, profileId: 'workbuddy-cn', env: {}, platform: 'win32' });
    assert.equal(selected.clientType, 'enterprise');
    assert.equal(selected.binary, 'C:\\Apps\\workbuddy-ent.exe');
    assert.equal(selected.version, '5.4.5.0');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('macOS launcher target probe remains a no-op outside Windows installer configuration', () => {
  const dataDir = tempDir();
  const script = path.join(__dirname, '..', 'scripts', 'workbuddy-target.js');
  try {
    const result = spawnSync(process.execPath, [
      script, '--profile', 'workbuddy-cn', '--data-dir', dataDir,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(path.join(dataDir, 'workbuddy-target.json')), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('unsafe enterprise target values fail closed', () => {
  const dataDir = tempDir();
  try {
    const base = {
      schemaVersion: 1,
      profileId: 'workbuddy-cn',
      binary: 'C:\\Company\\workbuddy-ent.exe',
      processName: 'workbuddy-ent.exe',
      dataRoot: 'C:\\Users\\tester\\.workbuddy-ent',
      authFile: 'C:\\Auth\\workbuddy.info',
      apiHost: 'https://api.ent.example.com',
      cdp: { mode: 'environment', port: 9226 },
    };
    for (const override of [
      { profileId: 'workbuddy-ai' },
      { binary: 'relative\\workbuddy-ent.exe' },
      { processName: '..\\not-safe.exe' },
      { processNames: ['workbuddy-ent.exe', '..\\not-safe.exe'] },
      { processNames: ['WorkBuddyEnt.exe'] },
      { apiHost: 'http://api.ent.example.com' },
      { apiHost: 'https://user:pass@api.ent.example.com' },
      { cdp: { mode: 'unknown', port: 9226 } },
      { cdp: { mode: 'environment', port: 80 } },
    ]) {
      assert.throws(
        () => writeWorkBuddyTarget({ dataDir, profileId: 'workbuddy-cn', target: { ...base, ...override }, platform: 'win32' }),
        /profile|absolute|进程名|HTTPS|CDP|port/i
      );
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('enterprise process candidates are narrow and keep the selected executable first', () => {
  assert.deepEqual(
    inferredProcessNames('C:\\Company\\workbuddy-ent.exe', 'win32'),
    ['workbuddy-ent.exe', 'WorkBuddyEnt.exe']
  );
  assert.deepEqual(
    inferredProcessNames('C:\\Company\\AcmeBuddy.exe', 'win32'),
    ['AcmeBuddy.exe']
  );
});

test('the existing Windows installer owns the single client selection flow', () => {
  const root = path.join(__dirname, '..');
  const launcher = fs.readFileSync(path.join(root, 'scripts', 'win-launcher.js'), 'utf8');
  const native = fs.readFileSync(path.join(root, 'scripts', 'windows-native', 'main.go'), 'utf8');
  const daemon = fs.readFileSync(path.join(root, 'scripts', 'daemon.js'), 'utf8');
  const inject = fs.readFileSync(path.join(root, 'scripts', 'inject.js'), 'utf8');
  const installer = fs.readFileSync(path.join(root, 'scripts', 'win', 'workdaddy.iss'), 'utf8');

  assert.match(launcher, /PROFILE\.cdp\.mode === 'environment'/);
  assert.match(launcher, /WORKBUDDY_REMOTE_DEBUGGING_PORT/);
  assert.doesNotMatch(launcher + native, /--select-workbuddy|GetOpenFileNameW/);
  assert.match(native, /workbuddy-target\.json/);
  assert.match(native, /ProcessNames/);
  assert.match(native, /--target-info/);
  assert.match(native, /ClientType\s+string\s+`json:"clientType"`/);
  assert.match(installer, /CreateInputFilePage/);
  assert.match(installer, /DetectOfficialClient/);
  assert.match(installer, /CurrentVersion\\Uninstall/);
  assert.match(installer, /CompareClientFileVersions/);
  assert.match(installer, /ReadSavedClient/);
  assert.match(installer, /使用自动识别路径/);
  assert.match(installer, /SaveSelectedClient/);
  assert.match(installer, /--configure --profile/);
  assert.match(installer, /--check-workbuddy --binary/);
  assert.doesNotMatch(daemon, /\/api\/workbuddy-target\/(?:select|reset)/);
  assert.doesNotMatch(inject, /wbs-client-target|选择其他 WorkBuddy 客户端|恢复自动识别/);
  assert.match(daemon, /u\.origin === PROFILE\.apiHost/);
  assert.doesNotMatch(launcher + daemon + native, /\bsetx(?:\.exe)?\b/i);
  assert.match(launcher, /所选 WorkBuddy 版本已变化/);
  assert.match(launcher, /重新运行 WorkDaddy 安装程序/);
});
