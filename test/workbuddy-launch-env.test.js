'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { getClientLaunchArgs } = require('../scripts/client-launch-settings.js');
const { getWorkBuddyLaunchEnv } = require('../scripts/workbuddy-launch-env.js');
const { PROFILES } = require('../scripts/profiles.js');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-update-424-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function launchContext(profile, dataDir, env, spawn) {
  const ctx = {
    PROFILE: profile, DATA_DIR: dataDir, CDP_PORT: 9223,
    process: { platform: 'win32', env }, IS_WIN: true, IS_LINUX: false, path,
    getClientLaunchArgs,
    getWorkBuddyLaunchEnv,
    log() {}, selectCdpPort: async () => 9223,
    resolveWorkBuddyBinary: () => 'C:\\WorkBuddy.exe', sleep: async () => {}, restoreWorkBuddyWindow: async () => {},
    spawn(command, args, options) {
      spawn(command, Array.from(args), options);
      const child = new EventEmitter(); child.pid = 123; child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  };
  for (const [file, startMarker, endMarker] of [
    ['win-launcher.js', 'function launchWorkBuddy(wb)', '\nasync function waitForWorkBuddyCdp'],
    ['daemon.js', 'function relaunchWorkBuddy()', '\n/**'],
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '../scripts', file), 'utf8');
    const start = source.indexOf(startMarker);
    vm.runInNewContext(source.slice(start, source.indexOf(endMarker, start)), ctx);
  }
  return ctx;
}

for (const id of ['workbuddy-cn', 'workbuddy-ai', 'codebuddy-cn', 'codebuddy-intl']) {
  test(`#468 ${id}: Windows GUI startup and relaunch never request a hidden main window`, async t => {
    const dir = fixture(t);
    const launches = [];
    const profile = { ...PROFILES[id], dataRoot: path.join(dir, id), cdp: { ...PROFILES[id].cdp } };
    const ctx = launchContext(profile, dir, {}, (command, args, options) => launches.push({ command, args, options }));
    for (const mode of ['environment', 'argument']) {
      profile.cdp.mode = mode;
      ctx.launchWorkBuddy('C:\\WorkBuddy.exe');
      await ctx.relaunchWorkBuddy();
      assert.equal(launches.length, 2);
      for (const launch of launches.splice(0)) {
        assert.equal(launch.options.windowsHide, false, 'GUI spawn must not inherit SW_HIDE');
        assert.equal(launch.options.detached, true);
        assert.equal(launch.options.stdio, 'ignore');
        if (mode === 'environment') {
          assert.equal(launch.options.env.WORKBUDDY_REMOTE_DEBUGGING_PORT, '9223');
        } else {
          assert.ok(launch.args.includes('--remote-debugging-port=9223'));
          if (profile.nativeDebugPort) assert.ok(launch.args.includes(`--inspect=127.0.0.1:${profile.nativeDebugPort}`));
        }
      }
    }
  });
}

// Replay the official updater's two independent inputs: an environment override
// wins over the remembered endpoint, but startup restores installers from TEMP
// before checking the feed (main/update-service{,.win32}.js in WorkBuddy).
function replayOfficialUpdater(env, dataRoot) {
  const endpoint = env.WORKBUDDY_UPDATE_URL || JSON.parse(fs.readFileSync(path.join(dataRoot, 'cache/update-endpoint.json'), 'utf8')).endpoint;
  const cache = path.join(env.TEMP, 'workbuddy-update-x64');
  const installers = fs.existsSync(cache) ? fs.readdirSync(cache).filter(name => /^WorkBuddy-Setup-(.+)\.exe$/i.test(name)) : [];
  return { endpoint, cache, installers };
}

