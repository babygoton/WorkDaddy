'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../scripts/daemon.js'), 'utf8');
const manager = source.slice(source.indexOf('const idePages = new Map();'), source.indexOf('async function cdpLoop()'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  let now = 1000, serial = 0;
  const timers = new Map(), sockets = [];
  const target = { id: 'ide', url: 'vscode-file://vscode-app/CodeBuddy/workbench.html', webSocketDebuggerUrl: 'ws://127.0.0.1/fixture' };
  const state = { fail: true, mounted: true, hold: false, injections: 0, reloads: 0, targets: [target] };
  class Socket {
    constructor() { this.readyState = 1; sockets.push(this); }
    send(payload) {
      const msg = JSON.parse(payload);
      if (state.hold) return;
      let result = {};
      if (msg.method === 'Runtime.evaluate') {
        if (msg.params.expression === 'fixture-inject') {
          state.injections++;
          if (state.fail) result = { exceptionDetails: { text: 'fixture failure' } };
        } else result = { result: { value: JSON.stringify({ fab: state.mounted, ready: 'complete' }) } };
      }
      if (msg.method === 'Page.reload') state.reloads++;
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: msg.id, result }) }));
    }
    close() { this.readyState = 3; this.onclose(); }
  }
  const context = vm.createContext({ Map, Set, Promise, JSON, Error, String, Date: { now: () => now },
    setTimeout: (fn, ms) => { timers.set(++serial, { fn, at: now + ms }); return serial; }, clearTimeout: id => timers.delete(id),
    WebSocketCtor: Socket, createRendererApiBridge: () => async () => {}, API_TOKEN: 'fixture', ACTUAL_PORT: 1,
    BINDING: 'fixture', buildInjectScript: () => 'fixture-inject', redactDiagnosticText: s => s, log: () => {},
    PROFILE: { kind: 'codebuddy' }, cdp: { port: 1 }, fetch: async () => ({ json: async () => state.targets }),
    AbortSignal, selectIdeTargets: list => list,
    // 切片范围覆盖了客户端运行状态的刷新块，需要提供 daemon 模块级常量；
    // 常驻 daemon 语义为 false（真实探测子进程见 daemon-status-nonblocking.test.js）
    PROBE_CLIENT_RUNNING: false });
  vm.runInContext(manager, context);
  return { state, sockets, context, timers,
    scan: () => vm.runInContext('ideSyncScan()', context),
    async start() { await this.scan(); sockets[0].onopen(); await tick(); },
    async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await tick(); },
  };
}
test('failed IDE injection retries on the same socket and stops once mounted', async () => {
  const h = harness(); await h.start(); assert.equal(h.state.injections, 1);
  h.state.fail = false; await h.advance(5000); await h.scan(); await tick(); await h.advance(2000);
  assert.equal(h.state.injections, 2);
  for (let i = 0; i < 3; i++) { await h.advance(5000); await h.scan(); }
  assert.equal(h.state.injections, 2); assert.equal(h.sockets.length, 1);
});
test('missing root has bounded retries and navigation opens a new retry budget', async () => {
  const h = harness(); h.state.fail = false; h.state.mounted = false; await h.start();
  for (let i = 0; i < 20; i++) { await h.advance(5000); await h.scan(); await tick(); }
  assert.equal(h.state.injections, 3);
  h.state.mounted = true;
  h.sockets[0].onmessage({ data: JSON.stringify({ method: 'Page.loadEventFired' }) });
  await h.advance(500); await h.advance(2000);
  assert.equal(h.state.injections, 4);
});
test('concurrent scans never start overlapping injections', async () => {
  const h = harness(); h.state.fail = false; await h.start();
  await Promise.all([h.scan(), h.scan(), h.scan()]);
  assert.equal(h.state.injections, 1); await h.advance(2000);
});
test('IDE commands time out and pending commands reject on socket close', async () => {
  const h = harness(); await h.start(); h.state.hold = true;
  vm.runInContext("globalThis.done = false; ideSend(idePages.get('ide'), 'Runtime.evaluate').catch(() => { done = true; });", h.context);
  await h.advance(20000); assert.equal(h.context.done, true);
  vm.runInContext("done = false; globalThis.saved = idePages.get('ide'); ideSend(saved, 'Runtime.evaluate').catch(() => { done = true; });", h.context);
  h.sockets[0].close(); await tick();
  assert.equal(h.context.done, true); assert.equal(h.context.saved.pending.size, 0);
});

test('IDE mount probe accepts the full panel root (.wbs-root), not only the legacy FAB', () => {
  // 1.2.10 起 workbench 与 Agents 共用完整面板：探针若只认旧轻量浮层根
  // （wbs-ide-statusbar-root）将永远"未确认"，日志误报且白白放弃重试预算。
  assert.match(manager, /document\.querySelector\("\.wbs-root"\)/);
});

test('reloadIdeWorkbenchWindows sends Page.reload to every connected IDE window', async () => {
  // 手动同步当前账号后必须刷新 workbench：扩展宿主 indexCache（TTL 5min）
  // 不因外部写 index.json 失效，不 reload 侧边栏就要等缓存过期或重启。
  const h = harness(); h.state.fail = false; await h.start();
  const reloaded = vm.runInContext("reloadIdeWorkbenchWindows('fixture-sync')", h.context);
  await tick();
  assert.equal(reloaded, true); assert.equal(h.state.reloads, 1);
  // reload 后 loadEventFired 流程会复位注入状态并自动补注入（既有行为，不在此重复断言）
});

test('manual copy/migrate handlers reload the IDE workbench for the current account', () => {
  // 静态断言：copy 只在 targetUid=当前账号且 copied>0 时刷新；migrate 迁入/迁出
  // 当前账号都刷新；自动复制路径不得触发 reload（切号 session-change 已清缓存）。
  const copyBlock = source.slice(source.indexOf("p === '/api/sessions/copy'"), source.indexOf("p === '/api/sessions/migrate'"));
  const migrateBlock = source.slice(source.indexOf("p === '/api/sessions/migrate'"), source.indexOf("删除会话（真实删除）"));
  assert.match(copyBlock, /copied > 0 && targetUid === String\(\(currentAccount\(\) \|\| \{\}\)\.uid \|\| ''\)\) \{\s*\n\s*reloadIdeWorkbenchWindows\('sessions-copy'\)/);
  assert.match(migrateBlock, /reloadIdeWorkbenchWindows\('sessions-migrate'\)/);
  // 自动复制（startAutoCopyJob 路径）不得调用 reload
  const autoCopyStart = source.indexOf('function startAutoCopyJob');
  assert.ok(autoCopyStart > 0);
  const autoCopyBlock = source.slice(autoCopyStart, source.indexOf('function publicAutoCopyJob'));
  assert.doesNotMatch(autoCopyBlock, /reloadIdeWorkbenchWindows/);
});
