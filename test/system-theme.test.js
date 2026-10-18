'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const applyStart = source.indexOf('async function applyThemeByCdp(id, options = {})');
const applySource = source.slice(applyStart, source.indexOf('\n/**', applyStart));

function applyContext(overrides = {}) {
  const context = {
    PROFILE: { capabilities: { theme: true } }, cdp: { connected: true },
    readSessionState: () => ({ themeTakeoverEnabled: true }), themeApplyGeneration: 0,
    currentAccount: () => null, getTheme: () => ({ dark: true, colors: {} }),
    LOCAL_THEME_OVERRIDES: [], themeExtrasCss: () => '', themeVarsCss: () => '',
    wallpaperRotation: { status: () => ({ mode: 'manual' }) },
    setTimeout: resolve => resolve(), log() {},
    resolveSystemTheme: async () => 'dark', startSystemThemePolling() {}, stopSystemThemePolling() {},
    lastResolvedSystemTheme: null, readSavedThemeId: () => 'system',
    cdpSend: async () => ({ result: { value: { applied: true, ready: true } } }),
    ...overrides,
  };
  vm.runInNewContext(applySource, context);
  return context;
}

for (const automatic of [false, true]) test('later manual choice cancels a pending system lookup: automatic=' + automatic, async () => {
  let resolve, evaluations = 0;
  const context = applyContext({
    resolveSystemTheme: () => new Promise(done => { resolve = done; }),
    cdpSend: async () => { evaluations++; return { result: { value: { applied: true } } }; },
  });
  const pending = context.applyThemeByCdp('system', { automatic });
  await context.applyThemeByCdp('dark');
  resolve('default');
  const info = await pending;
  assert.equal(info.cancelled, true);
  assert.equal(evaluations, 1, 'the cancelled system choice must not reach the renderer');
  assert.equal(context.lastResolvedSystemTheme, null);
});

test('disabling takeover during a system lookup prevents application', async () => {
  let resolve, takeover = true;
  const context = applyContext({
    readSessionState: () => ({ themeTakeoverEnabled: takeover }),
    resolveSystemTheme: () => new Promise(done => { resolve = done; }),
    cdpSend: async () => { throw new Error('must not apply'); },
  });
  const pending = context.applyThemeByCdp('system');
  takeover = false;
  resolve('dark');
  assert.equal((await pending).cancelled, true);
});

test('failed system application keeps the last successful baseline for retry', async () => {
  const context = applyContext({
    lastResolvedSystemTheme: 'default',
    cdpSend: async () => { throw new Error('synthetic disconnect'); },
    cdpActivatePage: async () => {},
    connectCdp: async () => {},
  });
  await assert.rejects(context.applyThemeByCdp('system'), /synthetic disconnect/);
  assert.equal(context.lastResolvedSystemTheme, 'default');
});

test('a manual selection stops polling before its renderer request completes', async () => {
  let stopped = false, finish;
  const context = applyContext({
    stopSystemThemePolling: () => { stopped = true; },
    cdpSend: () => new Promise(resolve => { finish = resolve; }),
  });
  const pending = context.applyThemeByCdp('dark');
  assert.equal(stopped, true);
  finish({ result: { value: { applied: true } } });
  await pending;
});

function systemContext(overrides = {}) {
  const start = source.indexOf('function execCaptureText(');
  assert.ok(start >= 0, 'system theme helpers are present');
  const context = {
    process: { platform: 'linux' },
    cdp: { connected: true }, readSavedThemeId: () => 'system',
    readSessionState: () => ({ themeTakeoverEnabled: true }),
    setInterval: () => ({ unref() {} }), clearInterval() {},
    cdpSend: async () => ({ result: { value: 'dark' } }),
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, source.indexOf('function readSavedThemeId()', start)), context);
  return context;
}

for (const platform of ['linux', 'darwin', 'win32']) test('OS detection errors fall back to renderer on ' + platform, async () => {
  const context = systemContext({ process: { platform }, execFile: (cmd, args, options, done) => done(new Error('ENOENT')) });
  assert.equal(await context.resolveSystemTheme(), 'dark');
});

test('macOS missing appearance key is light rather than the renderer locked appearance', async () => {
  const context = systemContext({ process: { platform: 'darwin' },
    execFile: (cmd, args, options, done) => done(Object.assign(new Error('missing key'), { code: 1 }), '', 'The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist'),
  });
  assert.equal(await context.resolveSystemTheme(), 'default');
});

