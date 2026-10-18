'use strict';
// 客户端调试端口丢失检测（自动更新后重启丢 --remote-debugging-port）单测。
// 切片来源：scripts/daemon.js 内 __wbsClientDebugStateBlockStart/End 标记块。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../scripts/daemon.js'), 'utf8');
const START = '// __wbsClientDebugStateBlockStart';
const END = '// __wbsClientDebugStateBlockEnd';
const block = source.slice(source.indexOf(START), source.indexOf(END));

function harness() {
  const logs = [];
  const context = vm.createContext({
    log: (...args) => { logs.push(args.join(' ')); },
    Date,
    console,
  });
  vm.runInContext(block, context);
  return {
    logs,
    state: () => vm.runInContext('clientDebugState', context),
    update: (input) => vm.runInContext(
      `updateClientDebugState(${JSON.stringify(input)})`, context),
    threshold: vm.runInContext('CLIENT_DEBUG_MISS_THRESHOLD', context),
  };
}

test('阈值常量为 3（约 15 秒，cdpLoop 5 秒一轮）', () => {
  const h = harness();
  assert.equal(h.threshold, 3);
});

test('CDP 已连接时重置计数与标记', () => {
  const h = harness();
  h.update({ cdpConnected: false, clientRunning: true });
  h.update({ cdpConnected: false, clientRunning: true });
  assert.equal(h.state().consecutiveMiss, 2);
  h.update({ cdpConnected: true, clientRunning: true });
  assert.equal(h.state().consecutiveMiss, 0);
  assert.equal(h.state().needsDebugRelaunch, false);
});

test('客户端未运行时重置计数与标记', () => {
  const h = harness();
  h.update({ cdpConnected: false, clientRunning: true });
  h.update({ cdpConnected: false, clientRunning: false });
  assert.equal(h.state().consecutiveMiss, 0);
  assert.equal(h.state().needsDebugRelaunch, false);
});

test('进程在跑但 CDP 不可达：连续命中阈值后标记 needsDebugRelaunch', () => {
  const h = harness();
  h.update({ cdpConnected: false, clientRunning: true });
  assert.equal(h.state().needsDebugRelaunch, false);
  h.update({ cdpConnected: false, clientRunning: true });
  assert.equal(h.state().needsDebugRelaunch, false);
  h.update({ cdpConnected: false, clientRunning: true });
  assert.equal(h.state().needsDebugRelaunch, true);
  assert.ok(h.state().updatedAt > 0);
  assert.ok(h.logs.some((line) => line.includes('调试端口不可达')));
});

test('标记后继续命中不会重复打日志', () => {
  const h = harness();
  for (let i = 0; i < 5; i++) h.update({ cdpConnected: false, clientRunning: true });
  const hits = h.logs.filter((line) => line.includes('调试端口不可达')).length;
  assert.equal(hits, 1);
  assert.equal(h.state().needsDebugRelaunch, true);
});

test('探测失败（未知）时不计数，避免误报', () => {
  const h = harness();
  h.update({ cdpConnected: false, clientRunning: null });
  h.update({ cdpConnected: false, clientRunning: null });
  h.update({ cdpConnected: false, clientRunning: null });
  assert.equal(h.state().consecutiveMiss, 0);
  assert.equal(h.state().needsDebugRelaunch, false);
});

test('恢复后（CDP 连上）标记被清除', () => {
  const h = harness();
  for (let i = 0; i < 3; i++) h.update({ cdpConnected: false, clientRunning: true });
  assert.equal(h.state().needsDebugRelaunch, true);
  h.update({ cdpConnected: true, clientRunning: true });
  assert.equal(h.state().needsDebugRelaunch, false);
  assert.equal(h.state().consecutiveMiss, 0);
});

test('CDP 端口可达但页面不匹配时，不提示重启且清除历史标记', () => {
  const h = harness();
  for (let i = 0; i < 3; i++) h.update({ cdpConnected: false, clientRunning: true });
  assert.equal(h.state().needsDebugRelaunch, true);
  for (let i = 0; i < 5; i++) {
    h.update({ cdpConnected: false, cdpReachable: true, clientRunning: true });
  }
  assert.equal(h.state().consecutiveMiss, 0);
  assert.equal(h.state().needsDebugRelaunch, false);
});

test('一键恢复先走安全退出，再启动带 CDP 的客户端', () => {
  const start = source.indexOf("p === '/api/client/relaunch'");
  assert.ok(start >= 0);
  const route = source.slice(start, start + 1800);
  const stop = route.indexOf('await quitWorkBuddy()');
  const relaunch = route.indexOf('await relaunchWorkBuddy()');
  assert.ok(stop >= 0, '恢复路由必须先退出已运行的客户端');
  assert.ok(relaunch > stop, '恢复路由必须在安全退出后再启动客户端');
  assert.match(route, /json\(res, 202, \{ ok: true, pending: true \}\)/);
  assert.match(route, /const clientRunning = safeClientRunning\(\)/);
  assert.match(route, /if \(clientRunning !== true\)/);
});

test('客户端探测失败不会沿用破坏性操作的“按仍在运行处理”语义', () => {
  const start = source.indexOf('function safeClientRunning()');
  const end = source.indexOf('\n}\n\nasync function cdpLoop', start);
  assert.ok(start >= 0 && end > start);
  const helper = source.slice(start, end);
  assert.match(helper, /result\.error \|\| result\.status === null/);
  assert.match(helper, /return null/);
});
