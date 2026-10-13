'use strict';

// 回归锁定：daemon 的 /api/status 不得在请求线程里同步枚举客户端进程。
// 背景：Windows 上 safeClientRunning() 会冷启 PowerShell 做 CIM 进程枚举
// （实测 2.4-6.7s，远超 launcher 的 HTTP 发现预算 1.5s）。温启动场景下
// launcher 发现不到已在监听的 daemon，误选备用 UI 端口并覆写 ui-port.json，
// 最终以「daemon 未绑定当前 UI 端口与当前 profile 状态」失败退出，
// WorkBuddy 永远不会被拉起。
// 平台说明：daemon.js 顶层有副作用（直接启动服务），这里沿用
// session-sync-daemon.test.js 的 vm 切片手法，只执行目标代码段；
// launcher 的 httpGet 行为测试使用本地 HTTP 服务器，跨平台可真实运行。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const daemonSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'daemon.js'), 'utf8');

test('status handler reads the cached client state instead of probing in the request thread', () => {
  const handlerStart = daemonSource.indexOf("if (req.method === 'GET' && p === '/api/status')");
  assert.ok(handlerStart > 0, 'status handler not found in daemon.js');
  const handlerEnd = daemonSource.indexOf('if (authenticated) {', handlerStart);
  assert.ok(handlerEnd > handlerStart, 'authenticated block not found after status handler');
  const handler = daemonSource.slice(handlerStart, handlerEnd);
  assert.doesNotMatch(
    handler,
    /running:\s*safeClientRunning\(\)/,
    'status handler still enumerates processes inline; /api/status stays seconds-slow'
  );
  assert.match(handler, /running:\s*clientRunningState\.value/, 'status handler should read the background-refreshed cache');
});

test('CDP monitor reuses the background client cache instead of probing synchronously', () => {
  const loopStart = daemonSource.indexOf('async function cdpLoop()');
  assert.ok(loopStart > 0, 'cdpLoop not found in daemon.js');
  const loopEnd = daemonSource.indexOf('\nasync function ', loopStart + 20);
  const loop = daemonSource.slice(loopStart, loopEnd > loopStart ? loopEnd : loopStart + 5000);
  assert.doesNotMatch(loop, /clientRunning:\s*safeClientRunning\(\)/,
    'cdpLoop must not synchronously enumerate client processes');
  assert.match(loop, /clientRunning:\s*clientRunningState\.value/,
    'cdpLoop should use the background-refreshed client state');
});

