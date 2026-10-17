'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { readClientLaunchSettings, setClientLaunchSettings, getClientLaunchArgs } = require('../scripts/client-launch-settings.js');
const { getWorkBuddyLaunchEnv } = require('../scripts/workbuddy-launch-env.js');
const read = name => fs.readFileSync(path.join(__dirname, '../scripts', name), 'utf8');
const expectedFlags = ['--disable-gpu', '--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader'];
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbs-gpu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('software rendering is opt-in, persistent and reversible without accepting arbitrary flags', t => {
  const dir = fixture(t);
  assert.deepEqual(readClientLaunchSettings(dir, 'workbuddy-ai', 'win32'), { supported: true, softwareRendering: false });
  assert.deepEqual(getClientLaunchArgs(dir, 'workbuddy-ai', 'win32'), []);
  setClientLaunchSettings(dir, 'workbuddy-ai', { softwareRendering: true, args: ['--no-sandbox'] }, 'win32');
  assert.deepEqual(getClientLaunchArgs(dir, 'workbuddy-ai', 'win32'), expectedFlags);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'client-launch-settings.json'), 'utf8'), /no-sandbox/);
  setClientLaunchSettings(dir, 'workbuddy-ai', { softwareRendering: false }, 'win32');
  assert.deepEqual(getClientLaunchArgs(dir, 'workbuddy-ai', 'win32'), []);
  for (const value of ['true', 1, null, undefined]) {
    assert.throws(() => setClientLaunchSettings(dir, 'workbuddy-ai', { softwareRendering: value }, 'win32'), /布尔/);
  }
  fs.writeFileSync(path.join(dir, 'client-launch-settings.json'), '{broken');
  assert.deepEqual(getClientLaunchArgs(dir, 'workbuddy-ai', 'win32'), []);
  fs.writeFileSync(path.join(dir, 'client-launch-settings.json'), '{"softwareRendering":"false"}');
  assert.deepEqual(getClientLaunchArgs(dir, 'workbuddy-ai', 'win32'), []);
});

test('Windows AI settings never affect another profile or platform', t => {
  const dir = fixture(t);
  setClientLaunchSettings(dir, 'workbuddy-ai', { softwareRendering: true }, 'win32');
  for (const [id, platform] of [['workbuddy-cn', 'win32'], ['codebuddy-cn', 'win32'], ['workbuddy-ai', 'darwin'], ['workbuddy-ai', 'linux']]) {
    assert.deepEqual(readClientLaunchSettings(dir, id, platform), { supported: false, softwareRendering: false });
    assert.deepEqual(getClientLaunchArgs(dir, id, platform), []);
    assert.throws(() => setClientLaunchSettings(dir, id, { softwareRendering: true }, platform), /不支持/);
  }
});

test('normal Windows startup and daemon relaunch both apply the persisted flags with CDP intact', async t => {
  const dir = fixture(t);
  setClientLaunchSettings(dir, 'workbuddy-ai', { softwareRendering: true }, 'win32');
  const launches = [];
  const ctx = {
    PROFILE: { id: 'workbuddy-ai', dataRoot: path.join(dir, '.workbuddy-ai'), cdp: { mode: 'environment' } }, DATA_DIR: dir, CDP_PORT: 9223,
    process: { platform: 'win32', env: {} }, IS_WIN: true, IS_LINUX: false, path,
    getClientLaunchArgs, getWorkBuddyLaunchEnv, log() {}, selectCdpPort: async () => 9223,
    resolveWorkBuddyBinary: () => 'C:\\WorkBuddyAI.exe', sleep: async () => {}, restoreWorkBuddyWindow: async () => {},
    spawn: (command, args, options) => {
      launches.push({ command, args: Array.from(args), options });
      const child = new EventEmitter(); child.pid = 123; child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  };
  const launcher = read('win-launcher.js'), daemon = read('daemon.js');
  vm.runInNewContext(launcher.slice(launcher.indexOf('function launchWorkBuddy(wb)'), launcher.indexOf('\nasync function waitForWorkBuddyCdp')), ctx);
  const start = daemon.indexOf('function relaunchWorkBuddy()');
  vm.runInNewContext(daemon.slice(start, daemon.indexOf('\n/**', start)), ctx);
  for (const environmentMode of [true, false]) {
    ctx.PROFILE.cdp.mode = environmentMode ? 'environment' : 'argument';
    ctx.launchWorkBuddy('C:\\WorkBuddyAI.exe');
    await ctx.relaunchWorkBuddy();
    for (const launch of launches.splice(0)) {
      assert.deepEqual(launch.args, [...(environmentMode ? [] : ['--remote-debugging-port=9223']), ...expectedFlags]);
      if (environmentMode) assert.equal(launch.options.env.WORKBUDDY_REMOTE_DEBUGGING_PORT, '9223');
    }
  }
});

test('local settings API validates writes and reports unsupported clients', async t => {
  const dir = fixture(t);
  const source = read('daemon.js');
  const start = source.indexOf("  if (req.method === 'GET' && p === '/api/client-launch-settings')");
  const end = source.indexOf("  // 诊断：保存一份", start);
  assert.ok(start >= 0 && end > start);
  const handler = new Function('req', 'p', 'res', 'PROFILE', 'DATA_DIR', 'process', 'readBody', 'json',
    'readClientLaunchSettings', 'setClientLaunchSettings', source.slice(start, end));
  const call = (method, body, profile = 'workbuddy-ai', platform = 'win32') => handler(
    { method }, '/api/client-launch-settings', {}, { id: profile }, dir, { platform }, async () => body,
    (_res, status, data) => ({ status, data }), readClientLaunchSettings, setClientLaunchSettings);
  assert.equal((await call('GET')).data.softwareRendering, false);
  assert.equal((await call('POST', { softwareRendering: true })).data.softwareRendering, true);
  assert.equal((await call('GET')).data.softwareRendering, true);
  assert.equal((await call('POST', { softwareRendering: 'true' })).status, 400);
  assert.equal((await call('POST', { softwareRendering: true }, 'workbuddy-cn')).status, 400);
  assert.equal((await call('GET', null, 'workbuddy-ai', 'darwin')).data.supported, false);
});

test('rendering switch waits for settings, persists changes and rolls back a failed save', async () => {
  const source = read('inject.js');
  const start = source.indexOf('    function wireClientLaunchSettings()');
  const end = source.indexOf('    function wireTelemetrySettings()', start);
  const events = {}, status = { textContent: '' };
  const toggle = { disabled: true, checked: false, addEventListener: (event, fn) => { events[event] = fn; } };
  let fail = false, reads = 0, saved;
  const ctx = {
    aboutPane: { querySelector: selector => selector === '#wbs-software-rendering' ? toggle : status },
    api: async (_path, options) => {
      if (!options) { reads++; return { supported: true, softwareRendering: true }; }
      if (fail) throw new Error('write failed');
      saved = JSON.parse(options.body).softwareRendering;
      return { supported: true, softwareRendering: saved };
    },
  };
  vm.runInNewContext(source.slice(start, end), ctx);
  ctx.wireClientLaunchSettings();
  assert.equal(toggle.disabled, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, false);
  toggle.checked = false; events.change();
  assert.equal(toggle.disabled, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved, false);
  assert.match(status.textContent, /下次/);
  fail = true; toggle.checked = true; events.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false);
  assert.match(status.textContent, /保存失败/);
});
