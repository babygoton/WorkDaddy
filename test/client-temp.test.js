'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectClientTemp, requestClientTempCleanup, runPendingClientTempCleanup } = require('../scripts/client-temp');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-client-temp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const profile = { id: 'workbuddy-cn' };
  const root = path.join(dir, 'client-tmp', profile.id);
  const old = new Date(Date.now() - 14 * 86400000);
  function file(name, content = 'temporary', aged = true) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    if (aged) {
      fs.utimesSync(target, old, old);
      for (let parent = path.dirname(target); parent !== root; parent = path.dirname(parent)) fs.utimesSync(parent, old, old);
    }
    return target;
  }
  const inspect = () => inspectClientTemp(dir, profile, 'win32');
  const request = enabled => requestClientTempCleanup(dir, profile, enabled, 'win32');
  const run = (isStopped = () => true) => runPendingClientTempCleanup(dir, profile, { platform: 'win32', isStopped });
  return { dir, root, profile, file, inspect, request, run };
}

test('#507 cleanup is opt-in, survives restart, and stays inside the current profile', async t => {
  const f = fixture(t);
  const target = f.file('old-cache/data');
  const sibling = path.join(f.dir, 'client-tmp/workbuddy-ai/keep');
  const account = path.join(f.dir, 'accounts/keep');
  for (const file of [sibling, account]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'keep'); }
  assert.equal((await f.inspect()).cleanableBytes, 9);
  await f.run(() => { throw Error('no request must not query processes'); });
  assert.ok(fs.existsSync(target));
  f.request(true);
  assert.equal((await f.inspect()).pending, true);
  const result = await f.run();
  assert.equal(result.removedBytes, 9);
  assert.equal(fs.existsSync(target), false);
  assert.ok(fs.existsSync(sibling));
  assert.ok(fs.existsSync(account));
  assert.equal((await f.inspect()).pending, false);
});

test('recent trees and official updater caches are retained as whole entries', async t => {
  const f = fixture(t);
  const oldInActive = f.file('active/old');
  const recent = f.file('active/recent', 'new', false);
  const installer = f.file('WorkBuddy-Update-x64/WorkBuddy-Setup-9.exe');
  const nestedInstaller = f.file('nested/workbuddy-update-arm64/Setup.exe');
  const old = f.file('unused/file');
  assert.equal((await f.inspect()).cleanableBytes, 9);
  f.request(true);
  await f.run();
  for (const file of [oldInActive, recent, installer, nestedInstaller]) assert.ok(fs.existsSync(file), file);
  assert.equal(fs.existsSync(old), false);
});

test('running, unknown and failed process checks never authorize deletion', async t => {
  const f = fixture(t);
  const file = f.file('keep');
  f.request(true);
  for (const check of [() => false, () => undefined, () => { throw Error('query failed'); }]) {
    await f.run(check);
    assert.ok(fs.existsSync(file));
    assert.equal((await f.inspect()).pending, true);
  }
  f.request(false);
  await f.run();
  assert.ok(fs.existsSync(file));
});

test('files changed since the cleanup request remain untouched', async t => {
  const f = fixture(t);
  const file = f.file('changed');
  f.request(true);
  fs.writeFileSync(file, 'active');
  await f.run();
  assert.equal(fs.readFileSync(file, 'utf8'), 'active');
});

