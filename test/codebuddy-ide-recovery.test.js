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
  const state = { fail: true, mounted: true, hold: false, injections: 0, targets: [target] };
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
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: msg.id, result }) }));
    }
    close() { this.readyState = 3; this.onclose(); }
  }
  const context = vm.createContext({ Map, Set, Promise, JSON, Error, String, Date: { now: () => now },
    setTimeout: (fn, ms) => { timers.set(++serial, { fn, at: now + ms }); return serial; }, clearTimeout: id => timers.delete(id),
    WebSocketCtor: Socket, createRendererApiBridge: () => async () => {}, API_TOKEN: 'fixture', ACTUAL_PORT: 1,
    BINDING: 'fixture', buildInjectScript: () => 'fixture-inject', redactDiagnosticText: s => s, log: () => {},
    PROFILE: { kind: 'codebuddy' }, cdp: { port: 1 }, fetch: async () => ({ json: async () => state.targets }),
    AbortSignal, selectIdeTargets: list => list });
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