test('client running probe runs in a one-shot subprocess so the daemon event loop stays free', () => {
  assert.match(daemonSource, /--probe-client-running/, 'one-shot probe subprocess mode not found in daemon.js');
  assert.match(daemonSource, /\bexecFile\b/, 'execFile must be imported for the non-blocking refresh');
  assert.match(daemonSource, /execFile\(process\.execPath, \[__filename, '--probe-client-running'\]/, 'refresh must shell out to the one-shot probe');
});

test('macOS probe uses bounded scan and parent timeouts', () => {
  assert.match(daemonSource, /CLIENT_RUNNING_MAC_SCAN_TIMEOUT_MS = 2000/);
  assert.match(daemonSource, /CLIENT_RUNNING_PROBE_TIMEOUT_MS = IS_MAC \? 4000 : 15000/);
  assert.match(daemonSource, /timeout: IS_MAC \? CLIENT_RUNNING_MAC_SCAN_TIMEOUT_MS : 5000/);
  assert.match(daemonSource, /timeout: CLIENT_RUNNING_PROBE_TIMEOUT_MS/);
});

test('one-shot probe subprocess answers without starting the daemon', () => {
  const { execFileSync } = require('node:child_process');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workdaddy-probe-test-'));
  const preload = path.join(temp, 'audit-probe.cjs');
  const audit = path.join(temp, 'probe-spawns.json');
  // 执行真实入口，但拦截递归探测，避免有缺陷的版本在测试中制造进程风暴。
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const originalExecFile = cp.execFile;
    const probes = [];
    cp.execFile = function(bin, args, options, callback) {
      if (args && args.includes('--probe-client-running')) {
        probes.push(args);
        callback(new Error('recursive probe blocked by regression test'));
        return;
      }
      return originalExecFile.apply(this, arguments);
    };
    process.on('exit', () => fs.writeFileSync(${JSON.stringify(audit)}, JSON.stringify(probes)));
  `);
  try {
    for (const profile of ['workbuddy-cn', 'workbuddy-ai', 'codebuddy-cn', 'codebuddy-intl']) {
      const dataDir = path.join(temp, profile);
      const startedAt = Date.now();
      const stdout = execFileSync(
        process.execPath,
        ['--require', preload, path.join(__dirname, '..', 'scripts', 'daemon.js'), '--probe-client-running'],
        { encoding: 'utf8', timeout: 20000, windowsHide: true, env: {
          ...process.env,
          WBSWITCH_PROFILE: profile,
          WBSWITCH_DATA_DIR: dataDir,
          WBSWITCH_AUTH_FILE: path.join(temp, 'absent-auth.json'),
          WORKDADDY_TELEMETRY: '0',
        } }
      );
      const parsed = JSON.parse(stdout);
      assert.ok(parsed.running === true || parsed.running === false || parsed.running === null,
        'probe must answer a boolean or null');
      assert.ok(Date.now() - startedAt < 15000, 'probe should exit without booting the daemon');
      assert.deepEqual(JSON.parse(fs.readFileSync(audit, 'utf8')), [],
        `${profile}: one-shot probe must never spawn another probe`);
      assert.equal(fs.existsSync(path.join(dataDir, '.daemon.lock')), false,
        'probe must not acquire the daemon lock');
      assert.equal(fs.existsSync(path.join(dataDir, 'ui-port.json')), false,
        'probe must not start the HTTP service');
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('client running cache refreshes in the background and survives probe failures', async () => {
  const anchor = daemonSource.indexOf('const clientRunningState = {');
  assert.ok(anchor > 0, 'client running cache block not found in daemon.js');
  const end = daemonSource.indexOf('async function cdpLoop', anchor);
  assert.ok(end > anchor, 'cache block end anchor not found');
  const block = daemonSource.slice(anchor, end);

  let probeCalls = 0;
  let probeShouldFail = false;
  let probeResult = true;
  let refreshTimer;
  const ctx = {
    // mock execFile：模拟一次性子进程探测，异步回调
    execFile: (bin, args, options, callback) => {
      probeCalls += 1;
      setImmediate(() => {
        if (probeShouldFail) callback(new Error('probe failed'));
        else callback(null, JSON.stringify({ running: probeResult }));
      });
    },
    process: { execPath: process.execPath },
    __filename: 'daemon.js',
    Date,
    setInterval: (callback, delay) => {
      assert.equal(delay, 5000);
      refreshTimer = callback;
      return { unref() {} };
    },
    console,
    IS_MAC: false,
    PROBE_CLIENT_RUNNING: false,
  };
  vm.runInNewContext(block, ctx);

  assert.equal(probeCalls, 0, 'defining the cache must not spawn a probe before the startup gate');
  assert.equal(refreshTimer, undefined, 'defining the cache must not start a timer');
  ctx.startClientRunningMonitor();
  // 启动时立即刷新一次（fire-and-forget），缓存随后就位
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(probeCalls, 1, 'cache should refresh once at startup');
  assert.equal(await ctx.refreshClientRunning(), true, 'cache should hold the probe result');
  assert.equal(probeCalls, 2);

  // 后台可重复刷新，缓存值随探测更新
  probeResult = false;
  assert.equal(await ctx.refreshClientRunning(), false);
  assert.equal(probeCalls, 3);

  // 探测失败时保留上一次已知值，绝不让状态接口因探测失败而失败
  probeShouldFail = true;
  assert.equal(await ctx.refreshClientRunning(), false, 'failed probe must preserve the last known value');
  assert.equal(probeCalls, 4);

  // 定时刷新必须保留；避免修复递归时意外停掉正常 daemon 的后台状态更新。
  probeShouldFail = false;
  probeResult = true;
  refreshTimer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probeCalls, 5);
  assert.equal(vm.runInNewContext('clientRunningState.value', ctx), true);
});

test('probe subprocess never starts another probe', async () => {
  const anchor = daemonSource.indexOf('const clientRunningState = {');
  assert.ok(anchor > 0, 'client running cache block not found');
  const end = daemonSource.indexOf('async function cdpLoop', anchor);
  assert.ok(end > anchor, 'cache block end anchor not found');
  const block = daemonSource.slice(anchor, end);
  let probeCalls = 0;
  const ctx = {
    execFile: () => { probeCalls += 1; },
    process: { execPath: process.execPath },
    __filename: 'daemon.js',
    Date,
    setInterval: () => ({ unref() {} }),
    console,
    IS_MAC: false,
    PROBE_CLIENT_RUNNING: true,
  };
  vm.runInNewContext(block, ctx);
  assert.equal(await ctx.refreshClientRunning(), null);
  assert.equal(probeCalls, 0);
});

test('only the daemon holding the instance lock starts the client monitor', () => {
  const start = daemonSource.indexOf('\nensureDirs(DATA_DIR, log);');
  const end = daemonSource.indexOf('\nconst sessionBackupCleanup =', start);
  assert.ok(start > 0 && end > start, 'daemon startup gate not found');
  const block = daemonSource.slice(start, end);
  const exit = new Error('process exited');
  let monitorStarts = 0;
  let ownsLock = false;
  const ctx = {
    DATA_DIR: 'fixture', log() {}, ensureDirs() {},
    acquireDaemonLock: () => ownsLock,
    startClientRunningMonitor: () => { monitorStarts += 1; },
    process: { exit: (code) => { assert.equal(code, 0); throw exit; } },
  };
  assert.throws(() => vm.runInNewContext(block, ctx), (error) => error === exit);
  assert.equal(monitorStarts, 0, 'rejected duplicate daemon must not leave a probe chain');
  ownsLock = true;
  vm.runInNewContext(block, ctx);
  assert.equal(monitorStarts, 1, 'the owning daemon must start the monitor once');
});

test('daemon behavior change ships a version and build bump so stale daemons are replaced', () => {
  const version = daemonSource.match(/const DAEMON_VERSION = '([^']+)'/);
  const buildId = daemonSource.match(/const DAEMON_BUILD_ID = '([^']+)'/);
  assert.ok(version && buildId, 'DAEMON_VERSION/DAEMON_BUILD_ID not found');
  assert.notEqual(version[1], '1.2.35', 'DAEMON_VERSION must change so launchers replace the affected daemon');
  assert.ok(buildId[1].startsWith(`release-${version[1]}-`), 'DAEMON_BUILD_ID must match the daemon version');
  assert.notEqual(buildId[1], 'release-1.2.35-20261012-panel-token-daily-limit');
});

test('launcher httpGet uses a budget aligned with the daemon probe cost', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'win-launcher.js'), 'utf8');
  const start = src.indexOf('function httpGet(');
  assert.ok(start > 0, 'httpGet not found in win-launcher.js');
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  assert.doesNotMatch(body, /timeout:\s*1500\b/, 'httpGet still uses the 1500ms budget that cannot see a slow daemon');
  assert.match(body, /timeout:\s*HTTP_GET_TIMEOUT_MS\b/, 'httpGet should use the shared HTTP_GET_TIMEOUT_MS budget');
});

test('launcher httpGet tolerates a daemon slower than the old 1500ms budget', async () => {
  const launcher = require('../scripts/win-launcher.js');
  assert.equal(typeof launcher.httpGet, 'function', 'httpGet must be exported for the discovery path');

  // 2500ms：旧预算（1500ms）必然放弃，新预算（8000ms）必须等到响应
  const server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, slow: true }));
    }, 2500);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const startedAt = Date.now();
    const response = await launcher.httpGet(port, '/api/status', {});
    assert.ok(response, 'httpGet must not give up on a 2.5s daemon response');
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true, slow: true });
    assert.ok(Date.now() - startedAt >= 2400, 'response should have been awaited, not failed fast');
  } finally {
    server.close();
  }
});