for (const [id, endpoint] of [
  ['workbuddy-cn', 'https://www.workbuddy.cn'],
  ['workbuddy-ai', 'https://www.workbuddy.ai'],
]) {
  test(`#424 ${id}: startup and daemon relaunch ignore the sibling feed and shared cached installer`, async t => {
    const dir = fixture(t);
    const dataRoot = path.join(dir, id === 'workbuddy-cn' ? '.workbuddy' : '.workbuddy-ai');
    const siblingEndpoint = id === 'workbuddy-cn' ? 'https://www.workbuddy.ai' : 'https://www.workbuddy.cn';
    const sharedTemp = path.join(dir, 'shared-temp');
    const sharedCache = path.join(sharedTemp, 'workbuddy-update-x64');
    fs.mkdirSync(sharedCache, { recursive: true });
    fs.writeFileSync(path.join(sharedCache, 'WorkBuddy-Setup-99.0.0.exe'), 'wrong-client-fixture');
    fs.mkdirSync(path.join(dataRoot, 'cache'), { recursive: true });
    const remembered = JSON.stringify({ endpoint: siblingEndpoint });
    fs.writeFileSync(path.join(dataRoot, 'cache/update-endpoint.json'), remembered);
    const env = Object.freeze({ TEMP: sharedTemp, TMP: sharedTemp, WORKBUDDY_UPDATE_URL: siblingEndpoint,
      WORKBUDDY_CONFIG_DIR: path.join(dir, 'sibling'), CODEBUDDY_CONFIG_DIR: path.join(dir, 'sibling'),
      WORKBUDDY_DATA_FOLDER_NAME: '.wrong-client', UNRELATED: 'keep' });
    const launches = [];
    const ctx = launchContext({ id, dataRoot, cdp: { mode: 'environment' } }, dir, env,
      (_command, args, options) => launches.push({ args, env: options.env }));
    for (const mode of ['environment', 'argument']) {
      ctx.PROFILE.cdp.mode = mode;
      ctx.launchWorkBuddy('C:\\WorkBuddy.exe');
      await ctx.relaunchWorkBuddy();
    }
    assert.equal(launches.length, 4);
    for (const launch of launches) {
      const restored = replayOfficialUpdater(launch.env, dataRoot);
      assert.equal(restored.endpoint, endpoint, 'the selected profile must own the update feed');
      assert.deepEqual(restored.installers, [], 'an old wrong-client installer must never be restored');
      assert.notEqual(launch.env.TEMP, sharedTemp);
      assert.equal(launch.env.TEMP, launch.env.TMP);
      assert.ok(fs.statSync(launch.env.TEMP).isDirectory());
      assert.equal(launch.env.WORKBUDDY_CONFIG_DIR, dataRoot);
      assert.equal(launch.env.CODEBUDDY_CONFIG_DIR, dataRoot);
      assert.equal(launch.env.WORKBUDDY_DATA_FOLDER_NAME, path.basename(dataRoot));
      assert.equal(launch.env.UNRELATED, 'keep');
      if (launch.args.length === 0) assert.equal(launch.env.WORKBUDDY_REMOTE_DEBUGGING_PORT, '9223');
      else assert.deepEqual(launch.args, ['--remote-debugging-port=9223']);
    }
    assert.equal(new Set(launches.map(launch => launch.env.TEMP)).size, 1, 'cache survives restarts');
    assert.equal(fs.readFileSync(path.join(sharedCache, 'WorkBuddy-Setup-99.0.0.exe'), 'utf8'), 'wrong-client-fixture');
    assert.equal(fs.readFileSync(path.join(dataRoot, 'cache/update-endpoint.json'), 'utf8'), remembered);
    assert.equal(env.WORKBUDDY_UPDATE_URL, siblingEndpoint, 'parent environment is never changed');
  });
}

test('#424 a correct feed must also exclude the wrong shared installer', async t => {
  const dir = fixture(t);
  const sharedCache = path.join(dir, 'workbuddy-update-x64');
  fs.mkdirSync(sharedCache);
  fs.writeFileSync(path.join(sharedCache, 'WorkBuddy-Setup-99.0.0.exe'), 'wrong-client-fixture');
  const env = { TEMP: dir, TMP: dir, WORKBUDDY_UPDATE_URL: 'https://www.workbuddy.cn' };
  const ctx = launchContext({ id: 'workbuddy-cn', dataRoot: path.join(dir, '.workbuddy') }, dir, env,
    (_command, _args, options) => assert.deepEqual(replayOfficialUpdater(options.env).installers, []));
  ctx.launchWorkBuddy('C:\\WorkBuddy.exe');
  await ctx.relaunchWorkBuddy();
});

