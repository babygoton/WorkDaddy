'use strict';

// 在任意平台执行 daemon 的真实发现/注入函数；CDP 响应为脱敏 fixture。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PROFILES } = require('../scripts/profiles');
const { classifyTarget, isTargetForProfile, selectPageTarget } = require('../scripts/cdp-targets');
const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const own = { type: 'page', title: 'WorkBuddy',
  url: 'file:///C:/Programs/WorkBuddy/resources/app.asar/renderer/index.html' };
const other = { ...own, url: 'file:///D:/Programs/WorkBuddy/resources/app.asar/renderer/index.html' };
const profile = { ...PROFILES['workbuddy-ai'], customTarget: true,
  appPath: 'C:\\Programs\\WorkBuddy\\WorkBuddy.exe',
  apiHost: 'https://www.workbuddy.cn', targetHints: ['workbuddy'] };

function harness({ targets = [own], unavailable = false, activeProfile = profile } = {}) {
  const evaluations = [];
  const requests = [];
  const cdp = { connected: false, port: null };
  const context = vm.createContext({
    PROFILE: activeProfile, cdp, classifyTarget, isTargetForProfile, selectPageTarget,
    process: { env: { WBSWITCH_PROFILE: 'workbuddy-ai' } },
    IS_LINUX: false, CDP_PORT_HINT: 9233, AbortSignal,
    validCdpPort: (p) => p === 9233, readCdpPortFile: () => 9233,
    writeCdpPortFile: () => {}, cleanupForeignInjectedTargets: async () => {},
    fetch: async (url) => {
      requests.push(url);
      if (unavailable) throw new Error('ECONNREFUSED');
      return { json: async () => url.endsWith('/json/version') ? { Browser: 'WorkBuddy/5.8.3' } : targets };
    },
    WebSocketCtor: class {
      constructor() { throw new Error('No matching target should open a WebSocket'); }
    },
    log: () => {}, Date, lastInjectTs: 0, injectRetryTimer: null,
    buildInjectScript: () => '/* fixture widget */', updateDebug: () => {}, DAEMON_VERSION: 'test',
    setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {},
    cdpSend: async (method, params) => {
      evaluations.push({ method, ...params });
      return { result: { value: { root: true, widget: true, url: cdp.targetUrl } } };
    },
    automationPanelSetInputActive: async () => {}, automationInputActive: false,
    wallpaperRotation: { status: () => ({ mode: 'fixed' }) },
  });
  for (const [start, end] of [
    ['async function findCdpEndpoint()', '\n/**'],
    ['function isWorkBuddyCdpTarget(', '\nasync function cleanupForeignInjectedTargets('],
    ['async function connectCdp()', '\nfunction '],
    ['async function injectWidget(', '\nfunction buildInjectScript()'],
  ]) {
    const begin = source.indexOf(start);
    const finish = source.indexOf(end, begin);
    assert.ok(begin >= 0 && finish > begin, start);
    vm.runInContext(source.slice(begin, finish), context);
  }
  return { context, cdp, evaluations, requests };
}

test('custom target 的发现、页面选择和完整注入使用相同归属规则', async () => {
  const h = harness({ targets: [other, own] });
  assert.equal(await h.context.findCdpEndpoint(), 9233);
  const selected = await h.context.getPageTarget(9233);
  assert.equal(selected.url, own.url);
  Object.assign(h.cdp, { connected: true, targetUrl: selected.url, targetTitle: selected.title });
  const result = await h.context.injectWidget('manual');
  assert.equal(result.mounted, true);
  assert.ok(h.evaluations.some((call) => call.expression === '/* fixture widget */'));
  assert.ok(h.requests.every((url) => url.startsWith('http://127.0.0.1:9233/')));
});

test('同名客户端来自其他目录时，发现和注入均拒绝，且诊断说明目标不匹配', async () => {
  const h = harness({ targets: [other] });
  assert.equal(await h.context.connectCdp(), false);
  assert.equal(h.cdp.endpointReachable, true);
  assert.match(h.cdp.error, /调试端口可达.*匹配/);
  Object.assign(h.cdp, { connected: true, targetUrl: other.url, targetTitle: other.title });
  await assert.rejects(h.context.injectWidget('manual'), /不属于当前 profile/);
  assert.equal(h.evaluations.length, 0, '不得清理或注入兄弟客户端页面');
});

test('普通 AI profile 仍拒绝国内版页面，即使 daemon 已绑定独立端口', async () => {
  const h = harness({ activeProfile: PROFILES['workbuddy-ai'] });
  assert.equal(await h.context.findCdpEndpoint(), null);
  Object.assign(h.cdp, { connected: true, targetUrl: own.url, targetTitle: own.title });
  await assert.rejects(h.context.injectWidget('manual'), /不属于当前 profile/);
  assert.equal(h.evaluations.length, 0);
});

test('真正不可达的端口保留调试模式提示，下一轮扫描清除旧的可达状态', async () => {
  const h = harness({ unavailable: true });
  h.cdp.endpointReachable = true;
  assert.equal(await h.context.connectCdp(), false);
  assert.equal(h.cdp.endpointReachable, false);
  assert.match(h.cdp.error, /未发现 CDP 端口/);
});