for (const [platform, stdout, expected] of [
  ['win32', 'AppsUseLightTheme    REG_DWORD    0x0', 'dark'],
  ['win32', 'AppsUseLightTheme    REG_DWORD    0x1', 'default'],
  ['darwin', 'Dark\n', 'dark'],
  ['linux', "'prefer-dark'\n", 'dark'],
  ['linux', "'prefer-light'\n", 'default'],
]) test('OS preference overrides a locked renderer: ' + platform + ' ' + stdout.trim(), async () => {
  const context = systemContext({ process: { platform },
    execFile: (cmd, args, options, done) => done(null, stdout),
    cdpSend: async () => { throw new Error('must use OS preference'); },
  });
  assert.equal(await context.resolveSystemTheme(), expected);
});

test('Windows falls back from reg.exe to PowerShell before querying the renderer', async () => {
  const commands = [];
  const context = systemContext({ process: { platform: 'win32' },
    execFile: (cmd, args, options, done) => {
      commands.push(cmd);
      if (cmd === 'reg') done(new Error('EPERM'));
      else done(null, '0\r\n');
    },
    cdpSend: async () => { throw new Error('must use PowerShell preference'); },
  });
  assert.equal(await context.resolveSystemTheme(), 'dark');
  assert.deepEqual(commands, ['reg', 'powershell']);
});

test('system mode persists as system and failed manual changes resume following', async () => {
  const start = source.indexOf("  if (req.method === 'POST' && p === '/api/theme-apply') {");
  const end = source.indexOf('\n  // 保存自定义主题', start);
  let saved = 'default', pollingStarted = 0;
  const context = {
    readBody: async req => req.body, PROFILE: { capabilities: {} }, themeApplyGeneration: 0,
    getTheme: id => id === 'dark',
    applyThemeByCdp: async id => {
      if (id === 'dark') throw new Error('synthetic failure');
      return { system: true, resolved: 'dark', applied: true };
    },
    fs: { writeFileSync: (file, data) => { saved = JSON.parse(data).id; } },
    path, DATA_DIR: '/synthetic', readSavedThemeId: () => saved,
    lastResolvedSystemTheme: 'dark',
    startSystemThemePolling: () => { pollingStarted++; },
    json: (res, status, body) => Object.assign(res, { status, body }), log() {},
  };
  const route = vm.runInNewContext('(async function(req, res, p) {' + source.slice(start, end) + '})', context);
  const success = {};
  await route({ method: 'POST', body: { id: 'system' } }, success, '/api/theme-apply');
  assert.equal(success.status, 200);
  assert.equal(saved, 'system');
  assert.equal(success.body.resolved, 'dark');
  const failed = {};
  await route({ method: 'POST', body: { id: 'dark' } }, failed, '/api/theme-apply');
  assert.equal(failed.status, 500);
  assert.equal(saved, 'system');
  assert.equal(context.lastResolvedSystemTheme, null);
  assert.equal(pollingStarted, 1);
  let reject;
  context.applyThemeByCdp = () => new Promise((resolve, fail) => { reject = fail; });
  const stale = route({ method: 'POST', body: { id: 'dark' } }, {}, '/api/theme-apply');
  await Promise.resolve();
  context.themeApplyGeneration++;
  reject(new Error('stale failure'));
  await stale;
  assert.equal(pollingStarted, 1, 'an older failure must not restart polling during a later selection');
});

test('polling serializes slow lookups and retries an unsuccessful application', async () => {
  let tick, resolve, lookups = 0, applications = 0, saved = 'system';
  const context = systemContext({ ...applyContext(), readSavedThemeId: () => saved,
    setInterval: fn => { tick = fn; return { unref() {} }; },
  });
  // Use the real apply function with the real polling closure and baseline.
  vm.runInContext(applySource, context);
  context.resolveSystemTheme = () => { lookups++; return new Promise(done => { resolve = done; }); };
  context.cdpSend = async () => {
    applications++;
    return { result: { value: { applied: applications > 1 } } };
  };
  context.startSystemThemePolling();
  const first = tick();
  await tick();
  assert.equal(lookups, 1, 'intervals must not overlap');
  resolve('dark'); await first;
  const retry = tick(); resolve('dark'); await retry;
  assert.equal(applications, 2, 'failed apply must be retried even if OS preference is unchanged');
  const unchanged = tick(); resolve('dark'); await unchanged;
  assert.equal(applications, 2, 'unchanged successful preference must not reapply');
  const stale = tick(); saved = 'default'; resolve('default'); await stale;
  assert.equal(applications, 2, 'a changed saved mode cancels a pending poll');
});