test('CN and AI have independent persistent caches even with the same WorkDaddy data directory', t => {
  const dir = fixture(t);
  const cn = { id: 'workbuddy-cn', dataRoot: path.join(dir, '.workbuddy') };
  const ai = { id: 'workbuddy-ai', dataRoot: path.join(dir, '.workbuddy-ai') };
  const cnEnv = getWorkBuddyLaunchEnv(cn, dir, 'win32', {});
  const aiEnv = getWorkBuddyLaunchEnv(ai, dir, 'win32', cnEnv);
  assert.notEqual(cnEnv.TEMP, aiEnv.TEMP);
  for (const [profile, env] of [[cn, cnEnv], [ai, aiEnv]]) {
    const cache = path.join(env.TEMP, 'workbuddy-update-x64');
    fs.mkdirSync(cache);
    fs.writeFileSync(path.join(cache, 'WorkBuddy-Setup-100.0.0.exe'), profile.id);
    const nextEnv = getWorkBuddyLaunchEnv(profile, dir, 'win32', aiEnv);
    const restored = replayOfficialUpdater(nextEnv);
    assert.equal(nextEnv.TEMP, env.TEMP, 'inherited TEMP must not cause nesting');
    assert.deepEqual(restored.installers, ['WorkBuddy-Setup-100.0.0.exe'], 'valid new updates remain available');
    assert.equal(fs.readFileSync(path.join(restored.cache, restored.installers[0]), 'utf8'), profile.id);
  }
});

test('Windows case variants cannot shadow the profile overrides', t => {
  const dir = fixture(t);
  const profile = { id: 'workbuddy-cn', dataRoot: path.join(dir, '.workbuddy') };
  const inherited = Object.freeze({ temp: 'wrong', Tmp: 'wrong', TeMp: 'wrong', workbuddy_update_url: 'wrong',
    WorkBuddy_Config_Dir: 'wrong', codebuddy_config_dir: 'wrong', workbuddy_data_folder_name: '.wrong', Path: 'keep' });
  const env = getWorkBuddyLaunchEnv(profile, dir, 'win32', inherited);
  for (const key of ['TEMP', 'TMP', 'WORKBUDDY_UPDATE_URL', 'WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR', 'WORKBUDDY_DATA_FOLDER_NAME']) {
    assert.deepEqual(Object.keys(env).filter(name => name.toUpperCase() === key), [key]);
  }
  assert.equal(env.WORKBUDDY_UPDATE_URL, 'https://www.workbuddy.cn');
  assert.equal(env.Path, 'keep');
});

test('other platforms, CodeBuddy and enterprise targets preserve their launch environments without creating directories', t => {
  const dir = fixture(t);
  const env = Object.freeze({ TEMP: 'custom', WORKBUDDY_UPDATE_URL: 'https://updates.example.test', CODEBUDDY_CONFIG_DIR: 'custom' });
  for (const [profile, platform] of [
    [{ id: 'workbuddy-cn' }, 'darwin'], [{ id: 'workbuddy-ai' }, 'linux'],
    [{ id: 'codebuddy-cn' }, 'win32'], [{ id: 'codebuddy-intl' }, 'win32'],
    [{ id: 'workbuddy-cn', customTarget: true }, 'win32'], [{ id: 'workbuddy-ai', customTarget: true }, 'win32'],
  ]) {
    const childEnv = getWorkBuddyLaunchEnv(profile, dir, platform, env);
    assert.deepEqual(childEnv, env);
    assert.notEqual(childEnv, env);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('both launch paths fail before spawning when cache isolation is unavailable', async t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'client-tmp'), 'cannot-create-directory');
  let spawned = false;
  const ctx = launchContext({ id: 'workbuddy-cn', dataRoot: path.join(dir, '.workbuddy') }, dir, {}, () => { spawned = true; });
  assert.throws(() => ctx.launchWorkBuddy('C:\\WorkBuddy.exe'), /独立临时目录/);
  await assert.rejects(ctx.relaunchWorkBuddy(), /独立临时目录/);
  assert.equal(spawned, false);
});