test('links, hardlinks and linked roots cannot lead cleanup outside the managed directory', async t => {
  const f = fixture(t);
  const outside = path.join(f.dir, 'outside');
  fs.mkdirSync(outside);
  const keep = path.join(outside, 'keep');
  fs.writeFileSync(keep, 'outside');
  f.file('old');
  fs.linkSync(keep, path.join(f.root, 'hardlink'));
  fs.symlinkSync(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  f.request(true);
  await f.run();
  assert.equal(fs.readFileSync(keep, 'utf8'), 'outside');
  assert.ok(fs.lstatSync(path.join(f.root, 'linked')).isSymbolicLink());
  fs.rmSync(f.root, { recursive: true });
  fs.symlinkSync(outside, f.root, process.platform === 'win32' ? 'junction' : 'dir');
  f.request(true);
  await assert.rejects(f.inspect(), /目录/);
  await f.run();
  assert.equal(fs.readFileSync(keep, 'utf8'), 'outside');
});

test('unsupported platforms/profiles and malformed requests cannot schedule cleanup', async t => {
  const f = fixture(t);
  for (const [profile, platform] of [[f.profile, 'darwin'], [{ id: 'codebuddy-cn' }, 'win32'], [{ id: '../escape' }, 'win32'], [{ id: 'workbuddy-cn', customTarget: true }, 'win32']]) {
    assert.equal((await inspectClientTemp(f.dir, profile, platform)).supported, false);
    assert.throws(() => requestClientTempCleanup(f.dir, profile, true, platform));
  }
  for (const value of [null, 1, 'true', {}, undefined]) assert.throws(() => f.request(value));
});

test('locked files are skipped, never reported as successfully removed', async t => {
  const f = fixture(t);
  const file = f.file('locked');
  f.request(true);
  const real = fs.promises.rm;
  t.mock.method(fs.promises, 'rm', async (target, options) => {
    if (target === file) throw Object.assign(Error('locked'), { code: 'EBUSY' });
    return real(target, options);
  });
  const result = await f.run();
  assert.equal(result.removedBytes, 0);
  assert.equal(result.skippedEntries, 1);
  assert.ok(fs.existsSync(file));
});

test('a late cancellation or client start prevents removal after the scan', async t => {
  for (const cancel of [false, true]) {
    const f = fixture(t);
    const file = f.file('old');
    f.request(true);
    let calls = 0;
    await f.run(() => {
      if (++calls === 1) { if (cancel) f.request(false); return true; }
      return false;
    });
    assert.ok(fs.existsSync(file));
  }
});

test('a concurrent launch cannot pass an active cleanup lock, even after cancellation', async t => {
  const f = fixture(t);
  f.file('old');
  f.request(true);
  f.request(false);
  const lock = path.join(f.dir, '.client-temp-cleanup-workbuddy-cn.lock');
  fs.writeFileSync(lock, String(process.pid));
  await assert.rejects(f.run(), /清理/);
  fs.unlinkSync(lock);
});

test('client temp API accepts only a scheduling flag and never deletes in the renderer request', async t => {
  const f = fixture(t);
  const file = f.file('old');
  const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const start = source.indexOf("  if (req.method === 'GET' && p === '/api/client-temp')");
  const end = source.indexOf("  if (req.method === 'GET' && p === '/api/client-launch-settings')", start);
  const handler = new Function('req', 'p', 'res', 'PROFILE', 'DATA_DIR', 'process', 'readBody', 'json',
    'inspectClientTemp', 'requestClientTempCleanup', source.slice(start, end));
  const call = (method, body, platform = 'win32') => handler({ method }, '/api/client-temp', {}, f.profile, f.dir, { platform },
    async () => body, (_, status, data) => ({ status, data }),
    (dir, profile) => inspectClientTemp(dir, profile, platform),
    (dir, profile, enabled) => requestClientTempCleanup(dir, profile, enabled, platform));
  assert.equal((await call('GET')).data.cleanableBytes, 9);
  assert.equal((await call('POST', { pending: true, path: '../accounts' })).data.pending, true);
  assert.ok(fs.existsSync(file));
  assert.equal((await call('POST', { pending: 'true' })).status, 400);
  assert.equal((await call('POST', { pending: true }, 'darwin')).status, 400);
  assert.equal((await call('POST', { pending: false })).data.pending, false);
});

test('all Windows launch paths await cleanup before spawning and use a strict process query', () => {
  const launcher = fs.readFileSync(path.join(__dirname, '../scripts/win-launcher.js'), 'utf8');
  for (const name of ['waitForWorkBuddyCdp', 'waitForWorkBuddyCdpNative']) {
    const part = launcher.slice(launcher.indexOf(`async function ${name}(`));
    assert.ok(part.indexOf('await runPendingClientTempCleanup(') < part.indexOf('launchWorkBuddy(binary)'));
    assert.match(part.slice(0, part.indexOf('launchWorkBuddy(binary)')), /getWorkBuddyProcesses\(\)\.length === 0/);
  }
  const daemon = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
  const part = daemon.slice(daemon.indexOf('function relaunchWorkBuddy()'));
  assert.ok(part.indexOf('await runPendingClientTempCleanup(') < part.indexOf('spawn(command, args'));
  assert.match(part.slice(0, part.indexOf('spawn(command, args')), /verifiedWindowsWorkBuddyProcesses\(command\)\.length === 0/);
});

test('about-page cleanup is on demand, exposes cancellation and recovers from save failure', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../scripts/inject.js'), 'utf8');
  const start = source.indexOf('    function wireClientTempCleanup()');
  const end = source.indexOf('    function wireClientLaunchSettings()', start);
  const element = () => ({ disabled: false, textContent: '', events: {}, addEventListener(name, fn) { this.events[name] = fn; } });
  const scan = element(), clean = element(), status = element();
  let reads = 0, fail = false, pending = true;
  const context = {
    WBS_BRAND: 'WorkDaddy', registerDisposer() {},
    aboutPane: { querySelector: () => ({ querySelector: selector => ({ '#wbs-client-temp-status': status, '#wbs-client-temp-scan': scan, '#wbs-client-temp-clean': clean })[selector] }) },
    api: async (_, options) => {
      if (!options) { reads++; return { supported: true, pending, bytes: 20, cleanableBytes: 10 }; }
      if (fail) throw Error('write failed');
      pending = JSON.parse(options.body).pending;
      return { supported: true, pending };
    },
  };
  vm.runInNewContext(source.slice(start, end), context);
  context.wireClientTempCleanup();
  assert.equal(reads, 0, 'opening About must not walk the filesystem');
  await scan.events.click();
  assert.equal(clean.textContent, '取消清理');
  fail = true;
  clean.events.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clean.disabled, false);
  assert.equal(pending, true);
  fail = false;
  clean.events.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending, false);
  assert.equal(clean.textContent, '下次启动清理');
});
