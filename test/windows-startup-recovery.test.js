'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/win-launcher.js'), 'utf8');

function harness({ changed = false, running = false, stable = true, recovered = true } = {}) {
  let now = 0, launches = 0, stops = 0, waits = 0;
  const context = {
    DATA_DIR: '/fixture', runPendingClientTempCleanup: async () => ({}),
    PROFILE: { id: 'workbuddy-cn' }, nativeLaunchState: null, CDP_PORT: 9222, CDP_STARTUP_TIMEOUT_MS: 60000,
    Date: { now: () => now }, process: { env: {} }, log() {}, writeCdpPortFile() {},
    sleep: async ms => { now += ms; }, cdpPortCandidates: () => [9222],
    isWorkBuddyCdpAt: async () => launches > 1 && recovered,
    launchWorkBuddy: () => { launches++; return { exitCode: 3221226505 }; },
    nativeWorkBuddyRunning: () => running, stopNativeWorkBuddy: () => { stops++; },
    nativeWorkBuddyProcessSummary: () => ({}), nativeWorkBuddyDiscoverySummary: () => ({}),
    readWorkBuddyInstallation: () => ({ signature: changed && launches ? 'new' : 'old', ready: true }),
    waitForStableWorkBuddyInstallation: async () => { waits++; if (!stable) { const e = Error('安装文件仍在变化'); e.exitCode = 15; throw e; } },
  };
  vm.runInNewContext(source.slice(source.indexOf('async function waitForWorkBuddyCdpNative('), source.indexOf('async function nativeStartupMain()')), context);
  return { context, run: () => context.waitForWorkBuddyCdpNative('fixture.exe'), counts: () => ({ launches, stops, waits }) };
}

test('installation changed during a failed launch: wait for stability then retry even without surviving processes', async () => {
  const h = harness({ changed: true });
  assert.equal(await h.run(), true);
  assert.deepEqual(h.counts(), { launches: 2, stops: 0, waits: 1 });
});
test('an unexplained crash fails without retry and keeps decimal/hex exit details', async () => {
  const h = harness();
  await assert.rejects(h.run(), error => error.exitCode === 14 && /3221226505.*0xC0000409/.test(error.message));
  assert.deepEqual(h.counts(), { launches: 1, stops: 0, waits: 0 });
});
test('update recovery is bounded to one retry', async () => {
  const h = harness({ changed: true, recovered: false });
  await assert.rejects(h.run(), error => error.exitCode === 14);
  assert.deepEqual(h.counts(), { launches: 2, stops: 0, waits: 1 });
});
test('unstable installation stops recovery without another spawn', async () => {
  const h = harness({ changed: true, stable: false });
  await assert.rejects(h.run(), error => error.exitCode === 15);
  assert.equal(h.counts().launches, 1);
});
test('existing handoff retry still stops only the verified profile process', async () => {
  const h = harness({ running: true });
  assert.equal(await h.run(), true);
  assert.deepEqual(h.counts(), { launches: 2, stops: 1, waits: 0 });
});
test('update recovery reuses a verified CDP endpoint that became ready while waiting', async () => {
  const h = harness({ changed: true, running: true });
  let ready = false;
  h.context.waitForStableWorkBuddyInstallation = async () => { ready = true; };
  h.context.isWorkBuddyCdpAt = async () => ready;
  assert.equal(await h.run(), true);
  assert.equal(h.counts().launches, 1);
  assert.equal(h.counts().stops, 0);
});
test('update recovery does not bypass a privilege or identity failure', async () => {
  const h = harness({ changed: true, running: true });
  h.context.stopNativeWorkBuddy = () => { const e = Error('boundary'); e.exitCode = 11; throw e; };
  await assert.rejects(h.run(), error => error.exitCode === 11);
  assert.equal(h.counts().launches, 1);
});
test('native termination errors retain boundary exit codes; unrelated exceptions remain generic', () => {
  const c = { PROFILE: { id: 'workbuddy-cn' }, runNativeHelper: () => ({ status: 11, stderr: 'fixture' }) };
  vm.runInNewContext(source.slice(source.indexOf('function stopNativeWorkBuddy()'), source.indexOf('function findWorkBuddyNative()')), c);
  assert.throws(() => c.stopNativeWorkBuddy(), error => error.exitCode === 11);
  const { nativeStartupExitCode } = require('../scripts/win-launcher');
  assert.equal(nativeStartupExitCode({ exitCode: 11 }), 11);
  assert.equal(nativeStartupExitCode({ exitCode: 12 }), 12);
  assert.equal(nativeStartupExitCode({ exitCode: 13 }), 13);
  assert.equal(nativeStartupExitCode({ exitCode: 14 }), 14);
  assert.equal(nativeStartupExitCode({ exitCode: 15 }), 15);
  assert.equal(nativeStartupExitCode({ exitCode: 0 }), 4);
  assert.equal(nativeStartupExitCode({ exitCode: 10 }), 4);
  assert.equal(nativeStartupExitCode(Error('unknown')), 4);
  assert.match(source, /finally\(\(\) => process\.exit\(nativeStartupExitCode\(error\)\)\)/);
});

test('installation sampling uses file metadata and waits for a continuous quiet period', async t => {
  const { readWorkBuddyInstallation, waitForStableWorkBuddyInstallation } = require('../scripts/windows-startup-recovery');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-startup-stability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, 'WorkBuddy.exe');
  fs.mkdirSync(path.join(root, 'resources'));
  fs.writeFileSync(binary, 'fixture'); fs.writeFileSync(path.join(root, 'resources', 'app.asar'), 'fixture');
  const before = readWorkBuddyInstallation(binary);
  assert.equal(before.ready, true);
  fs.writeFileSync(path.join(root, 'resources', 'app.asar'), 'changed fixture');
  assert.notEqual(readWorkBuddyInstallation(binary).signature, before.signature);
  fs.unlinkSync(binary);
  assert.equal(readWorkBuddyInstallation(binary).ready, false);
  let now = 0;
  const samples = [{ signature: 'a', ready: true }, { signature: 'b', ready: true }, { signature: 'b', ready: false }];
  await waitForStableWorkBuddyInstallation(binary, 10000, {
    now: () => now, sleep: async ms => { now += ms; },
    read: () => samples.shift() || { signature: 'b', ready: true },
  });
  assert.ok(now >= 6000, 'missing files and later changes must reset the quiet interval');
  now = 0;
  await assert.rejects(waitForStableWorkBuddyInstallation(binary, 4000, {
    now: () => now, sleep: async ms => { now += ms; }, read: () => ({ signature: String(now), ready: true }),
  }), error => error.exitCode === 15);
});
